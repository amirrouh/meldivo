#!/usr/bin/env node
// Meldivo CLI: install/run the hub as a user service, and talk to it once it
// is up. Plain Node ESM, no build step — this file ships as-is.

import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkgJson = JSON.parse(readFileSync(path.join(pkgRoot, "package.json"), "utf8"));
const serverEntry = path.join(pkgRoot, "dist", "server", "index.js");

const DEFAULT_PORT = 4100;
const DEFAULT_HTTPS_PORT = 4443;

function configDir() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "meldivo");
}

function stateDir() {
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(base, "meldivo");
}

function secretPath() {
  return path.join(configDir(), "secret");
}

function runtimePath() {
  return path.join(configDir(), "runtime.json");
}

function pidPath() {
  return path.join(stateDir(), "meldivo.pid");
}

function logPath() {
  return path.join(stateDir(), "meldivo.log");
}

function systemdUnitPath() {
  return path.join(os.homedir(), ".config", "systemd", "user", "meldivo.service");
}

function launchAgentPath() {
  return path.join(os.homedir(), "Library", "LaunchAgents", "dev.meldivo.plist");
}

function ensureDir(dir, mode) {
  mkdirSync(dir, { recursive: true, mode });
}

function ensureSecret() {
  ensureDir(configDir(), 0o700);
  const file = secretPath();
  if (existsSync(file)) {
    const existing = readFileSync(file, "utf8").trim();
    if (existing) return existing;
  }
  const secret = randomBytes(32).toString("hex");
  writeFileSync(file, secret, { mode: 0o600 });
  chmodSync(file, 0o600);
  return secret;
}

function readRuntime() {
  try {
    return JSON.parse(readFileSync(runtimePath(), "utf8"));
  } catch {
    return {};
  }
}

function writeRuntime(data) {
  ensureDir(configDir(), 0o700);
  writeFileSync(runtimePath(), JSON.stringify(data, null, 2), { mode: 0o600 });
}

function resolvePort() {
  return Number(process.env.MELDIVO_PORT) || readRuntime().port || DEFAULT_PORT;
}

function resolveHttpsPort() {
  return Number(process.env.MELDIVO_HTTPS_PORT) || readRuntime().httpsPort || DEFAULT_HTTPS_PORT;
}

// Settings given once (e.g. `MELDIVO_PUBLIC_URL=... meldivo start`) persist in runtime.json.
function resolvePublicUrl() {
  return (process.env.MELDIVO_PUBLIC_URL ?? readRuntime().publicUrl ?? "").replace(/\/+$/, "");
}

function resolveHost() {
  return process.env.MELDIVO_HOST ?? readRuntime().host ?? "";
}

function baseUrl() {
  return `http://127.0.0.1:${resolvePort()}`;
}

async function qrText(url) {
  const { qrText: render } = await import(pathToFileURL(path.join(pkgRoot, "dist", "server", "qr.js")).href);
  return render(url);
}

function hubUrl(secret) {
  return `${resolvePublicUrl() || baseUrl()}/#token=${encodeURIComponent(secret)}`;
}

async function printUrl(secret) {
  const url = hubUrl(secret);
  console.log(url);
  try {
    console.log(await qrText(url));
  } catch (error) {
    console.warn(`(could not render QR code: ${error instanceof Error ? error.message : String(error)})`);
  }
}

async function waitForHealth(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return await response.json();
    } catch {
      // not up yet
    }
    await sleep(300);
  }
  throw new Error(`Meldivo did not become healthy within ${timeoutMs}ms on port ${port}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasSystemdUser() {
  const result = spawnSync("systemctl", ["--user", "status"], { stdio: "ignore" });
  return result.error === undefined && result.status !== 127;
}

function serviceEnv(port, httpsPort) {
  const env = {
    MELDIVO_SECRET: ensureSecret(),
    MELDIVO_PORT: String(port),
    MELDIVO_HTTPS_PORT: String(httpsPort),
  };
  const publicUrl = resolvePublicUrl();
  if (publicUrl) env.MELDIVO_PUBLIC_URL = publicUrl;
  const host = resolveHost();
  if (host) env.MELDIVO_HOST = host;
  if (process.env.MELDIVO_MODELS_DIR) env.MELDIVO_MODELS_DIR = process.env.MELDIVO_MODELS_DIR;
  env.PATH = servicePath();
  return env;
}

// Services start with a minimal PATH, so capture the user's PATH plus the usual
// install locations; the hub must find `pi`, `opencode`, `claude`, and `node`.
function servicePath() {
  const home = os.homedir();
  const dirs = [
    path.dirname(process.execPath),
    ...(process.env.PATH ?? "").split(path.delimiter),
    path.join(home, ".local", "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".opencode", "bin"),
    path.join(home, ".claude", "local"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  return [...new Set(dirs.filter((dir) => dir && existsSync(dir)))].join(path.delimiter);
}

function installSystemdUnit(env) {
  const unitDir = path.dirname(systemdUnitPath());
  ensureDir(unitDir, 0o700);
  const envLines = Object.entries(env)
    .map(([key, value]) => `Environment="${key}=${value}"`)
    .join("\n");
  const unit = `[Unit]
Description=Meldivo voice hub
After=network.target

[Service]
Type=simple
ExecStart=${process.execPath} ${serverEntry}
${envLines}
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`;
  writeFileSync(systemdUnitPath(), unit, { mode: 0o600 });
  run("systemctl", ["--user", "daemon-reload"]);
  run("systemctl", ["--user", "enable", "--now", "meldivo.service"]);
  run("systemctl", ["--user", "restart", "meldivo.service"]); // pick up a new unit or package version
}

function installLaunchAgent(env) {
  ensureDir(path.dirname(launchAgentPath()), 0o700);
  const envEntries = Object.entries(env)
    .map(([key, value]) => `        <key>${key}</key>\n        <string>${value}</string>`)
    .join("\n");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>dev.meldivo</string>
    <key>ProgramArguments</key>
    <array>
        <string>${process.execPath}</string>
        <string>${serverEntry}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${envEntries}
    </dict>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${logPath()}</string>
    <key>StandardErrorPath</key>
    <string>${logPath()}</string>
</dict>
</plist>
`;
  ensureDir(stateDir(), 0o700);
  writeFileSync(launchAgentPath(), plist, { mode: 0o600 });
  const uid = process.getuid?.() ?? 0;
  run("launchctl", ["bootout", `gui/${uid}/dev.meldivo`]); // ignore failure if not loaded
  run("launchctl", ["bootstrap", `gui/${uid}`, launchAgentPath()]);
  run("launchctl", ["kickstart", "-k", `gui/${uid}/dev.meldivo`]);
}

function startDetached(env) {
  ensureDir(stateDir(), 0o700);
  const out = openLogFd();
  const child = spawn(process.execPath, [serverEntry], {
    env: { ...process.env, ...env },
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  writeFileSync(pidPath(), String(child.pid), { mode: 0o600 });
}

function openLogFd() {
  ensureDir(stateDir(), 0o700);
  return openSync(logPath(), "a");
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status === 0;
}

function stopSystemd() {
  run("systemctl", ["--user", "disable", "--now", "meldivo.service"]);
}

function stopLaunchAgent() {
  const uid = process.getuid?.() ?? 0;
  run("launchctl", ["bootout", `gui/${uid}/dev.meldivo`]);
}

function stopDetached() {
  if (!existsSync(pidPath())) return;
  const pid = Number(readFileSync(pidPath(), "utf8").trim());
  if (Number.isFinite(pid)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  rmSync(pidPath(), { force: true });
}

function serviceMode() {
  if (process.platform === "linux" && hasSystemdUser()) return "systemd";
  if (process.platform === "darwin") return "launchd";
  return "detached";
}

async function cmdStart(args) {
  const foreground = args.includes("--foreground");
  const port = resolvePort();
  const httpsPort = resolveHttpsPort();
  const secret = ensureSecret();
  writeRuntime({ port, httpsPort, publicUrl: resolvePublicUrl() || undefined, host: resolveHost() || undefined });

  if (foreground) {
    process.env.MELDIVO_SECRET = secret;
    process.env.MELDIVO_PORT = String(port);
    process.env.MELDIVO_HTTPS_PORT = String(httpsPort);
    const { startServer } = await import(pathToFileURL(serverEntry).href);
    const server = await startServer({ port, host: "127.0.0.1", secret, httpsPort });
    console.log(`meldivo running in the foreground on port ${server.port}`);
    await printUrl(secret);
    const shutdown = () => server.close().then(() => process.exit(0));
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return;
  }

  const env = serviceEnv(port, httpsPort);
  const mode = serviceMode();
  if (mode === "systemd") {
    installSystemdUnit(env);
    console.log("Installed and started the meldivo systemd user service.");
    console.log("To keep it running after logout: loginctl enable-linger $USER");
  } else if (mode === "launchd") {
    installLaunchAgent(env);
    console.log("Installed and started the meldivo LaunchAgent.");
  } else {
    startDetached(env);
    console.log(`Started meldivo as a background process (no user service manager found). Logs: ${logPath()}`);
  }

  await waitForHealth(port);
  console.log("meldivo is up:");
  await printUrl(secret);
}

async function cmdStop() {
  const mode = serviceMode();
  if (mode === "systemd" && existsSync(systemdUnitPath())) stopSystemd();
  else if (mode === "launchd" && existsSync(launchAgentPath())) stopLaunchAgent();
  else stopDetached();
  console.log("meldivo stopped.");
}

async function cmdStatus() {
  const port = resolvePort();
  console.log(`Config: ${configDir()}`);
  console.log(`Port: ${port}`);
  const mode = serviceMode();
  console.log(`Service manager: ${mode}`);
  if (mode === "systemd") {
    spawnSync("systemctl", ["--user", "is-active", "meldivo.service"], { stdio: "inherit" });
  } else if (mode === "launchd") {
    const uid = process.getuid?.() ?? 0;
    spawnSync("launchctl", ["print", `gui/${uid}/dev.meldivo`], { stdio: "inherit" });
  } else if (existsSync(pidPath())) {
    console.log(`pid file: ${pidPath()} (pid ${readFileSync(pidPath(), "utf8").trim()})`);
  } else {
    console.log("No detached pid file found.");
  }
  try {
    const health = await waitForHealth(port, 2_000);
    console.log(`Health: ok, speech=${JSON.stringify(health.speech)}`);
  } catch {
    console.log("Health: unreachable");
  }
}

async function cmdOpen(args) {
  const secret = ensureSecret();
  const url = hubUrl(secret);
  console.log(url);
  await printUrl(secret).then(() => {}).catch(() => {});
  if (args.includes("--browser")) openInBrowser(url);
}

function openInBrowser(url) {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawnSync(opener, [url], { stdio: "ignore" });
  } catch {
    // best effort
  }
}

async function apiCall(path_, method, secret, body) {
  const response = await fetch(`${baseUrl()}${path_}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(payload?.error ?? `Meldivo server returned ${response.status}`);
  return payload;
}

async function cmdRemote(args) {
  const secret = ensureSecret();
  const sub = args[0];
  if (!sub) {
    const info = await apiCall("/api/remote", "GET", secret);
    console.log("Remote access options:");
    for (const option of info.options) console.log(`  ${option.id}: ${option.ready ? "ready" : "not set up"} - ${option.label}`);
    console.log(info.active ? `Active: ${info.active.id} -> ${info.active.url}` : "Active: none");
    if (!info.options.some((option) => option.ready)) console.log(`Setup guide: ${info.guide}`);
    return;
  }
  if (sub === "stop") {
    await apiCall("/api/remote", "DELETE", secret);
    console.log("Remote access turned off.");
    return;
  }
  if (sub !== "tailscale" && sub !== "cloudflare" && sub !== "certificate") {
    console.error(`Unknown remote option "${sub}". Use tailscale, cloudflare, certificate, or stop.`);
    process.exitCode = 1;
    return;
  }
  const result = await apiCall("/api/remote", "POST", secret, { id: sub });
  console.log(result.url);
  console.log(await qrText(result.url));
  for (const alt of result.alternatives ?? []) console.log(`Also reachable at: ${alt}`);
}

async function cmdUninstall(args) {
  await cmdStop();
  const mode = serviceMode();
  if (mode === "systemd" && existsSync(systemdUnitPath())) rmSync(systemdUnitPath(), { force: true });
  if (mode === "launchd" && existsSync(launchAgentPath())) rmSync(launchAgentPath(), { force: true });
  if (args.includes("--purge")) {
    rmSync(configDir(), { recursive: true, force: true });
    rmSync(stateDir(), { recursive: true, force: true });
    const cacheDir = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "meldivo");
    rmSync(cacheDir, { recursive: true, force: true });
    console.log("Removed meldivo config, state, and cache.");
  }
  console.log("meldivo uninstalled.");
}

function cmdLogs() {
  const mode = serviceMode();
  if (mode === "systemd") {
    spawnSync("journalctl", ["--user", "-u", "meldivo", "-f"], { stdio: "inherit" });
    return;
  }
  const file = logPath();
  if (!existsSync(file)) {
    console.log(`No log file yet at ${file}`);
    return;
  }
  spawnSync("tail", ["-n", "200", "-f", file], { stdio: "inherit" });
}

function printHelp() {
  console.log(`meldivo ${pkgJson.version}

Usage: meldivo <command> [options]

Commands:
  start [--foreground]        Start the meldivo hub as a user service
  stop                        Stop and disable the service
  status                      Show health, speech, and service state
  open [--browser]            Print the hub URL and QR (optionally open it)
  remote [tailscale|cloudflare|certificate|stop]
                               Manage remote access
  uninstall [--purge]         Stop and remove the service (optionally wipe config/cache/state)
  logs                        Tail service logs
  --version                   Print the version
  --help                      Show this help
`);
}

async function main() {
  const [, , command, ...rest] = process.argv;
  try {
    switch (command) {
      case "start":
        await cmdStart(rest);
        break;
      case "stop":
        await cmdStop();
        break;
      case "status":
        await cmdStatus();
        break;
      case "open":
        await cmdOpen(rest);
        break;
      case "remote":
        await cmdRemote(rest);
        break;
      case "uninstall":
        await cmdUninstall(rest);
        break;
      case "logs":
        cmdLogs();
        break;
      case "--version":
      case "-v":
        console.log(pkgJson.version);
        break;
      case "--help":
      case "-h":
      case undefined:
        printHelp();
        break;
      default:
        console.error(`Unknown command "${command}"`);
        printHelp();
        process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

await main();
