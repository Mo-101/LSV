# Execution

The backend owns execution mode, sizing, filters and the shadow order lifecycle. The browser sends configuration changes and renders backend state. No exchange orders are submitted: there is no Binance testnet or mainnet execution in this build. `BINANCE_KEY` and `BINANCE_SECRET` in `.env.example` are kept only so testnet credentials are ready if exchange execution is reconnected later; nothing reads them today.

## Modes and controls

- Signals only (`SIGNAL_ONLY`): no new entries.
- Real-tape shadow (`PAPER`): mainnet aggregate trade volume drives a separate estimated-fill model.
- Automatic entries must also be enabled for liquidation-triggered shadow entries. Manual shadow arms respect mode, halt, symbol filters and slot limits.
- Defaults on a fresh state directory: signals only, automatic entries off, $10 tier, $5 margin per slot, two slots, 10x leverage.
- A saved `config.json` from the removed Binance demo mode (`LIVE`) loads as signals only.

`GET /api/config` returns the current settings and revision. `POST /api/config` accepts `{ "revision": 0, "patch": { "mode": "PAPER" } }`. Validation rejects unknown fields, invalid ranges, allocations above the pool, and stale revisions. Writes are atomic and durable before a success response. `POST /api/execution/halt` persists the halt, then cancels armed shadow orders and closes filled ones at the observed bid.

Active automatic-entry filters are liquidation USD within the rolling 30-second window, long-liquidation direction, symbol allowlist, and sufficient resting bid depth for the configured absorption multiplier. The legacy CVI, deceleration, OI, and stress-test displays are not backend execution filters. The architect sandbox remains a separate demonstration.

## Real-tape shadow execution

`POST /api/shadow/arm` with `{ "symbol": "SOLUSDT" }` arms a manual shadow order at an observed mainnet bid. The automatic path uses the mainnet absorption floor. Each order subscribes to mainnet `aggTrade`; no random volume or prices are used.

For long entries, only seller-initiated trades at or below the entry contribute to a conservative USD queue hurdle plus the intended notional. Duplicate trade IDs are ignored; sequence gaps invalidate the run. A modeled filled order reaches its target only on observed buyer-initiated trades at/above that price with enough quantity. Time-stop exits use a fresh observed bid. Gross results exclude fees and slippage and are labeled estimated. Public prints cannot prove exact queue priority or a counterfactual exchange fill.

Feed disconnects, process restarts with active shadow orders, or unavailable exit quotes mark those runs INCOMPLETE, excluded from performance. This implementation does not replay missed tape. The journal is separate from `shadow_trading_log.csv`, which remains a clearly labeled legacy synthetic archive. No new synthetic results are appended by the React dashboard.

## Persistence and deployment

State files live in `.lsv-state/`, or `LSV_STATE_DIR` if set:

- `config.json`: backend configuration.
- `shadow-tape.json`: real-tape modeled history.
- `writer.lock`: one writer per state directory.

`execution.json` and `demo-mirror.json` files left by earlier builds are no longer read and can be archived. The directory is git-ignored; Docker Compose mounts a named persistent volume. Run one backend worker per state directory.

## Validation

Run `npm run lint`, `npm test`, and `npm run build`. Regression tests cover configuration persistence and stale revisions, the legacy mode migration, and real-tape volume rules. `LSV_DISABLE_WORKERS=1` disables the feeds and shadow watchdog for isolated testing only.
