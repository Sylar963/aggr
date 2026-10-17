# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

aggr is a Vue 2 + Vuex single-page app that streams live trades from many exchanges over their public WebSocket APIs. It aggregates them in a Web Worker and renders charts, trade lists, stats and alerts. Historical bars come from a separate [aggr-server](https://github.com/Tucsky/aggr-server).

This checkout is a fork (`Sylar963/aggr`). Open PRs against the fork, never upstream `Tucsky/aggr`, which `gh` picks by default. Don't add attribution footers to commits or PRs: no `Co-Authored-By: Claude` trailer and no "Generated with Claude Code" line. Fork-specific additions: TradFi/RWA market aggregation, the Lighter exchange, server-side workspace sharing, and a bundled indicator library.

## Commands

- `npm run serve`: Vite dev server on :8080. Run it with `npm run cors` (local CORS proxy on :8070, used as `VITE_APP_PROXY_URL` in dev).
- `npm run build`: production build to `dist/`. Terser drops `console.*`.
- `npm run prod`: `vue-tsc --noEmit`, then build to `dist/` (via `temp/`).
- `npm run lint` / `npm run lint:fix`: ESLint with Prettier rules (no semicolons, single quotes, 80 cols, no trailing commas, `arrowParens: avoid`).
- `npm run serve:dist`: runs `dist-server/index.mjs`, an Express server that serves `dist/` plus the workspace-sharing API (`/api/workspaces`).
- `npm run svg2font`: regenerates the icon font and `src/assets/sass/icons.scss` from `src/assets/svg/*.svg`. Run it after you add an exchange icon.
- `node scripts/tradfi-pairs.mjs [--config <aggr-server config.json>]`: lists the TradFi perps the app detects, so an aggr-server can record them.

There is no test suite. Verify changes by building and running the app.

Volta pins Node 20.2. On newer Node versions, `vite` dev (vite-plugin-monaco-editor calls the removed `fs.rmdirSync(..., {recursive})`) and `vue-tsc` both crash. In that case:
- Type-check with `npx tsc --noEmit -p .`. Many errors already exist, so check only the files you touched.
- Run a build with `npx vite build --mode development --minify false --outDir <relative dir>` and serve it statically. Use a relative `--outDir`: an absolute one makes the monaco plugin leave a stray `tmp/` in the repo.
- Production builds fetch products through the `cors.aggr.trade` allowlist proxy, while the dev proxy forwards everything. Test new product endpoints with a production-mode build.

## Configuration

`.env`, `.env.production` and `.env.github` (mode `github`, for GitHub Pages) set `VITE_APP_*` vars, which `vite.config.js` exposes as `process.env.*`:
- `VITE_APP_API_URL`: aggr-server for crypto history.
- `VITE_APP_EXTRA_API_URLS`: extra history servers, used here for TradFi markets.
- `VITE_APP_PROXY_URL`: CORS proxy prefix for REST product requests.
- `VITE_APP_LIB_URL`: community indicator library backend.
- `VITE_APP_WORKSPACES_API_URL`: workspace-sharing API.

The list of enabled exchange IDs is hard-coded in `vite.config.js` (`VITE_APP_EXCHANGES`). Add new exchanges there too.

## Architecture

### Data path: exchanges → worker → UI
- `src/worker/` runs in a dedicated Web Worker (`worker/index.ts`). `worker.ts` turns each incoming `{op, data, trackingId}` message into a call to the method of the same name on the `Aggregator` (`worker/aggregator.ts`). The aggregator posts `{op, data}` messages back (`trades`, `tickers`, `subscribed`, `error`, …).
- `src/services/aggregatorService.ts` is the main-thread side. It re-emits worker messages as EventEmitter events named after `op`, and `dispatch`/`dispatchAsync` send ops to the worker. Components and the chart listen to these events and don't talk to the worker directly.
- The aggregator groups trades by timestamp, market and side within `aggregationLength` and batches them to the UI. It also keeps per-market tickers and volume buckets.
- `src/worker/exchange.ts` is the base class for every connector in `src/worker/exchanges/`. It handles WebSocket pooling (`maxConnectionsPerApi`), subscribe/unsubscribe, reconnects, keepalive and product fetching/caching. A connector implements `getUrl`, `formatProducts`, `subscribe`/`unsubscribe` and `onMessage`, and calls `emitTrades`/`emitLiquidations`. Register it in `src/worker/exchanges/index.ts`. The full checklist is in `docs/ADDING_NEW_EXCHANGE.md`.
- Markets are identified as `EXCHANGE:pair` (for example `BINANCE_FUTURES:btcusdt`). `src/services/productsService.ts` parses raw pairs into base, quote and type (spot/perp/future), normalizes stablecoin quotes so markets group across exchanges, and stores products in IndexedDB with an expiry.

### State, workspaces, panes
- Vuex modules: `app`, `settings`, `exchanges` and `panes` are core. Every pane also gets its own dynamically registered module, keyed by pane ID. Its type comes from `src/store/panesSettings/` (chart, trades, trades-lite, stats, prices, counters, website, alerts). `boot()` in `src/store/index.ts` sets them up in order.
- Persistence: any module with an `_id` is saved to IndexedDB (database `aggr`) 500 ms after each mutation (`scheduleSync` in `src/utils/store.ts`). On boot it is merged back with `mergeStoredState`. A workspace is the set of these module states. `src/services/workspacesService.ts` owns the database (workspaces, products, indicators, presets, sounds) and the sharing API client. Schema and workspace upgrades go in `src/services/migrations.ts`.
- The layout uses vue-grid-layout (`components/panes/Panes.vue`). Pane components live in `src/components/<type>/`.

### Chart and indicators
- `src/components/chart/chart.ts` (`Chart`) wraps a forked lightweight-charts (git dependency, `Tucsky/lightweight-charts`). It builds bars from live trades and from history (`historicalService.ts`).
- Indicators are user scripts in a Pine-like DSL. `buildUtils.ts` compiles them to JS by rewriting the source with regexes: options become `options.x`, `name =` lines become persistent bar variables, `x[1]` becomes bar-history access, and `source(...)` sets market filters. `serieUtils.ts` provides the built-in functions (sma, ema, …). The rewriting is text-based, so options named in strings, spaces in `source(a = b)`, and `var f = function` all break silently. Read `buildUtils.ts` before you write or port an indicator.
- Built-in default indicators are in `src/store/defaultIndicators.json`. Indicators bundled with this fork are in `public/library/indicators.json` plus `public/library/indicators/custom/<id>.json` and `.png`, loaded by `components/library/helpers.ts`.

### TradFi / RWA
`src/utils/tradfi.ts` decides which markets are TradFi: exchange flags (Binance contractType, Bybit symbolType, OKX instCategory, Bitget isRwa), Hyperliquid HIP-3 dexes, and, for Aster and Lighter, name+price matching against those flags. It also holds the base aliases that merge one asset across exchanges (for example `xyz:GOLD`, `XAUUSDT` → `XAUUSD`). Add an alias only after you check that every exchange quotes the asset at the same price scale (SPX is the SPX6900 memecoin on most exchanges). TradFi history comes from a self-hosted aggr-server through `VITE_APP_EXTRA_API_URLS`. Crypto history stays on `VITE_APP_API_URL`.

### Deployment
`deploy/` installs the app as a systemd service (`dist-server`) behind Caddy (`deploy/aggr.caddy`, `deploy/install.sh`). `dist-server` serves `dist/` with `express.static`, so swapping in a new `dist/` deploys without a restart. Built asset names use a constant hash (`5c4cb14`, see `vite.config.js`). Docker files are in `docker/`, and `scripts/gh-pages-deploy.mjs` deploys to GitHub Pages.
