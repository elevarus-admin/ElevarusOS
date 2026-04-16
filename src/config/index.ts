import * as dotenv from "dotenv";
import * as path from "path";

// Resolve .env relative to the project root (two levels up from src/config/).
// override:true ensures file values win over any empty shell exports.
dotenv.config({ path: path.resolve(__dirname, "../../.env"), override: true });

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export const config = {
  anthropic: {
    apiKey: required("ANTHROPIC_API_KEY"),
    model: optional("ANTHROPIC_MODEL", "claude-opus-4-7"),
  },

  clickup: {
    apiToken: optional("CLICKUP_API_TOKEN", ""),
    listId: optional("CLICKUP_LIST_ID", ""),
  },

  microsoft: {
    tenantId: optional("MS_TENANT_ID", ""),
    clientId: optional("MS_CLIENT_ID", ""),
    clientSecret: optional("MS_CLIENT_SECRET", ""),
    intakeMailbox: optional("MS_INTAKE_MAILBOX", ""),
    notifyFrom: optional("MS_NOTIFY_FROM", ""),
  },

  slack: {
    botToken: optional("SLACK_BOT_TOKEN", ""),
    notifyChannel: optional("SLACK_NOTIFY_CHANNEL", ""),
  },

  orchestrator: {
    pollIntervalMs: parseInt(optional("POLL_INTERVAL_MS", "60000"), 10),
    maxStageRetries: parseInt(optional("MAX_STAGE_RETRIES", "2"), 10),
    logLevel: optional("LOG_LEVEL", "info") as "debug" | "info" | "warn" | "error",
    jobStore: optional("JOB_STORE", "memory") as "memory" | "file",
    jobStorePath: optional("JOB_STORE_PATH", "./data/jobs"),
  },
} as const;
