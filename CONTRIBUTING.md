# Contributing to meldivo

## Privacy first

meldivo can read and drive your coding-agent sessions, so privacy comes before every other concern:

- Never commit or publish secrets, tokens, real IP addresses, hostnames, domains, personal paths, emails,
  or real session content. Use placeholders such as `voice.example.com` and `<vpn-ip>`; test fixtures
  must be synthetic.
- Review `git diff --cached` and `npm pack --dry-run` before every commit and release.
- Keep the access gate strict: nothing, including the page itself, is served without the secret, the server
  listens on `127.0.0.1` by default, and the secret must never be logged or cached by shared proxies.
- Never add telemetry or any network call other than downloading the speech models.

## Layout

- `bin/meldivo.mjs` — the CLI entry point (`meldivo start|stop|status|open|
  remote|logs|uninstall|--version`). Installs and manages the user service
  (systemd `--user` on Linux, launchd on macOS) and talks to the running
  server over HTTP.
- `server/src/index.ts` — the Express server: HTTP/HTTPS listeners, hub API,
  static hosting for the built web UI, and process lifecycle.
- `server/src/speech.ts` — local speech-to-text (Parakeet) and text-to-speech
  (Kokoro) via `sherpa-onnx-node`.
- `server/src/remote.ts` — phone/tablet access: Tailscale, Cloudflare quick
  tunnel, and own-certificate setup.
- `server/src/qr.ts` — QR code rendering for hub and remote-access links.
- `server/src/harnesses/` — one adapter per coding agent (`pi.ts`,
  `opencode.ts`, `claude.ts`), implementing the contract in
  `server/src/harnesses/types.ts`: session discovery and headless turn
  execution.
- `web/src/Hub.tsx` — the hub page: session list, new-chat tiles, and the
  phone access panel.
- `web/src/App.tsx` — the voice room UI (recording, live transcription,
  playback) for a single session.
- `tests/` — Node test-runner (`.test.mjs`) integration tests.

Compiled output goes to `dist/` (`dist/server`, `dist/web`); it is not
committed.

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

## Harness adapter contract

Every coding agent the hub supports is a `HarnessAdapter` implementation, as
defined in `server/src/harnesses/types.ts`:

- `available()` reports whether the agent's CLI is installed and runnable.
- `listSessions(limit?)` returns that agent's sessions, most recently updated
  first, found by reading its own session files — no plugin or extension
  runs inside the agent itself. Each `SessionInfo` reports whether the
  session is currently `open` in a terminal process.
- `send(target, text, signal)` runs one user turn headlessly, streaming
  `TurnEvent`s (status, tool calls, text deltas, notices, errors, and a final
  `done`). When `target.fork` is set — because the session is open in a
  terminal — the adapter must continue the session as a fork instead of
  writing into the live session file, so the terminal copy is never
  disturbed.

Keep this contract in mind, and keep the three adapters' behavior consistent,
when changing `server/src/harnesses/types.ts` or any adapter under
`server/src/harnesses/`.
