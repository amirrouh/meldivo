import os from "node:os";
import path from "node:path";

// Turns a harness tool call into a short, plain-language line for the voice page, using fixed
// rules only (no model call) so it is instant. Covers the tool names Claude Code, OpenCode, and
// Pi use; anything unknown falls back to the tool's own name.

export interface ToolActivity {
  /** Plain-language summary, e.g. "Running the tests". */
  summary: string;
  /** The exact command or target, shortened, e.g. "npm test" or "src/App.tsx". */
  detail?: string;
  /** Folder it runs in, with the home folder shown as "~". */
  folder?: string;
}

const MAX_DETAIL = 160;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function clip(text: string, max = MAX_DETAIL): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

export function shortPath(p: string): string {
  const home = os.homedir();
  if (home && (p === home || p.startsWith(`${home}/`))) return `~${p.slice(home.length)}`;
  return p.replace(/^(\/home\/[^/]+|\/Users\/[^/]+)(?=\/|$)/, "~");
}

function fileName(p: string | undefined): string {
  if (!p) return "a file";
  return path.basename(p.replace(/\/+$/, "")) || p;
}

function resolveFolder(cwd: string, target: string | undefined): string {
  if (!target) return cwd;
  if (target.startsWith("~")) return path.join(os.homedir(), target.slice(1));
  return path.resolve(cwd, target);
}

/** Splits a shell line into its top-level steps (`&&`, `||`, `;`, `|`), ignoring quoted text. */
function splitSteps(command: string): string[] {
  const steps: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === "\"") { current += ch + (command[i + 1] ?? ""); i++; continue; }
      current += ch;
      continue;
    }
    if (ch === "'" || ch === "\"") { quote = ch; current += ch; continue; }
    if (ch === "\n" || ch === ";" || ch === "|" || (ch === "&" && command[i + 1] === "&")) {
      if (ch !== "\n" && ch !== ";" && command[i + 1] === ch) i++;
      steps.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  steps.push(current.trim());
  return steps.filter(Boolean);
}

function words(step: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(step))) out.push(m[1] ?? m[2] ?? m[3]!);
  // Drop leading env assignments and wrappers that don't change what the step does.
  while (out.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(out[0]!) || ["sudo", "env", "time", "nohup", "exec", "command"].includes(out[0]!))) out.shift();
  return out;
}

const SCRIPT_WORDS: Record<string, string> = {
  test: "Running the tests",
  build: "Building the project",
  lint: "Checking the code style",
  dev: "Starting the dev server",
  start: "Starting the app",
  install: "Installing packages",
  ci: "Installing packages",
  typecheck: "Checking the code for mistakes",
  format: "Tidying up the code",
};

function packageManager(args: string[]): string {
  const sub = args[0];
  if (!sub) return "Running a package command";
  if (sub === "run" || sub === "run-script") return SCRIPT_WORDS[args[1] ?? ""] ?? `Running the ${args[1] ?? "project"} script`;
  if (sub === "i" || sub === "add") return args.length > 1 ? "Adding a package" : "Installing packages";
  if (sub === "uninstall" || sub === "remove" || sub === "rm") return "Removing a package";
  if (sub === "publish") return "Publishing the package";
  if (sub === "pack") return "Packaging the project";
  if (sub === "outdated" || sub === "update" || sub === "upgrade") return "Checking package updates";
  return SCRIPT_WORDS[sub] ?? `Running the ${sub} script`;
}

const GIT_WORDS: Record<string, string> = {
  status: "Checking what changed",
  diff: "Looking at the changes",
  log: "Reading the change history",
  show: "Looking at a past change",
  add: "Staging changes",
  commit: "Saving a checkpoint",
  push: "Uploading changes",
  pull: "Downloading the latest changes",
  fetch: "Checking for new changes",
  clone: "Copying a project",
  checkout: "Switching branches",
  switch: "Switching branches",
  branch: "Looking at branches",
  merge: "Combining branches",
  rebase: "Replaying changes",
  stash: "Setting changes aside",
  restore: "Undoing file changes",
  reset: "Undoing changes",
  tag: "Tagging a version",
  blame: "Checking who changed what",
  grep: "Searching the project",
  "ls-files": "Listing project files",
};

function describeStep(argv: string[]): string | undefined {
  const [prog, ...args] = argv;
  if (!prog) return undefined;
  const base = path.basename(prog);
  const firstFile = args.find((a) => !a.startsWith("-"));
  switch (base) {
    case "git": {
      const sub = args.find((a) => !a.startsWith("-"));
      return (sub && GIT_WORDS[sub]) ?? "Working with version control";
    }
    case "gh": return args[0] === "pr" ? "Working on a pull request" : args[0] === "issue" ? "Working on an issue" : "Talking to GitHub";
    case "npm": case "pnpm": case "yarn": case "bun": return packageManager(args);
    case "npx": case "pnpx": case "bunx": {
      const tool = args.find((a) => !a.startsWith("-"));
      if (tool === "tsc") return "Checking the code for mistakes";
      if (tool && /jest|vitest|mocha|playwright/.test(tool)) return "Running the tests";
      if (tool && /eslint|prettier|biome/.test(tool)) return "Checking the code style";
      return tool ? `Running ${tool}` : "Running a tool";
    }
    case "tsc": return "Checking the code for mistakes";
    case "pytest": case "jest": case "vitest": case "mocha": return "Running the tests";
    case "cargo": return args[0] === "test" ? "Running the tests" : args[0] === "build" ? "Building the project" : "Running a Rust command";
    case "go": return args[0] === "test" ? "Running the tests" : args[0] === "build" ? "Building the project" : "Running a Go command";
    case "make": return args[0] === "test" ? "Running the tests" : "Building the project";
    case "pip": case "pip3": case "uv": case "poetry": return args.includes("install") || args.includes("add") || args.includes("sync") ? "Installing packages" : "Managing Python packages";
    case "python": case "python3": case "node": case "deno": case "ruby": case "tsx": case "ts-node": {
      if (args.includes("--test") || args.some((a) => a === "pytest" || a === "unittest")) return "Running the tests";
      if (args[0] === "-c" || args[0] === "-e") return "Running a quick script";
      return firstFile ? `Running ${fileName(firstFile)}` : "Running a script";
    }
    case "bash": case "sh": case "zsh": return firstFile && firstFile !== "-c" ? `Running ${fileName(firstFile)}` : "Running a shell script";
    case "ls": case "tree": case "eza": return firstFile ? `Listing ${fileName(firstFile)}` : "Listing the files here";
    case "cat": case "less": case "more": case "bat": case "head": case "tail": return firstFile ? `Reading ${fileName(firstFile)}` : "Reading a file";
    case "sed": return args.includes("-i") ? `Editing ${fileName(args[args.length - 1])}` : `Reading ${fileName(args[args.length - 1])}`;
    case "awk": return "Pulling out text";
    case "grep": case "rg": case "ag": case "ack": return "Searching for text";
    case "find": case "fd": case "locate": return "Looking for files";
    case "wc": return "Counting lines";
    case "diff": case "cmp": return "Comparing files";
    case "mkdir": return `Creating the ${fileName(firstFile)} folder`;
    case "touch": return `Creating ${fileName(firstFile)}`;
    case "rm": case "rmdir": return firstFile ? `Deleting ${fileName(firstFile)}` : "Deleting files";
    case "mv": return "Moving files";
    case "cp": case "rsync": return "Copying files";
    case "ln": return "Linking files";
    case "chmod": case "chown": return "Changing file permissions";
    case "curl": case "wget": case "http": return "Fetching from the web";
    case "ssh": return "Connecting to another machine";
    case "scp": return "Copying files to another machine";
    case "docker": case "podman": return args[0] === "build" ? "Building a container" : args[0] === "logs" ? "Reading container logs" : "Managing containers";
    case "kubectl": return "Managing the cluster";
    case "systemctl": case "service": return args[0] === "status" ? "Checking a service" : args[0] === "restart" ? "Restarting a service" : "Managing a service";
    case "journalctl": return "Reading system logs";
    case "ps": case "top": case "htop": case "pgrep": return "Checking running programs";
    case "kill": case "pkill": case "killall": return "Stopping a program";
    case "tar": case "zip": case "unzip": case "gzip": return "Packing or unpacking files";
    case "echo": case "printf": return "Printing text";
    case "jq": return "Reading JSON data";
    case "which": case "type": case "whereis": return "Checking a program is installed";
    case "pwd": return "Checking the current folder";
    case "df": case "du": return "Checking disk space";
    case "sleep": return "Waiting a moment";
    case "open": case "xdg-open": return "Opening a file";
    case "tee": return "Writing a file";
    default: return undefined;
  }
}

const SKIPPED = new Set(["cd", "export", "source", ".", "set", "true", "unset", "pushd", "popd", "alias"]);

function describeBash(command: string, cwd: string, workdir?: string): ToolActivity {
  let folder = workdir ? resolveFolder(cwd, workdir) : cwd;
  let summary: string | undefined;
  let program: string | undefined;
  for (const step of splitSteps(command)) {
    const argv = words(step);
    if (!argv.length) continue;
    if (argv[0] === "cd" || argv[0] === "pushd") {
      if (!summary) folder = resolveFolder(folder, argv[1] ?? "~");
      continue;
    }
    if (SKIPPED.has(argv[0]!)) continue;
    program ??= path.basename(argv[0]!);
    summary = describeStep(argv);
    if (summary) break;
  }
  return {
    summary: summary ?? (program ? `Running ${program}` : "Running a command"),
    detail: clip(command),
    folder: shortPath(folder),
  };
}

/** Describes one tool call; `input` is the tool's raw arguments from the harness. */
export function describeTool(name: string, input: unknown, cwd: string): ToolActivity {
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const tool = name.toLowerCase().replace(/^mcp__.*__/, "");
  const file = str(args.file_path) ?? str(args.filePath) ?? str(args.path) ?? str(args.notebook_path);
  const here = shortPath(cwd);
  const target = (p: string | undefined) => (p ? clip(p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : shortPath(p)) : undefined);
  switch (tool) {
    case "bash": case "shell": case "exec": case "run_command": {
      const command = str(args.command) ?? str(args.cmd);
      if (!command) return { summary: "Running a command", folder: here };
      return describeBash(command, cwd, str(args.workdir) ?? str(args.cwd));
    }
    case "read": case "view": return { summary: `Reading ${fileName(file)}`, detail: target(file) };
    case "write": case "create": return { summary: `Writing ${fileName(file)}`, detail: target(file) };
    case "edit": case "multiedit": case "str_replace_editor": case "patch": case "apply_patch":
      return { summary: `Editing ${fileName(file)}`, detail: target(file) };
    case "notebookedit": return { summary: `Editing ${fileName(file)}`, detail: target(file) };
    case "glob": case "find": case "list": case "ls": {
      const pattern = str(args.pattern);
      return { summary: pattern ? "Looking for files" : "Listing the files here", detail: pattern ?? target(file), folder: here };
    }
    case "grep": case "search": {
      const pattern = str(args.pattern) ?? str(args.query);
      return { summary: "Searching the project", detail: pattern ? clip(pattern) : undefined, folder: here };
    }
    case "webfetch": case "fetch": {
      const url = str(args.url);
      let host: string | undefined;
      try { host = url ? new URL(url).hostname : undefined; } catch { host = undefined; }
      return { summary: host ? `Reading a page on ${host}` : "Reading a web page", detail: url ? clip(url) : undefined };
    }
    case "websearch": {
      const query = str(args.query);
      return { summary: "Searching the web", detail: query ? clip(query) : undefined };
    }
    case "task": case "agent": {
      const what = str(args.description);
      return { summary: "Asking a helper agent", detail: what ? clip(what) : undefined, folder: here };
    }
    case "todowrite": case "todoread": return { summary: "Updating the to-do list" };
    default: return { summary: `Using ${tool.replace(/_/g, " ")}`, folder: here };
  }
}
