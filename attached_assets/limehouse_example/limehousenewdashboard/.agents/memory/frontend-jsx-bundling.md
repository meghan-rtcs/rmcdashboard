---
name: Frontend JSX is compiled server-side, not in the browser
description: How the dashboard frontend is built/served and why; what to touch when editing components
---

The frontend is authored as in-browser JSX (`.jsx` under `Limehouse Revamp/`) but is **compiled server-side once and cached in memory**, then served as a single bundle at `GET /app-bundle.js` (see `server/lib/bundle.js`). The HTML loads **production** React UMD builds and fetches data (`/api/dashboard`) + the bundle in parallel — it no longer ships `@babel/standalone` or compiles JSX in the browser.

**Why:** The old bootstrap shipped ~3MB of Babel and Babel-compiled 4 JSX files sequentially on every page load — the dominant cause of slow first paint (the API itself is fast). Server-side compile-once removed that entirely.

**How to apply:**
- The `.jsx` files remain the source of truth. Each is wrapped in an IIFE in the bundle so top-level `const useState = …` declarations don't collide across files — keep that wrapping if you change the bundler.
- The bundle is cached for the process lifetime. JSX edits only take effect after a **server restart** (acceptable: JSX changes arrive with deploy/restart). If you ever need hot reload in dev, add a cache-bust/recompile path.
- The compile order matters (tweaks-panel → shared → var-a → app-a); the app expects `window.LIMEHOUSE_DATA`/`LIMEHOUSE_DRILLDOWNS`/`LIMEHOUSE_SYNC`/`LIMEHOUSE_LS_KPIS`/`LIMEHOUSE_LS_SUMMARY` to be set before the bundle script runs.
