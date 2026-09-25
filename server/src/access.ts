import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";

// Everything the hub serves, including the page itself, requires the secret. A browser proves
// it either with the X-Meldivo-Token header (API calls) or with an HttpOnly cookie set by
// POST /api/unlock. An unauthenticated visitor gets a plain "404 Not Found" for every request,
// so the address gives no hint that anything is there. That page quietly reads the key from
// the link's #fragment (never sent to servers, so it stays out of proxy logs), exchanges it
// for the cookie, and reloads; tapping it five times reveals a key field for devices that only
// have the bare address (e.g. a Home Screen app that lost its cookie).

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
    notFound(req, res);
  };

  const unlock: RequestHandler = (req, res) => {
    const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
    if (!token || !safeEqual(secret, token)) return notFound(req, res);
    res.setHeader("Cache-Control", "no-store");
    setSessionCookie(req, res, cookieValue);
    res.status(204).end();
  };

  return { middleware, unlock, isAuthorized };
}

// The same bare 404 for every unauthenticated request, page or API, right key path or not.
function notFound(req: Request, res: Response): void {
  res.removeHeader("X-Request-Id");
  res.status(404).set({ "Cache-Control": "no-store", "Content-Type": "text/html" });
  res.end(req.method === "HEAD" ? undefined : NOT_FOUND_PAGE);
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

// Looks like a web server's stock 404. The script only acts on a #token= link or five taps.
const NOT_FOUND_PAGE = `<html>
<head><title>404 Not Found</title><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"></head>
<body>
<center><h1>404 Not Found</h1></center>
<hr>
<script>
(function () {
  function unlock(key) {
    return fetch("/api/unlock", { method: "POST", headers: { "Content-Type": "application/json" },
      credentials: "same-origin", body: JSON.stringify({ token: key }) }).then(function (r) { return r.ok; });
  }
  var match = /[#&]token=([^&]+)/.exec(location.hash);
  if (match) unlock(decodeURIComponent(match[1]).trim()).then(function (ok) { if (ok) location.reload(); });
  var taps = 0, first = 0;
  document.addEventListener("click", function () {
    var now = Date.now();
    if (now - first > 3000) { first = now; taps = 0; }
    if (++taps < 5 || document.querySelector("input")) return;
    var input = document.createElement("input");
    input.type = "password";
    input.autocomplete = "off";
    input.addEventListener("keydown", function (event) {
      if (event.key !== "Enter") return;
      var key = input.value.replace(/^.*[#&]token=/, "").trim();
      try { key = decodeURIComponent(key); } catch (e) {}
      unlock(key).then(function (ok) {
        if (!ok) { input.value = ""; return; }
        history.replaceState(null, "", location.pathname + location.search + "#token=" + encodeURIComponent(key));
        location.reload();
      });
    });
    document.body.appendChild(input);
    input.focus();
  });
})();
</script>
</body>
</html>
`;
