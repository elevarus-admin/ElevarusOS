import { config } from "../config";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[config.orchestrator.logLevel];
}

function format(
  level: LogLevel,
  message: string,
  context?: Record<string, unknown>
): string {
  const ts = new Date().toISOString();
  const ctx = context ? ` ${JSON.stringify(context)}` : "";
  return `[${ts}] [${level.toUpperCase()}] ${message}${ctx}`;
}

export const logger = {
  debug(message: string, context?: Record<string, unknown>): void {
    if (shouldLog("debug")) console.debug(format("debug", message, context));
  },
  info(message: string, context?: Record<string, unknown>): void {
    if (shouldLog("info")) console.info(format("info", message, context));
  },
  warn(message: string, context?: Record<string, unknown>): void {
    if (shouldLog("warn")) console.warn(format("warn", message, context));
  },
  error(message: string, context?: Record<string, unknown>): void {
    if (shouldLog("error")) console.error(format("error", message, context));
  },
};
