import assert from "node:assert/strict";
import { test } from "node:test";
import { describeTool } from "../server/src/harnesses/tool-activity.ts";

const cwd = "/tmp/fixture-project";

test("describeTool: summarizes shell commands in plain language and tracks the folder", () => {
  assert.deepEqual(describeTool("Bash", { command: "cd web && npm run build 2>&1 | tail -5" }, cwd), {
    summary: "Building the project",
    detail: "cd web && npm run build 2>&1 | tail -5",
    folder: "/tmp/fixture-project/web",
  });
  assert.equal(describeTool("bash", { command: "git status --short" }, cwd).summary, "Checking what changed");
  assert.equal(describeTool("bash", { command: "CI=1 npx vitest run" }, cwd).summary, "Running the tests");
  assert.equal(describeTool("bash", { command: "grep -rn \"a && b\" src | head" }, cwd).summary, "Searching for text");
  assert.equal(describeTool("bash", { command: "export X=1; mytool --flag" }, cwd).summary, "Running mytool");
  assert.equal(describeTool("bash", { command: "ls", workdir: "server" }, cwd).folder, "/tmp/fixture-project/server");
});

test("describeTool: file, search, and web tools across harness naming", () => {
  assert.deepEqual(describeTool("Read", { file_path: `${cwd}/src/App.tsx` }, cwd), { summary: "Reading App.tsx", detail: "src/App.tsx" });
  assert.equal(describeTool("edit", { filePath: `${cwd}/a.ts` }, cwd).summary, "Editing a.ts");
  assert.equal(describeTool("Grep", { pattern: "useEffect" }, cwd).detail, "useEffect");
  assert.equal(describeTool("WebFetch", { url: "https://example.com/docs" }, cwd).summary, "Reading a page on example.com");
  assert.equal(describeTool("mcp__server__do_thing", {}, cwd).summary, "Using do thing");
  assert.equal(describeTool("Bash", undefined, cwd).summary, "Running a command");
});

test("describeTool: long commands are clipped to one line", () => {
  const { detail } = describeTool("Bash", { command: `echo ${"x".repeat(400)}\nls` }, cwd);
  assert.ok(detail.length <= 160 && !detail.includes("\n") && detail.endsWith("…"));
});
