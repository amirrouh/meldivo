# Contributing to pi-meldivo

## Layout

- `extensions/meldivo.ts` — the Pi extension. Registers `/meldivo`, starts the
  local server on demand, and relays turns between the Pi session and the
  server's adapter API.
- `server/src/` — the local Express server (speech, rooms, static hosting).
  Compiles to `dist/server/`.
- `web/src/` — the browser voice UI (React + Vite). Builds to `dist/web/`.
- `tests/` — Node test-runner (`.test.mjs`) integration tests.

## Build & test

```bash
npm install
npm run build      # type-checks and builds server + web into dist/
npm test           # build, then run tests/*.test.mjs
npm run dev:server # server in watch mode
npm run dev:web    # web UI in watch mode (vite dev server on :5190)
```

Node 22+ is required (`engines.node`). There is a single root `package.json`;
`server/` and `web/` are plain source directories, not workspaces.

## Style

Strict TypeScript, native ES modules, two-space indentation. `camelCase` for
functions/variables, `PascalCase` for React components/types. No formatter or
linter is configured; `npm run build` is the required type-check. Avoid
unrelated churn in a diff.

## Contract between the extension and the server

The extension spawns `dist/server/index.js` as `node <path>` when
`GET /api/health` isn't reachable, passing `MELDIVO_SECRET` in its
environment. It then creates a room with `POST /api/rooms`
(`x-meldivo-secret` header) and polls `/api/rooms/:id/adapter/next` for
voice-originated turns, delivering assistant replies to
`/api/rooms/:id/adapter/events`. Keep this contract in mind when changing
either side.
