import assert from "node:assert/strict";
import { test } from "node:test";

test("voice lease requests carry the hub token", async () => {
  const calls = [];
  globalThis.window = {
    sessionStorage: { getItem: () => "hub-token" },
    localStorage: { getItem: () => null },
    setInterval: () => 1,
    clearInterval: () => {},
  };
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ token: "lease-token-0123456789" }), { status: 201 });
  };
  const { acquireVoiceOwnership } = await import("../web/src/voice-ownership.ts");
  const ownership = await acquireVoiceOwnership();
  assert.ok(ownership);
  ownership.release();
  const lease = calls.filter((call) => String(call.url).startsWith("/api/voice/lease"));
  assert.ok(lease.length >= 2);
  for (const call of lease) assert.equal(call.init.headers["X-Meldivo-Token"], "hub-token");
});
