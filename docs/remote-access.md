# Remote access

Browsers only allow microphone access on `localhost` or over HTTPS. Meldivo's
default link (`http://127.0.0.1:4100/...`) works fine on the same computer,
but a phone, tablet, or another computer needs an HTTPS link instead.

`/meldivo remote` sets that up for you. It checks which of three options are
ready to go, lets you pick one, and prints an HTTPS room link. If none are
ready yet, it prints a link to this page.

```text
/meldivo remote        # set up and print an HTTPS link
/meldivo remote stop   # turn remote access off
```

## Quick comparison

| Option | Privacy | Setup effort | Works away from home? |
|---|---|---|---|
| Tailscale | Private — only your tailnet | Low (one-time) | Yes |
| Cloudflare quick tunnel | Public link, protected by the secret token | Lowest | Yes |
| Own certificate | Private — your network/VPN only | Medium (per device) | Only on that network/VPN |

## 1. Tailscale

Tailscale creates a private network between your own devices and gives this
computer an HTTPS name only your devices can reach.

1. Install Tailscale on this computer and on your phone (or other device):
   [tailscale.com/download](https://tailscale.com/download).
2. Log in to the same Tailscale account on both, then run:
   ```bash
   tailscale up
   ```
3. Turn on HTTPS certificates for your tailnet: in the
   [Tailscale admin console](https://login.tailscale.com/admin/dns), go to
   **DNS**, enable **MagicDNS**, then enable **HTTPS Certificates**.
4. In Pi, run:
   ```text
   /meldivo remote
   ```
   and pick **Tailscale**. Meldivo runs `tailscale serve --bg 4100` and prints
   a link like `https://<machine>.<tailnet>.ts.net/?room=...`.

Open that link on any device signed in to the same Tailscale account.

## 2. Cloudflare quick tunnel

A quick tunnel gets you an HTTPS link on the public internet with no account
and no DNS setup. Anyone with the link could reach the server, but the room
token embedded in the link is required to actually connect — treat the link
like a password and don't post it publicly.

1. Install `cloudflared`:
   - macOS: `brew install cloudflared`
   - Linux: install the `.deb`/package for your distro, or grab a binary from
     [Cloudflare's GitHub releases](https://github.com/cloudflare/cloudflared/releases)
2. In Pi, run:
   ```text
   /meldivo remote
   ```
   and pick **Cloudflare**. Meldivo runs
   `cloudflared tunnel --url http://127.0.0.1:4100` and prints a link like
   `https://<random>.trycloudflare.com/?room=...`.

Notes:
- No account or login required.
- Audio passes through Cloudflare's network on its way to you.
- The tunnel gets a new random address each time and stops when Pi exits, or
  when you run `/meldivo remote stop`.

## 3. Own certificate (mkcert)

This keeps everything on your local network or VPN, with a certificate your
own devices trust.

### Create the certificate

1. Install [mkcert](https://github.com/FiloSottile/mkcert):
   - macOS: `brew install mkcert`
   - Linux: use your package manager, or the binary from mkcert's releases
     page.
2. Set up a local certificate authority (one time):
   ```bash
   mkcert -install
   ```
3. Find this computer's LAN IP:
   - macOS: `ipconfig getifaddr en0` (or `en1` for Wi-Fi vs. Ethernet)
   - Linux: `hostname -I`
4. Create the certificate for that IP (and hostname, if you use one):
   ```bash
   mkdir -p ~/.config/meldivo/tls
   mkcert -cert-file ~/.config/meldivo/tls/cert.pem \
          -key-file ~/.config/meldivo/tls/key.pem \
          <lan-ip> <hostname>.local localhost
   ```
   (Respects `XDG_CONFIG_HOME` if you've set it.)
5. In Pi, run:
   ```text
   /meldivo remote
   ```
   and pick **Own certificate**. The server also listens on
   `https://0.0.0.0:4443` (`MELDIVO_HTTPS_PORT`) and prints a link like
   `https://<lan-ip>:4443/?room=...`.

### Trust the certificate on each device

Devices need to trust mkcert's root CA before they'll accept the certificate.
Find it with:

```bash
mkcert -CAROOT
```

This prints a folder containing `rootCA.pem` (safe to share) and
`rootCA-key.pem` (**keep this private** — anyone with it can impersonate any
site to a device that trusts your CA).

- **iPhone/iPad**: send `rootCA.pem` to the device (AirDrop or email), open
  it, allow the profile download, then go to **Settings → Profile
  Downloaded → Install**. Then go to **Settings → General → About →
  Certificate Trust Settings** and enable full trust for the mkcert
  certificate.
- **Android**: copy `rootCA.pem` to the device, then go to
  **Settings → Security → Encryption & credentials → Install a certificate →
  CA certificate**, and select the file.
- **Other computers**:
  - macOS: double-click `rootCA.pem` to add it to Keychain Access, then set
    it to **Always Trust**.
  - Linux: import it into your distro's certificate store (e.g.
    `update-ca-certificates` on Debian/Ubuntu after copying it to
    `/usr/local/share/ca-certificates/`), or into your browser's certificate
    settings.
  - Windows/Firefox: Firefox uses its own certificate store — import
    `rootCA.pem` under Settings → Privacy & Security → Certificates. On
    Windows, import it into the system "Trusted Root Certification
    Authorities" store.

## 4. Other options

If you'd rather run your own reverse proxy (Caddy, nginx, etc.) with a real
domain, that works too:

- Proxy your domain to `http://127.0.0.1:4100`.
- Make sure streaming/SSE responses aren't buffered (e.g. in nginx,
  `proxy_buffering off;` on the relevant location).
- Set `MELDIVO_PUBLIC_URL` to the externally reachable address so Meldivo
  prints the right link.

## Troubleshooting

- **Microphone blocked / grayed out**: the page isn't being served over
  HTTPS, or the certificate isn't trusted yet on that device. Check the
  address bar for a lock icon with no warning.
- **Link doesn't open from another device**: check that port 4443 isn't
  blocked by a firewall, and that the device is on the same network or VPN
  as this computer.
- **Tailscale link doesn't have HTTPS**: make sure HTTPS Certificates is
  enabled for your tailnet in the Tailscale admin console (DNS → MagicDNS +
  HTTPS Certificates), then run `/meldivo remote` again.
