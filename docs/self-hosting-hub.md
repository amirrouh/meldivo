# Self-hosting a hub

A hub is an ordinary meldivo install with hub mode turned on. Your other
machines join it and connect out to it, and its one link shows every machine's
sessions. Any always-on computer works; a Raspberry Pi 5 is a good fit.

## 1. Install meldivo on the hub

You need Node.js 22 or newer.

```sh
npm install -g meldivo
MELDIVO_HOST=<vpn-ip> meldivo start
loginctl enable-linger $USER    # Linux: keep the service running after you log out
meldivo hub enable
```

`MELDIVO_HOST` makes the hub also listen on its private address (for example
its Tailscale, Headscale, or WireGuard address), which is how your other
machines reach it. Leave it out if every machine is the same computer. The
setting is remembered.

`meldivo hub enable` prints the hub link. Open it on the hub itself, or set up
phone access (see [remote access](remote-access.md)).

The hub doesn't need any coding agent installed, but if one is installed, the
hub's own sessions are listed too.

### Where speech runs

Speech recognition and the spoken replies need a reasonably fast CPU. On a
Raspberry Pi 5, a reply takes about 3 seconds to start speaking, compared with
well under half a second on a desktop computer. Join your fastest machine with
`--speech` (see below), and the hub hands all speech to it whenever it is
connected. Otherwise the hub uses its own models, which it downloads (about
850 MB) if no speech machine has connected within 30 seconds of starting.

## 2. Add your machines

On the hub:

```sh
meldivo hub code
```

This prints a one-time code, valid for 10 minutes, and the exact command to run
on the other machine:

```sh
npm install -g meldivo
meldivo start
meldivo join http://<vpn-ip>:4100 <code>
```

The machine gets its own credential, pins the hub's identity, and connects. Its
sessions appear in the hub within a few seconds. Repeat for each machine; each
needs a fresh code.

Options for `meldivo join`:

- `--name <name>`: the machine's name in the hub (default: its hostname).
- `--allow pi,opencode`: only let the hub use these agents on this machine.
- `--speech`: also do speech (recognition and spoken replies) for the hub.
  Voice audio then goes from the hub to this machine and back, so use it only
  over a private network or https.

## 3. Manage machines

```sh
meldivo hub machines          # who joined, and who is online
meldivo hub remove <name>     # cut a machine off immediately
meldivo leave                 # on a machine: stop using the hub
```

To give a machine a new credential, remove it on the hub, run `meldivo leave`
on the machine, and join it again with a new code.

## Security model

- Everything on the hub is behind its secret link. Without the link, every
  request gets a plain "404 Not Found".
- Machines connect out. Nothing needs to be opened on them.
- A join code works once and expires after 10 minutes. The answer to a join is
  authenticated with the code, and every later connection is checked against
  the hub key the machine pinned when it joined. A different server that
  pretends to be your hub is refused.
- The hub stores only machine names and hashes of their credentials. Session
  lists are kept in memory, and turn text only passes through.
- The hub can only ask a machine to run or cancel a text turn in one of that
  machine's own sessions. It can't send commands or read files. Each machine
  logs every turn the hub started, without the text.
- Anyone with the hub link can use every joined machine's agents. Keep the link
  private, and never expose the hub on a public address without HTTPS (see
  [remote access](remote-access.md)).

## Plain http or https

On a private VPN, plain `http://` between machines and the hub is fine: the VPN
encrypts the traffic, and the pinned hub key stops a look-alike hub. Over any
other network, put the hub behind HTTPS, for example with a reverse proxy.
Then join with `https://` and enable WebSocket support in the proxy.

## Troubleshooting

- **A machine shows as offline:** run `meldivo status` on it. It should say it
  is connected. If not, check that it can reach the hub address, e.g.
  `curl -I http://<vpn-ip>:4100` should answer with `404`.
- **"The hub did not accept this code":** codes are single use and expire after
  10 minutes. Create a new one with `meldivo hub code`.
- **The machine logs `hub_identity_mismatch`:** the server at that address is not
  the hub this machine joined, or the hub was reinstalled. If you reinstalled
  it, run `meldivo leave` and join again.
