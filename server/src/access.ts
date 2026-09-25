import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";

// Everything the hub serves, including the page itself, requires the secret. A browser proves
// it either with the X-Meldivo-Token header (API calls) or with an HttpOnly cookie set by
// POST /api/unlock. The lock page below is the only thing an unauthenticated visitor gets: it
// reads the key from the link's #fragment (never sent to servers, so it stays out of proxy
// logs), exchanges it for the cookie, and reloads.

const COOKIE_NAME = "meldivo_session";
const COOKIE_MAX_AGE_S = 365 * 24 * 60 * 60;

export interface AccessGate {
  /** Rejects every request that carries neither a valid token nor a valid session cookie. */
  middleware: RequestHandler;
  /** POST /api/unlock handler: `{ token }` in, session cookie out. */
  unlock: RequestHandler;
  /** Whether the request carries the secret (header or cookie). */
  isAuthorized(req: Request): boolean;
}

export function createAccessGate(secret: string): AccessGate {
  // The cookie holds a value derived from the secret rather than the secret itself.
  const cookieValue = createHmac("sha256", secret).update("meldivo-session-v1").digest("hex");

  function isAuthorized(req: Request): boolean {
    const token = req.get("x-meldivo-token") ?? req.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (token && safeEqual(secret, token)) return true;
    const cookie = readCookie(req, COOKIE_NAME);
    return cookie !== undefined && safeEqual(cookieValue, cookie);
  }

  const middleware: RequestHandler = (req, res, next) => {
    if (req.method === "POST" && req.path === "/api/unlock") return next();
    if (isAuthorized(req)) {
      // Authenticated content must never land in a shared (proxy) cache.
      res.setHeader("Cache-Control", "private, no-cache");
      return next();
    }
    res.setHeader("Cache-Control", "no-store");
    if (req.path === "/api" || req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found" });
    if (req.method !== "GET" && req.method !== "HEAD") return res.status(404).end();
    res.status(401).type("html").send(LOCK_PAGE);
  };

  const unlock: RequestHandler = (req, res) => {
    const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
    res.setHeader("Cache-Control", "no-store");
    if (!token || !safeEqual(secret, token)) return res.status(401).json({ error: "Invalid key" });
    setSessionCookie(req, res, cookieValue);
    res.status(204).end();
  };

  return { middleware, unlock, isAuthorized };
}

function setSessionCookie(req: Request, res: Response, value: string): void {
  // Secure everywhere except plain-http localhost, whatever a (spoofable) X-Forwarded-Proto says.
  const secure = req.secure || !isLoopbackHost(req.hostname);
  const attributes = [`${COOKIE_NAME}=${value}`, "Path=/", `Max-Age=${COOKIE_MAX_AGE_S}`, "HttpOnly", "SameSite=Strict"];
  if (secure) attributes.push("Secure");
  res.setHeader("Set-Cookie", attributes.join("; "));
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "::1" || hostname === "[::1]" || /^127\./.test(hostname);
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

function safeEqual(expected: string, candidate: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(candidate);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Deliberately bare: no title, branding, or hint of what is behind it.
const LOCK_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title></title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#050609;color:#aab;font:14px system-ui,sans-serif}
form{display:none;gap:8px}input{width:260px;padding:9px 11px;border:1px solid #334;border-radius:8px;background:#0c0f16;color:#dde}
button{padding:9px 13px;border:0;border-radius:8px;background:#233;color:#dde}</style></head>
<body><form id="f"><input id="k" type="password" autocomplete="off" aria-label="Key"><button>Open</button></form>
<script>
(function () {
  function keyFrom(value) {
    var match = /(?:^|[#&?])token=([^&]+)/.exec(value);
    return decodeURIComponent(match ? match[1] : value).trim();
  }
  function unlock(key) {
    return fetch("/api/unlock", { method: "POST", headers: { "Content-Type": "application/json" },
      credentials: "same-origin", body: JSON.stringify({ token: key }) }).then(function (r) { return r.ok; });
  }
  var hashKey = keyFrom(location.hash);
  var form = document.getElementById("f");
  function showForm() { form.style.display = "flex"; }
  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var key = keyFrom(document.getElementById("k").value);
    unlock(key).then(function (ok) {
      if (!ok) return;
      history.replaceState(null, "", location.pathname + location.search + "#token=" + encodeURIComponent(key));
      location.reload();
    });
  });
  if (hashKey && location.hash) unlock(hashKey).then(function (ok) { ok ? location.reload() : showForm(); }, showForm);
  else showForm();
})();
</script></body></html>`;
