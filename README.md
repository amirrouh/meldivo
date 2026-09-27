<p align="center">
  <img src="https://raw.githubusercontent.com/amirrouh/meldivo/main/assets/meldivo-logo.png" alt="meldivo" width="120">
</p>

<h1 align="center">meldivo</h1>

<p align="center">
  <strong>Talk to your coding agents.</strong><br>
  A local voice hub for Pi, Claude Code, and OpenCode, in any browser.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/meldivo"><img src="https://img.shields.io/npm/v/meldivo?color=black&label=npm" alt="npm version"></a>
  <a href="https://github.com/amirrouh/meldivo/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/meldivo?color=black" alt="MIT license"></a>
  <a href="https://github.com/amirrouh/meldivo/blob/main/docs/README.md"><img src="https://img.shields.io/badge/docs-read-black" alt="Documentation"></a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/amirrouh/meldivo/main/assets/meldivo-demo.gif" alt="Install meldivo, start it, and talk to a Claude Code session in the browser" width="720">
</p>

---

## Get started in three steps

**1. Install**

```bash
npm i -g meldivo
```

**2. Start**

```bash
meldivo start
```

meldivo runs in the background from now on and prints your private hub link
with a QR code.

**3. Talk**

Open the link in any browser, or scan the QR code. Every Pi, Claude Code, and
OpenCode session on your machine is already there. Pick one, or start a new
chat, and just speak.

That's it. No API keys, no plugins, no cloud.

## Why meldivo

- **Works with the agents you already use.** Pi, Claude Code, and OpenCode
  sessions show up automatically, each running with its own model and
  credentials.
- **Private by design.** Speech recognition and synthesis run locally on your
  CPU. The hub listens on `127.0.0.1` only and every link is protected by a
  secret token.
- **Never in your way.** If a session is open in a terminal, voice continues
  it as a fork, so nothing collides with what you're typing.
- **Anywhere you are.** `meldivo remote` puts the hub on your phone over HTTPS,
  and your other computers can join one hub with a one-time code.
- **Bring your own voice.** Point it at your own speech server (Breeze TTS 2,
  vLLM-Omni, Kokoro, Whisper, and more) for bigger or more realistic models.

## Requirements

Node.js 22+, macOS or Linux, and at least one of Pi, Claude Code, or OpenCode.
Speech models (about 650 MB) download once on first use.

## Documentation

Commands, phone access, multi-machine hubs, speech servers, configuration, and
security are all covered in the
**[documentation](https://github.com/amirrouh/meldivo/blob/main/docs/README.md)**.

## License

MIT. See [LICENSE](https://github.com/amirrouh/meldivo/blob/main/LICENSE) and
[third-party notices](https://github.com/amirrouh/meldivo/blob/main/THIRD_PARTY_NOTICES.md).
