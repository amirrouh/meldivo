import assert from "node:assert/strict";
import { test } from "node:test";
import { scanLine, scanText } from "../scripts/privacy-check.mjs";

function reasons(findings) {
  return findings.map((f) => f.reason);
}

test("flags a private-range IPv4 literal (RFC1918)", () => {
  const octets = [10, String(20 + 152), 1, 1]; // built at runtime, not a literal
  const line = `bind host ${octets.join(".")}`; // privacy-check: allow
  const findings = scanLine(line);
  assert.ok(findings.some((f) => f.reason === "IPv4 address"));
});

test("flags a CGNAT/Tailscale range IPv4 literal", () => {
  const parts = ["100", "64", "0", "1"];
  const line = `peer at ${parts.join(".")}`; // privacy-check: allow
  const findings = scanLine(line);
  assert.ok(findings.some((f) => f.reason === "IPv4 address"));
});

test("flags a public IPv4 literal", () => {
  const parts = ["8", "8", "4", "4"];
  const line = `server ${parts.join(".")}`; // privacy-check: allow
  const findings = scanLine(line);
  assert.ok(findings.some((f) => f.reason === "IPv4 address"));
});

test("does not flag documentation-range IPv4 addresses", () => {
  for (const ip of ["192.0.2.1", "198.51.100.7", "203.0.113.42", "127.0.0.1", "0.0.0.0", "255.255.255.255"]) {
    const findings = scanLine(`see ${ip} for an example`);
    assert.deepEqual(findings, [], `expected no findings for ${ip}`);
  }
});

test("does not flag version-like dotted numbers", () => {
  const findings = scanLine("upgrade to v1.2.3.4 or package 10.20.30.40.50");
  assert.deepEqual(findings, []);
});

test("flags an email address", () => {
  const local = ["jane", "doe"].join(".");
  const domain = ["example-corp", "dev"].join("."); // not example.com/.org/.net
  const line = `contact ${local}@${domain}`; // privacy-check: allow
  const findings = scanLine(line);
  assert.ok(findings.some((f) => f.reason === "email address"));
});

test("does not flag example/invalid/test/noreply emails", () => {
  for (const email of [
    "jane@example.com",
    "jane@example.org",
    "jane@example.net",
    "jane@service.invalid",
    "jane@service.test",
    "noreply@github.com",
  ]) {
    const findings = scanLine(`contact ${email}`);
    assert.deepEqual(findings, [], `expected no findings for ${email}`);
  }
});

test("respects allowEmails option (e.g. package.json author email)", () => {
  const email = ["author", "publicproject.dev"].join("@");
  const line = `contact ${email}`;
  const withoutAllow = scanLine(line);
  assert.ok(withoutAllow.some((f) => f.reason === "email address"));
  const withAllow = scanLine(line, { allowEmails: [email] });
  assert.deepEqual(withAllow, []);
});

test("flags a personal home directory path", () => {
  const segments = ["home", "al" + "ice"];
  const line = `config lives at /${segments.join("/")}/config.json`; // privacy-check: allow
  const findings = scanLine(line);
  assert.ok(findings.some((f) => f.reason === "personal home directory path"));
});

test("does not flag placeholder home directory paths", () => {
  for (const p of ["/home/<user>/config.json", "/home/user/config.json", "/home/you/x", "/home/me/x", "/home/example/x", "/Users/USER/x"]) {
    const findings = scanLine(`path: ${p}`);
    assert.deepEqual(findings, [], `expected no findings for ${p}`);
  }
});

test("flags a .ts.net hostname", () => {
  const host = ["my" + "device", "tailxxxx", "ts", "net"].join(".");
  const findings = scanLine(`reach it at ${host}`); // privacy-check: allow
  assert.ok(findings.some((f) => f.reason.includes("ts.net")));
});

test("does not flag documentation domains", () => {
  for (const host of ["voice.example.com", "<vpn-ip>", "example.com"]) {
    const findings = scanLine(`see ${host} for setup`);
    assert.deepEqual(findings, []);
  }
});

test("does not flag a generic placeholder .ts.net label", () => {
  const findings = scanLine("e.g. `https://host.ts.net`");
  assert.deepEqual(findings, []);
});

test("flags a long hex string", () => {
  const hex = "a1b2c3d4e5f6".repeat(4).slice(0, 40);
  const line = `blob id ${hex}`; // privacy-check: allow
  const findings = scanLine(line);
  assert.ok(findings.some((f) => f.reason.includes("hex")));
});

test("does not flag long hex strings in a checksum/sha context", () => {
  const hex = "a1b2c3d4e5f6".repeat(4).slice(0, 40);
  const findings = scanLine(`sha256: ${hex}`);
  assert.deepEqual(findings, []);
});

test("flags token=/secret= with an inline value", () => {
  const value = "abcdEFGH12345678";
  const findings1 = scanLine(`url?token=${value}`); // privacy-check: allow
  assert.ok(findings1.some((f) => f.reason.includes("token=")));
  const findings2 = scanLine(`export secret=${value}`); // privacy-check: allow
  assert.ok(findings2.some((f) => f.reason.includes("secret=")));
});

test("does not flag placeholder token=/secret= values", () => {
  for (const line of ["url?token=...", "url?token=<token>", "export secret=${SECRET}"]) {
    const findings = scanLine(line);
    assert.deepEqual(findings, []);
  }
});

test("flags a Bearer token", () => {
  const token = "abcdefghijklmnopqrstuvwxyz1234";
  const findings = scanLine(`Authorization: Bearer ${token}`); // privacy-check: allow
  assert.ok(findings.some((f) => f.reason === "Bearer token"));
});

test("flags a PEM header", () => {
  const findings = scanLine("-----BEGIN PRIVATE KEY-----"); // privacy-check: allow
  assert.ok(findings.some((f) => f.reason.includes("PEM")));
});

test("flags an npm token", () => {
  const token = "npm_" + "a".repeat(24);
  const findings = scanLine(`registry token ${token}`); // privacy-check: allow
  assert.ok(findings.some((f) => f.reason === "npm token"));
});

test("flags a GitHub token", () => {
  const token = "ghp_" + "a".repeat(24);
  const findings = scanLine(`use ${token}`); // privacy-check: allow
  assert.ok(findings.some((f) => f.reason === "GitHub token"));
});

test("inline allow marker suppresses findings on that line", () => {
  const parts = ["10", "1", "2", "3"];
  const line = `x ${parts.join(".")} privacy-check: allow`;
  assert.deepEqual(scanLine(line), []);
});

test("scanText reports 1-indexed line numbers across multiple lines", () => {
  const parts = ["10", "1", "2", "3"];
  const text = ["first line is clean", `second line has ${parts.join(".")}`, "third line is clean"].join("\n");
  const findings = scanText(text);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 2);
});

test("findings expose a redacted snippet, not the raw value", () => {
  const local = ["jane", "doe"].join(".");
  const domain = ["example-corp", "dev"].join(".");
  const email = `${local}@${domain}`;
  const findings = scanLine(`contact ${email}`);
  assert.equal(findings.length, 1);
  assert.ok(findings[0].snippet.endsWith("…"));
  assert.ok(!findings[0].snippet.includes(email));
  assert.equal(findings[0].snippet, `${email.slice(0, 4)}…`);
});
