// Hub auth: the hub URL carries the secret as a fragment
// (`http://127.0.0.1:4100/#token=<secret>`) so it never reaches server logs.
// On load we lift it into storage and scrub it from the visible URL.

const sessionKey = "meldivo.token";
const localKey = "meldivo.token";

let cachedToken: string | null | undefined;

/** Runs once on startup: reads `#token=` from the URL, persists it, and cleans the URL. */
export function initAuth(): void {
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const token = fragment.get("token");
  if (!token) return;
  try { window.sessionStorage.setItem(sessionKey, token); } catch { /* storage may be unavailable */ }
  try { window.localStorage.setItem(localKey, token); } catch { /* storage may be unavailable */ }
  cachedToken = token;
  try {
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  } catch { /* history API may be unavailable in some embeds */ }
}

export function getAuthToken(): string | null {
  if (cachedToken !== undefined) return cachedToken;
  try {
    cachedToken = window.sessionStorage.getItem(sessionKey) ?? window.localStorage.getItem(localKey);
  } catch {
    cachedToken = null;
  }
  return cachedToken;
}

/** Headers for every authenticated /api call (all but GET /api/health). */
export function authHeaders(): Record<string, string> {
  const token = getAuthToken();
  return token ? { "X-Meldivo-Token": token } : {};
}

export class UnauthorizedError extends Error {
  constructor() {
    super("Unauthorized");
    this.name = "UnauthorizedError";
  }
}

/** Throws UnauthorizedError on a 401 so callers can show the locked-out screen. */
export function checkAuthorized(response: Response): Response {
  if (response.status === 401) throw new UnauthorizedError();
  return response;
}
