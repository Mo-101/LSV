# Unified execution

The backend owns execution mode, sizing, filters, reservations, and order lifecycle. The browser sends configuration changes and renders exchange snapshots. It never manufactures a Binance fill.

## Modes and controls

- Signals only: no new entries.
- Real-tape shadow (`PAPER`): mainnet aggregate trade volume drives a separate estimated-fill model. No exchange orders are submitted.
- Binance demo (`LIVE` is the legacy internal enum): signed orders go only to `testnet.binancefuture.com`. This enum never selects mainnet execution.
- Automatic entries must also be enabled. Manual demo entries bypass the liquidation trigger, but respect mode, halt, symbol filters, slot limits, balance, and risk budget.
- Defaults on a fresh state directory: signals only, automatic entries off, $10 tier, $5 margin per slot, two slots, 10x leverage.
- The $250 tier uses $25 margin per slot and three slots; the $250k tier uses $25k margin per slot and three slots. The exchange may reject an unaffordable tier. No automatic tier escalation or upward rounding to a minimum order size occurs.

`GET /api/config` returns the current settings and revision. `POST /api/config` accepts `{ "revision": 0, "patch": { "mode": "PAPER" } }`. Validation rejects unknown fields, invalid ranges, allocations above the pool, and stale revisions. Writes are atomic and durable before a success response. Existing trades retain their original entry and holding deadlines when configuration changes. Mode changes gate new entries; they do not abandon existing exposure. Halt requests persist before managed orders are canceled/closed. A halt is not proof that the exchange account is flat.

Active automatic-entry filters are liquidation USD within the rolling 30-second window, long-liquidation direction, symbol allowlist, and sufficient resting bid depth for the configured absorption multiplier. The legacy CVI, deceleration, OI, and stress-test displays are not backend execution filters. Their old synthetic fleet execution loop has been removed. The architect sandbox remains a separate demonstration.

## Exchange source of truth

`GET /api/testnet/status` returns the coordinator's periodically refreshed snapshot from signed `/fapi/v1/openOrders`, `/fapi/v2/positionRisk`, and `/fapi/v2/account` reads. The browser never receives API secrets. All actual exposure is shown, including orders created outside this process. Pending entry orders appear as pending, positions as open, and attached reduce-only orders do not create duplicate position cards. Data older than 20 seconds, or a failed refresh, is stale; retained rows do not imply current state. The UI says unknown, not zero, when the exchange cannot be read.

API field semantics follow [Binance USD-M Futures trade documentation](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/trade).

## Recovery and verified exits

The coordinator serializes entry requests, config writes and reconciliation. Before submission it records a unique `lsv-entry-*` client order ID and reservation. Exchange minimum quantities, notional and precision are checked; leverage and isolated margin are explicitly requested. A timeout, including Binance -1006/-1007, preserves the intent and blocks fresh entries until resolved.

On restart, persisted entries are reconciled against the exchange. Tagged open entry orders can be recovered even if acceptance was not written. Full and partial positions count as exposure; a partial entry remainder is canceled before protecting the actual position quantity. A reduce-only take-profit is submitted after fill detection. The polling watchdog checks every five seconds; it is not a hard real-time 90-second guarantee.

At an expired entry deadline the entry is canceled. At the holding deadline, or on halt, managed resting orders are canceled and the actual remaining position is closed reduce-only. The journal is removed only after a new exchange snapshot confirms no position and no managed orders. Rejected or uncertain cancels/closes remain tracked and visible. Definitive failures can be retried on later reconciliation; ambiguous market-order outcomes are looked up by client ID rather than blindly resubmitted.

Unknown legacy/external exposure is visible as unmanaged and blocks new demo entries on that symbol; other symbols keep their isolated slots. The explicit **Adopt and enforce time-stop** control takes ownership of a symbol's one-way long exposure. Old deadlines can lead to immediate cancellation/closure. Hedge-mode and short exposure require manual reconciliation in Binance; the app does not silently change position mode. Unrecognized orders sharing a managed symbol stop automatic management and require review. The account should not be shared with another strategy trading the same symbol, because net positions cannot establish ownership of each unit.

If an ambiguous submission remains absent from Binance, the app keeps its reservation and displays a reconciliation error. It deliberately does not infer rejection from a transient missing response. Resolve that case against Binance order history before repairing the journal while the server is stopped.

## Real-tape shadow execution

`POST /api/shadow/arm` with `{ "symbol": "SOLUSDT" }` arms a manual shadow order at an observed mainnet bid. The automatic path uses the mainnet absorption floor. Each order subscribes to mainnet `aggTrade`; no random volume or prices are used.

For long entries, only seller-initiated trades at or below the entry contribute to a conservative USD queue hurdle plus the intended notional. Duplicate trade IDs are ignored; sequence gaps invalidate the run. A modeled filled order reaches its target only on observed buyer-initiated trades at/above that price with enough quantity. Time-stop exits use a fresh observed bid. Gross results exclude fees and slippage and are labeled estimated. Public prints cannot prove exact queue priority or a counterfactual exchange fill.

Feed disconnects, process restarts with active shadow orders, or unavailable exit quotes mark those runs INCOMPLETE, excluded from performance. This first implementation does not replay missed tape. The new journal is separate from `shadow_trading_log.csv`, which remains a clearly labeled legacy synthetic archive. No new synthetic results are appended by the React dashboard.

Mainnet and testnet have separate order books. Automatic demo orders use a floor derived from the testnet book at detection time — testnet depth is thin, so when the visible book cannot hold the full absorption cushion the entry rests at the deepest visible bid. The shadow model and alerts still use the mainnet book. The manual demo path uses the demo best bid; it tests order wiring without simulating counterparties or manipulating liquidity.

## Persistence and deployment

State files live in `.lsv-state/`, or `LSV_STATE_DIR` if set:

- `config.json`: backend configuration.
- `execution.json`: durable execution intents, ownership, deadlines and errors.
- `shadow-tape.json`: separate real-tape modeled history.
- `writer.lock`: one writer per state directory.

The directory is git-ignored; Docker Compose mounts a named persistent volume. Run one backend worker per state directory. Do not delete state to clear an error while orders may exist. Back up state together with deployment changes. Watchdogs resume after restart but cannot execute while the server or exchange is unavailable; this is not exchange-hosted contingent protection.

The build does not activate demo trading or modify existing exchange orders. On deployment, inspect the slots first, resolve/adopt legacy exposure, choose a mode/tier/filter set, then enable automatic entries if desired.

## Validation

Run `npm run lint`, `npm test`, and `npm run build`. Regression tests mock the exchange and cover configuration persistence and stale revisions, mode and filter gates, concurrent entries, partial fills, failed and unconfirmed exits, restart deadlines, unmanaged/tagged orphan handling, network ambiguity, stale snapshots, and real-tape volume rules. Browser smoke testing uses an isolated state directory, disabled workers, empty credentials, and mocked exchange rows. `LSV_DISABLE_WORKERS=1` is for that isolated testing only.
