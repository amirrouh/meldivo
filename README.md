# pi-meldivo

**Voice mode for the Pi coding agent.** Speak to your active
[Pi](https://pi.dev) session from a browser or phone and hear its replies.
Speech recognition and speech synthesis run locally on your machine: no
cloud speech API, no API keys, no extra LLM.

```bash
pi install npm:pi-meldivo
```

Then, inside any Pi session:

```text
/meldivo
```

Open the printed link (or scan the QR code in the terminal) and start talking.

## Features

- **Hands-free conversation with your coding agent.** Your speech becomes a
  message in the current Pi session, using that session's model, tools,
  project, and history. Replies are spoken back to you.
- **Local, private speech.** Speech-to-text uses NVIDIA Parakeet TDT 0.6B v3 and
  text-to-speech uses Kokoro v1.0, both running on the CPU through
  [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx). Audio never leaves your
  machine unless you choose a remote-access option.
- **Natural turn-taking.** Voice activity detection, barge-in (interrupt the
  agent by speaking), and live transcription in the browser.
- **Phone and tablet access.** `/meldivo remote` publishes the session over
  HTTPS through Tailscale, a Cloudflare tunnel, or your own certificate, and
  shows a QR code to scan.
- **Nothing to configure.** One install command. No Python, Docker, or system
  services. Models download once on first use.
- **Secure by default.** The server listens on `127.0.0.1` only, and every
  voice room is protected by a random token embedded in its link.

## Requirements

- Pi coding agent
- Node.js 22 or later
- macOS or Linux (x64 or arm64)
- About 650 MB of disk space for the speech models, downloaded on first use

## Commands

| Command | Description |
|---|---|
| `/meldivo` | Start voice mode for this session and print a local link with a QR code. Run it again to disconnect. |
| `/meldivo stop` | Disconnect voice mode for this session. |
| `/meldivo remote` | Make the voice link reachable from other devices over HTTPS. |
| `/meldivo remote stop` | Turn remote access off and keep the local link. |

## Using it from a phone or another computer

Browsers only allow microphone access on `localhost` or over HTTPS, so another
device needs an HTTPS link. `/meldivo remote` detects which of these is
available and lets you choose:

1. **Tailscale**: private to your own devices, works from anywhere.
2. **Cloudflare quick tunnel**: no account needed, produces a public link
   protected by its token.
3. **Your own certificate**: HTTPS on your local network or VPN, for example
   with `mkcert`.

If none of them is set up, the command links to the
[remote access guide](docs/remote-access.md), which walks through each option,
including how to trust a certificate on iPhone and Android.

## How it works

`/meldivo` starts a small local server (shared by all Pi sessions and shut down
automatically when idle) and creates a voice room for the current session. The
browser page records your speech, the server transcribes it, and the extension
delivers the text to Pi as a user message. When Pi finishes its reply, the text
is sent back to the room and read aloud. Tool calls and permission prompts stay
in your terminal.

## Configuration

All settings are optional.

| Variable | Default | Purpose |
|---|---|---|
| `MELDIVO_PORT` | `4100` | Port of the local server (`127.0.0.1` only). |
| `MELDIVO_HTTPS_PORT` | `4443` | HTTPS port used by the "own certificate" remote option. |
| `MELDIVO_PUBLIC_URL` | unset | Base URL to print when you run your own reverse proxy. |
| `MELDIVO_MODELS_DIR` | `~/.cache/meldivo/models` | Location of the downloaded speech models. |

The server's shared secret is generated automatically and stored at
`~/.config/meldivo/secret`. Server logs are written to
`~/.local/state/meldivo/server.log`.

## Uninstall

```bash
pi remove npm:pi-meldivo
rm -rf ~/.cache/meldivo ~/.config/meldivo ~/.local/state/meldivo
```

## Development

```bash
npm install
npm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the project layout and conventions.

## License

MIT. See [LICENSE](LICENSE). Third-party software and model licenses are listed
in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
