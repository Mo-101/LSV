# Execution

The backend owns execution mode, sizing, filters and the shadow order lifecycle. The browser sends configuration changes and renders backend state. The real-tape shadow engine is the only strategy: it decides every entry and exit. The optional Binance demo mirror copies those decisions onto a Binance demo/testnet account and never decides a trade itself. Mainnet execution is not supported.

## Modes and controls

- Signals only (`SIGNAL_ONLY`): no new entries.
- Real-tape shadow (`PAPER`): mainnet aggregate trade volume drives a separate estimated-fill model.
- Mirror to Binance demo (`mirrorToDemo`): each new shadow entry is also placed on the demo account. Needs `BINANCE_KEY` and `BINANCE_SECRET`; off by default.
- Automatic entries must also be enabled for liquidation-triggered shadow entries. Manual shadow arms respect mode, halt, symbol filters and slot limits. Both are mirrored.
- Defaults on a fresh state directory: signals only, automatic entries off, mirror off, $10 tier, $5 margin per slot, two slots, 10x leverage.
- A saved `config.json` from the retired `LIVE` mode loads as signals only.

`GET /api/config` returns the current settings and revision. `POST /api/config` accepts `{ "revision": 0, "patch": { "mode": "PAPER" } }`. Validation rejects unknown fields, invalid ranges, allocations above the pool, and stale revisions. Writes are atomic and durable before a success response. `POST /api/execution/halt` persists the halt, cancels armed shadow orders, closes filled ones at the observed bid, then runs the demo mirror so the demo side follows.

Active automatic-entry filters are liquidation USD within the rolling 30-second window, long-liquidation direction, symbol allowlist, and sufficient resting bid depth for the configured absorption multiplier. The legacy CVI, deceleration, OI, and stress-test displays are not backend execution filters. The architect sandbox remains a separate demonstration.

## Real-tape shadow execution

`POST /api/shadow/arm` with `{ "symbol": "SOLUSDT" }` arms a manual shadow order at an observed mainnet bid. The automatic path uses the mainnet absorption floor. Each order subscribes to mainnet `aggTrade`; no random volume or prices are used.

For long entries, only seller-initiated trades at or below the entry contribute to a conservative USD queue hurdle plus the intended notional. Duplicate trade IDs are ignored; sequence gaps invalidate the run. A modeled filled order reaches its target only on observed buyer-initiated trades at/above that price with enough quantity. Time-stop exits use a fresh observed bid. Gross results exclude fees and slippage and are labeled estimated. Public prints cannot prove exact queue priority or a counterfactual exchange fill.

Feed disconnects, process restarts with active shadow orders, or unavailable exit quotes mark those runs INCOMPLETE, excluded from performance. This implementation does not replay missed tape. The journal is separate from `shadow_trading_log.csv`, which remains a clearly labeled legacy synthetic archive. No new synthetic results are appended by the React dashboard.

## Binance demo mirror

The demo account follows each shadow order through its lifecycle:

| Shadow event | Demo action |
| --- | --- |
| Order armed | Isolated margin and configured leverage are set, then a post-only BUY limit is placed at the same size and the same depth below the demo best bid as the shadow floor sits below the mainnet best bid. |
| Demo entry filled | Reduce-only SELL limit at the demo fill price plus the shadow take-profit percentage. |
| Shadow CANCELED / TP / TIME_STOP / INCOMPLETE | Resting demo entry and TP are canceled; any remaining demo position from this mirror is closed with a reduce-only market order. |

The demo exchange has its own order book, so price is transferred as depth, not as an absolute mainnet price. Demo fills are decided by the demo book: a shadow order can fill while the demo order does not, and the reverse. Exits follow the shadow's timing. Both results are shown side by side; the demo figure is realized P&L before fees.

`GET /api/demo/status` returns `configured`, `enabled`, the demo balance and the mirror records. The mirror reconciles every five seconds after the shadow tick, by client order ID (`lsv…-e`, `-tp`, `-c1`). A definitive Binance rejection (for example below minimum notional) marks the mirror FAILED with nothing on the exchange; the size is never rounded up. A timeout or 5xx is ambiguous: the entry is looked up by client ID for 60 seconds before it is marked FAILED, and it is canceled by client ID in case it lands late. While a symbol's previous mirror is still open, a new shadow entry on that symbol is not mirrored. Closes are bounded by both the mirror's filled quantity and the actual demo position, so they cannot flip the account short. Use a demo account that no other strategy trades on the same symbols.

## Persistence and deployment

State files live in `.lsv-state/`, or `LSV_STATE_DIR` if set:

- `config.json`: backend configuration.
- `shadow-tape.json`: real-tape modeled history.
- `demo-mirror.json`: demo order IDs and states for each mirrored shadow order.
- `writer.lock`: one writer per state directory.

After a restart, active shadow orders become INCOMPLETE, and their demo mirrors are then closed from `demo-mirror.json`. An `execution.json` left by the old testnet coordinator is not read and can be archived. The directory is git-ignored; Docker Compose mounts a named persistent volume. Run one backend worker per state directory.

## Validation

Run `npm run lint`, `npm test`, and `npm run build`. Regression tests cover configuration persistence and stale revisions, the legacy mode migration, real-tape volume rules, and the demo mirror against a mocked exchange (depth-matched entry, TP placement, cancel and close on each shadow exit, rejection versus ambiguous placement, restart). `LSV_DISABLE_WORKERS=1` disables the feeds, shadow watchdog and mirror reconciliation for isolated testing only.
