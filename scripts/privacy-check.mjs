#!/usr/bin/env node
// Generic, dependency-free privacy scanner. Works for any contributor: nothing
// owner-specific is hardcoded here (no real names, hostnames, domains, IPs, emails).
//
// Usage:
//   node scripts/privacy-check.mjs           scan tracked + published files (working tree)
//   node scripts/privacy-check.mjs --staged   scan only staged added lines (git diff --cached)
//
// Exits 1 and prints "file:line: reason: <redacted snippet>" for each finding.
// Exits 0 and prints "privacy-check: clean" when nothing is found.

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const ALLOW_MARKER = "privacy-check: allow";

const ALLOWED_EMAIL_DOMAINS = new Set(["example.com", "example.org", "example.net"]);
const ALLOWED_EMAIL_DOMAIN_SUFFIXES = [".invalid", ".test"];
const ALLOWED_HOME_NAMES = new Set(["<user>", "user", "you", "me", "example", "$user"]);
const ALLOWED_TS_NET_LABELS = new Set(["host", "device", "example", "your-device", "my-device", "peer", "machine"]);

const IPV4_RE = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const HOME_PATH_RE = /\/(home|Users)\/([^/\s"'`]+)\//g;
const TS_NET_RE = /\b[a-zA-Z0-9-](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.ts\.net\b/g;
const LONG_HEX_RE = /\b[0-9a-f]{40,}\b/gi;
const TOKEN_SECRET_RE = /\b(token|secret)=([^\s&"'<>`;]+)/gi;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._-]{20,}/g;
const PEM_RE = /-----BEGIN [A-Z ]+-----/g;
const NPM_TOKEN_RE = /\bnpm_[A-Za-z0-9]{20,}\b/g;
const GITHUB_TOKEN_RE = /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;
const HEX_CONTEXT_RE = /sha256|sha512|sha1|integrity|checksum/i;
const PLACEHOLDER_VALUE_RE = /^(\.\.\.|<.*>|\$\{.*\})$/;

function redact(value) {
  const s = String(value);
  if (s.length <= 4) return `${s}…`;
  return `${s.slice(0, 4)}…`;
}

function isPlaceholderValue(value) {
  return PLACEHOLDER_VALUE_RE.test(value.trim());
}

// --- IPv4 -------------------------------------------------------------

function ipv4Octets(match) {
  return match.split(".").map((part) => Number.parseInt(part, 10));
}

function isExcludedIPv4(octets) {
  const [a, b] = octets;
  if (a === 127) return true; // 127.0.0.0/8
  if (a === 0 && b === 0 && octets[2] === 0 && octets[3] === 0) return true; // 0.0.0.0
  if (a === 255 && b === 255 && octets[2] === 255 && octets[3] === 255) return true; // 255.255.255.255
  if (a === 192 && b === 0 && octets[2] === 2) return true; // 192.0.2.0/24 (TEST-NET-1)
  if (a === 198 && b === 51 && octets[2] === 100) return true; // 198.51.100.0/24 (TEST-NET-2)
  if (a === 203 && b === 0 && octets[2] === 113) return true; // 203.0.113.0/24 (TEST-NET-3)
  return false;
}

function findIPv4Findings(line) {
  const findings = [];
  for (const match of line.matchAll(IPV4_RE)) {
    const value = match[0];
    const start = match.index;
    const end = start + value.length;
    const before = line[start - 1];
    const after = line[end];
    // Skip version-like strings ("v1.2.3.4") and values that are part of a
    // longer dotted number (extra octet before/after the match).
    if (before === "." || (before && /\d/.test(before))) continue;
    if (before === "v" || before === "@") continue;
    if (after === "." && /\d/.test(line[end + 1] || "")) continue;
    const octets = ipv4Octets(value);
    if (octets.some((n) => Number.isNaN(n) || n > 255)) continue;
    if (isExcludedIPv4(octets)) continue;
    findings.push({ reason: "IPv4 address", snippet: redact(value) });
  }
  return findings;
}

// --- email --------------------------------------------------------------

function isAllowedEmail(email, allowEmails) {
  const lower = email.toLowerCase();
  if (lower.startsWith("noreply@")) return true;
  const domain = lower.split("@")[1] || "";
  if (ALLOWED_EMAIL_DOMAINS.has(domain)) return true;
  if (ALLOWED_EMAIL_DOMAIN_SUFFIXES.some((suffix) => domain.endsWith(suffix))) return true;
  if (allowEmails.some((allowed) => allowed.toLowerCase() === lower)) return true;
  return false;
}

function findEmailFindings(line, allowEmails) {
  const findings = [];
  for (const match of line.matchAll(EMAIL_RE)) {
    const value = match[0];
    if (isAllowedEmail(value, allowEmails)) continue;
    findings.push({ reason: "email address", snippet: redact(value) });
  }
  return findings;
}

// --- home paths -----------------------------------------------------------

function findHomePathFindings(line) {
  const findings = [];
  for (const match of line.matchAll(HOME_PATH_RE)) {
    const name = match[2];
    if (ALLOWED_HOME_NAMES.has(name.toLowerCase())) continue;
    findings.push({ reason: "personal home directory path", snippet: redact(match[0]) });
  }
  return findings;
}

// --- .ts.net hostnames ------------------------------------------------

function findTsNetFindings(line) {
  const findings = [];
  for (const match of line.matchAll(TS_NET_RE)) {
    const label = match[0].slice(0, -".ts.net".length).toLowerCase();
    if (ALLOWED_TS_NET_LABELS.has(label)) continue;
    findings.push({ reason: "Tailscale/Headscale hostname (.ts.net)", snippet: redact(match[0]) });
  }
  return findings;
}

// --- long hex strings ---------------------------------------------------

function findLongHexFindings(line) {
  const findings = [];
  if (HEX_CONTEXT_RE.test(line)) return findings;
  for (const match of line.matchAll(LONG_HEX_RE)) {
    findings.push({ reason: "long hex string (possible hash/token)", snippet: redact(match[0]) });
  }
  return findings;
}

// --- secrets/tokens -------------------------------------------------------

function findSecretFindings(line) {
  const findings = [];
  for (const match of line.matchAll(TOKEN_SECRET_RE)) {
    const key = match[1].toLowerCase();
    const value = match[2];
    if (isPlaceholderValue(value)) continue;
    if (value.length < 16) continue;
    findings.push({ reason: `${key}= with an inline value`, snippet: redact(match[0]) });
  }
  for (const match of line.matchAll(BEARER_RE)) {
    findings.push({ reason: "Bearer token", snippet: redact(match[0]) });
  }
  for (const match of line.matchAll(PEM_RE)) {
    findings.push({ reason: "PEM key/cert header", snippet: redact(match[0]) });
  }
  for (const match of line.matchAll(NPM_TOKEN_RE)) {
    findings.push({ reason: "npm token", snippet: redact(match[0]) });
  }
  for (const match of line.matchAll(GITHUB_TOKEN_RE)) {
    findings.push({ reason: "GitHub token", snippet: redact(match[0]) });
  }
  return findings;
}

// --- line + text scanning -------------------------------------------------

/**
 * Scan a single line of text (no newline) for privacy findings.
 * Returns an array of { reason, snippet } (no line number).
 */
export function scanLine(line, options = {}) {
  if (typeof line !== "string") return [];
  if (line.includes(ALLOW_MARKER)) return [];
  const allowEmails = options.allowEmails || [];
  return [
    ...findIPv4Findings(line),
    ...findEmailFindings(line, allowEmails),
    ...findHomePathFindings(line),
    ...findTsNetFindings(line),
    ...findLongHexFindings(line),
    ...findSecretFindings(line),
  ];
}

/**
 * Scan a whole text blob for privacy findings.
 * Returns an array of { line, reason, snippet }, 1-indexed line numbers.
 */
export function scanText(text, options = {}) {
  if (typeof text !== "string" || text.length === 0) return [];
  const lines = text.split(/\r\n|\r|\n/);
  const findings = [];
  for (let i = 0; i < lines.length; i++) {
    for (const finding of scanLine(lines[i], options)) {
      findings.push({ line: i + 1, ...finding });
    }
  }
  return findings;
}

// --- file/repo scanning (CLI mode) ----------------------------------------

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
}

function gitLsFiles(root) {
  return execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function npmPackFiles(root) {
  try {
    const out = execFileSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    // npm sometimes prints non-JSON noise before/after the JSON payload; find the array.
    const jsonStart = out.indexOf("[");
    const jsonEnd = out.lastIndexOf("]");
    if (jsonStart === -1 || jsonEnd === -1) return [];
    const parsed = JSON.parse(out.slice(jsonStart, jsonEnd + 1));
    const files = [];
    for (const entry of parsed) {
      for (const f of entry.files || []) {
        if (f && f.path) files.push(f.path);
      }
    }
    return files;
  } catch {
    return [];
  }
}

function isBinaryContent(buffer) {
  const len = Math.min(buffer.length, 8000);
  for (let i = 0; i < len; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

function readAuthorEmails(root) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    const author = pkg.author;
    if (!author) return [];
    if (typeof author === "string") {
      const match = author.match(/<([^>]+)>/);
      return match ? [match[1]] : [];
    }
    if (typeof author === "object" && author.email) return [author.email];
    return [];
  } catch {
    return [];
  }
}

function collectDefaultFiles(root) {
  const set = new Set(gitLsFiles(root));
  for (const f of npmPackFiles(root)) set.add(f);
  set.delete("package-lock.json");
  return [...set].sort();
}

function scanFilesMode(root, allowEmails) {
  const files = collectDefaultFiles(root);
  const findings = [];
  for (const relPath of files) {
    if (path.basename(relPath) === "package-lock.json") continue;
    const absPath = path.join(root, relPath);
    let stat;
    try {
      stat = statSync(absPath);
    } catch {
      continue; // listed but not present on disk (e.g. a pack-only path we can't resolve)
    }
    if (!stat.isFile()) continue;
    if (stat.size > MAX_FILE_BYTES) continue;
    let buffer;
    try {
      buffer = readFileSync(absPath);
    } catch {
      continue;
    }
    if (isBinaryContent(buffer)) continue;
    const text = buffer.toString("utf8");
    for (const finding of scanText(text, { allowEmails })) {
      findings.push({ file: relPath, ...finding });
    }
  }
  return findings;
}

function parseStagedDiff(diffText) {
  // { file, line, content }[] for every added line across all hunks.
  const added = [];
  let currentFile = null;
  let newLineNum = null;
  const lines = diffText.split("\n");
  for (const rawLine of lines) {
    if (rawLine.startsWith("diff --git ")) {
      currentFile = null;
      newLineNum = null;
      continue;
    }
    if (rawLine.startsWith("+++ ")) {
      const rest = rawLine.slice(4).trim();
      currentFile = rest === "/dev/null" ? null : rest.replace(/^b\//, "");
      continue;
    }
    if (rawLine.startsWith("@@ ")) {
      const match = rawLine.match(/\+(\d+)/);
      newLineNum = match ? Number.parseInt(match[1], 10) : null;
      continue;
    }
    if (currentFile === null || newLineNum === null) continue;
    if (rawLine.startsWith("+++") || rawLine.startsWith("---")) continue;
    if (rawLine.startsWith("+")) {
      added.push({ file: currentFile, line: newLineNum, content: rawLine.slice(1) });
      newLineNum++;
    } else if (rawLine.startsWith("-")) {
      // old-file-only line; doesn't advance the new-file line counter.
    } else if (rawLine.startsWith("\\ ")) {
      // "\ No newline at end of file" marker; ignore.
    } else {
      // context line
      newLineNum++;
    }
  }
  return added;
}

function scanStagedMode(root, allowEmails) {
  const diffText = execFileSync("git", ["diff", "--cached"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const added = parseStagedDiff(diffText);
  const findings = [];
  for (const entry of added) {
    if (path.basename(entry.file) === "package-lock.json") continue;
    for (const finding of scanLine(entry.content, { allowEmails })) {
      findings.push({ file: entry.file, line: entry.line, ...finding });
    }
  }
  return findings;
}

function main() {
  const args = process.argv.slice(2);
  const staged = args.includes("--staged");
  const root = repoRoot();
  const allowEmails = readAuthorEmails(root);

  const findings = staged ? scanStagedMode(root, allowEmails) : scanFilesMode(root, allowEmails);

  if (findings.length === 0) {
    console.log("privacy-check: clean");
    return 0;
  }

  for (const finding of findings) {
    console.log(`${finding.file}:${finding.line}: ${finding.reason}: ${finding.snippet}`);
  }
  return 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.exitCode = main();
}
