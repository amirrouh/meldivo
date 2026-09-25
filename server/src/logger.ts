import type { Request, RequestHandler, Response } from "express";

export type LogLevel = "debug" | "info" | "warn" | "error";
type LogFields = Record<string, boolean | number | string | undefined>;

const levelWeight: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const knownApiPaths = new Set([
  "/api/health",
  "/api/sessions",
  "/api/remote",
  "/api/voice/lease",
  "/api/voice/lease/heartbeat",
  "/api/voice/transcribe",
  "/api/voice/voices",
  "/api/voice/speech",
  "/api/hub/join",
  "/api/hub/codes",
  "/api/hub/machines",
]);
const forbiddenField = /(?:api.?key|auth(?:orization)?|password|token|secret|credential|code|body|content|message|text|transcript|audio|title)/i;

export type Logger = {
  debug: (event: string, fields?: LogFields) => void;
  info: (event: string, fields?: LogFields) => void;
  warn: (event: string, fields?: LogFields) => void;
  error: (event: string, fields?: LogFields) => void;
};

export function createLogger(configuredLevel = process.env.LOG_LEVEL): Logger {
  const minimumLevel = parseLevel(configuredLevel);
  const write = (level: LogLevel, event: string, fields: LogFields = {}) => {
    if (levelWeight[level] < levelWeight[minimumLevel]) return;
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      event,
      ...safeFields(fields),
    };
    const line = JSON.stringify(entry);
    if (level === "error") console.error(line);
    else console.log(line);
  };
  return {
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
  };
}

export function requestLoggingMiddleware(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const startedAt = performance.now();
    const requestId = crypto.randomUUID();
    res.locals.requestId = requestId;
    res.setHeader("X-Request-Id", requestId);
    let finished = false;
    res.once("finish", () => {
      finished = true;
      logger.info("http_request", {
        request_id: requestId,
        method: req.method,
        path: safeRequestPath(req.originalUrl.split("?")[0]),
        status: res.statusCode,
        duration_ms: elapsedMs(startedAt),
      });
    });
    res.once("close", () => {
      if (finished) return;
      logger.warn("http_request_aborted", {
        request_id: requestId,
        method: req.method,
        path: safeRequestPath(req.originalUrl.split("?")[0]),
        duration_ms: elapsedMs(startedAt),
      });
    });
    next();
  };
}

export function requestId(res: Response): string {
  return typeof res.locals.requestId === "string" ? res.locals.requestId : "unknown";
}

export function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 10) / 10;
}

function parseLevel(value: string | undefined): LogLevel {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return "info";
  if (normalized === "debug" || normalized === "info" || normalized === "warn" || normalized === "error") return normalized;
  console.warn(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "warn",
    event: "invalid_log_level",
    configured_level: "invalid",
    default_level: "info",
  }));
  return "info";
}

function safeFields(fields: LogFields): LogFields {
  return Object.fromEntries(Object.entries(fields).filter(([name, value]) => value !== undefined && !forbiddenField.test(name)));
}

function safeRequestPath(path: string): string {
  if (knownApiPaths.has(path)) return path;
  // Session keys are opaque ids; keep the route shape without them.
  const sessionRoute = path.match(/^\/api\/sessions\/[^/]+\/(chat|cancel)$/);
  if (sessionRoute) return `/api/sessions/:key/${sessionRoute[1]}`;
  if (/^\/api\/hub\/machines\/[^/]+$/.test(path)) return "/api/hub/machines/:name";
  if (path.startsWith("/api/")) return "/api/unknown";
  return path === "/" ? "/" : "/web-asset";
}
