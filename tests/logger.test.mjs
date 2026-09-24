import assert from "node:assert/strict";
import { test } from "node:test";
import { createLogger } from "../server/src/logger.ts";

test("structured logs keep operational fields and redact sensitive field names", () => {
  const output = [];
  const originalLog = console.log;
  console.log = (line) => output.push(line);
  try {
    const logger = createLogger("info");
    logger.info("upstream_response", {
      request_id: "request-123",
      provider: "llm",
      status: 200,
      duration_ms: 12.3,
      thinking_enabled: false,
      authorization: "Bearer never-log-me",
      api_key: "never-log-me",
      transcript: "never-log-me",
      audio: "never-log-me",
      request_body: "never-log-me",
    });
  } finally {
    console.log = originalLog;
  }
  const entry = JSON.parse(output[0]);
  assert.deepEqual(entry, {
    timestamp: entry.timestamp,
    level: "info",
    event: "upstream_response",
    request_id: "request-123",
    provider: "llm",
    status: 200,
    duration_ms: 12.3,
    thinking_enabled: false,
  });
  assert.doesNotMatch(output[0], /never-log-me/);
});
