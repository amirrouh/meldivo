# meldivo

**Always-on local voice hub for coding agents.** Install it once, and talk by
voice to your [Pi](https://pi.dev), [OpenCode](https://opencode.ai), and
[Claude Code](https://claude.com/claude-code) sessions from any browser or
phone. Speech recognition and speech synthesis run locally on your machine:
no cloud speech API, no API keys for speech, no extra LLM.

```bash
npm i -g meldivo
meldivo start
```

`meldivo start` installs a user service that keeps the hub running in the
background, then prints a local link and a QR code:

```text
http://127.0.0.1:4100/#token=...
```

Open the link (or scan the QR code) to see every Pi, OpenCode, and Claude
Code session on the machine, plus a "new chat" tile for each installed agent.
Tap any tile to start talking.

## Features

- **One hub for every session.** The hub page lists your Pi, OpenCode, and
  Claude Code sessions automatically, found from their own session files —
  no plugins or extensions to install in each agent.
- **Hands-free conversation.** Your speech becomes a turn in the chosen
  session, run headlessly with that session's own model and credentials.
  Replies are spoken back to you.
- **Safe alongside your terminal.** If a session is already open in a
  terminal, talking to it by voice continues it as a fork, so the voice
  copy never conflicts with what you're typing.
- **Local, private speech.** Speech-to-text uses NVIDIA Parakeet TDT 0.6B v3
  and text-to-speech uses Kokoro v1.0, both running on the CPU through
  [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx). Audio never leaves
  your machine unless you turn on phone access.
- **Phone and tablet access.** `meldivo remote` (or the hub's "Phone access"
  panel) publishes the hub over HTTPS through Tailscale, a Cloudflare
  tunnel, or your own certificate, and shows a QR code to scan.
- **Runs in the background.** A user service (systemd on Linux, launchd on
  macOS) starts the hub on login and keeps it running. Models download once
  on first use.
- **Secure by default.** The server listens on `127.0.0.1` only, and the
  whole hub is protected by a random token embedded in its link.

## Requirements

- Node.js 22 or later
- macOS or Linux (x64 or arm64)
- At least one of: Pi, OpenCode, Claude Code
- About 650 MB of disk space for the speech models, downloaded on first use

## Supported agents

| Agent | Sessions found from | "Open in terminal" | Tool approvals |
|---|---|---|---|
| Pi | Pi's own session files in the home folder | A voice turn continues the session as a fork, leaving the terminal session untouched | No approval step; a denied action is announced |
| OpenCode | OpenCode's session files | A voice turn continues the session as a fork, leaving the terminal session untouched | Headless runs auto-reject actions that need approval |
| Claude Code | Claude Code's session files | A voice turn continues the session as a fork, leaving the terminal session untouched | Runs with `--permission-mode acceptEdits` |

Pi is listed first on the hub page, since it's the reference agent for this
project.

## Commands

| Command | Description |
|---|---|
| `meldivo start` | Install (if needed) and start the background service, then print the hub link and QR code. |
| `meldivo stop` | Stop the background service. |
| `meldivo status` | Show whether the service is running and its listening address. |
| `meldivo open [--browser]` | Print the hub link, optionally opening it in a browser. |
| `meldivo remote` | Set up phone/tablet access over HTTPS. |
| `meldivo remote tailscale` | Publish the hub over Tailscale. |
| `meldivo remote cloudflare` | Publish the hub through a Cloudflare quick tunnel. |
| `meldivo remote certificate` | Publish the hub over HTTPS using your own certificate. |
| `meldivo remote stop` | Turn remote access off. |
| `meldivo peer add <name> <link>` | Show another machine's hub (and its sessions) in this one. `meldivo peer` lists peers; `meldivo peer remove <name>` removes one. |
| `meldivo logs` | Show the service's recent log output. |
| `meldivo uninstall [--purge]` | Remove the background service. `--purge` also deletes configuration, models, and logs. |
| `meldivo --version` | Print the installed version. |

## Using it from a phone or another computer

Browsers only allow microphone access on `localhost` or over HTTPS, so
another device needs an HTTPS link. Run `meldivo remote`, or open the hub's
"Phone access" panel, to set one up:

1. **Tailscale**: private to your own devices, works from anywhere.
2. **Cloudflare quick tunnel**: no account needed, produces a public link
   protected by its token.
3. **Your own certificate**: HTTPS on your local network or VPN, for example
   with `mkcert`.

Whichever option you pick, the link is the same hub link — the whole hub
becomes reachable from that device, protected by its token. See the
[remote access guide](docs/remote-access.md) for setup details, including
how to trust a certificate on iPhone and Android.

## Several machines, one hub

Install meldivo on each machine, pick one as the main hub, and add the others
to it as peers. The main hub then lists every machine with its own new-chat
tiles and sessions, all behind the main hub's single link. Speech runs on the
main hub; only the text of each turn travels to the other machine.

Peers must be reachable from the main hub over a private network such as a
VPN. On each other machine:

```sh
MELDIVO_HOST=<vpn-ip> meldivo start   # also listen on the VPN address
meldivo open                          # prints "Also on http://<vpn-ip>:4100/#token=..."
```

Then on the main hub:

```sh
meldivo peer add workstation 'http://<vpn-ip>:4100/#token=...'
```

Peer links are stored in `~/.config/meldivo/peers.json`, readable only by you.
Never put a peer on a public address: the main hub's link now controls every
machine it lists.

## How it works

`meldivo start` installs a user service that runs the hub server on
`127.0.0.1:4100`. The hub scans each installed agent's session files to list
recent sessions and shows a "new chat" tile for each installed agent. When
you talk to a session, the hub runs that agent headlessly for one turn, using
its own model and credentials; if the session is open in a terminal, the
turn runs against a fork instead, so the terminal session is never touched.
Your speech is transcribed locally, sent to the agent as a normal user
message, and the reply is read aloud with local text-to-speech.

## Configuration

All settings are optional.

| Variable | Default | Purpose |
|---|---|---|
| `MELDIVO_PORT` | `4100` | Port of the local server (`127.0.0.1` only). |
| `MELDIVO_HTTPS_PORT` | `4443` | HTTPS port used by the "own certificate" remote option. |
| `MELDIVO_PUBLIC_URL` | unset | Base URL to print when you run your own reverse proxy. |
| `MELDIVO_HOST` | unset | Extra addresses to listen on besides `127.0.0.1` (comma-separated), e.g. a VPN address your reverse proxy forwards to. |
| `MELDIVO_MODELS_DIR` | `~/.cache/meldivo/models` | Location of the downloaded speech models. |

## Files and locations

| Path | Contents |
|---|---|
| `~/.config/meldivo/secret` | The hub's shared secret, generated automatically. |
| `~/.config/meldivo/peers.json` | Other machines' hubs shown in this one, with their keys. |
| `~/.cache/meldivo/models` | Downloaded speech models. |
| `~/.local/state/meldivo` | Service logs and runtime state. |

## Security notes

The server listens on `127.0.0.1` only; it is never exposed on the network
unless you explicitly turn on phone access. Every hub link, local or remote,
embeds a random token, and requests without it are rejected. Treat the hub
link like a password: anyone who has it can use every session in the hub,
including the sessions of every peer machine added to it.

## Uninstall

```bash
meldivo uninstall --purge
npm rm -g meldivo
```

`meldivo uninstall` alone removes the background service but keeps your
configuration, models, and logs; add `--purge` to remove those too.

## Development

```bash
npm install
npm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the project layout and
conventions.

## License

MIT. See [LICENSE](LICENSE). Third-party software and model licenses are
listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
