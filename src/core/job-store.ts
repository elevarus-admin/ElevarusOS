import * as fs from "fs";
import * as path from "path";
import { Job } from "../models/job.model";
import { config } from "../config";
import { logger } from "./logger";
import { isSupabaseConfigured } from "./supabase-client";

/**
 * Job persistence layer.
 *
 * Three modes controlled by JOB_STORE in .env:
 *   memory   — in-process Map, lost on restart (default for quick testing)
 *   file     — one JSON file per job under JOB_STORE_PATH (simple, no deps)
 *   supabase — Postgres via Supabase (production; requires SUPABASE_URL +
 *              SUPABASE_SERVICE_KEY and migrations applied)
 */

export interface IJobStore {
  save(job: Job): Promise<void>;
  get(id: string): Promise<Job | undefined>;
  list(): Promise<Job[]>;
}

// ─── Memory store ─────────────────────────────────────────────────────────────

class MemoryJobStore implements IJobStore {
  private readonly jobs = new Map<string, Job>();

  async save(job: Job): Promise<void> {
    this.jobs.set(job.id, { ...job });
  }

  async get(id: string): Promise<Job | undefined> {
    return this.jobs.get(id);
  }

  async list(): Promise<Job[]> {
    return Array.from(this.jobs.values());
  }
}

// ─── File store ───────────────────────────────────────────────────────────────

class FileJobStore implements IJobStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  private filePath(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  async save(job: Job): Promise<void> {
    fs.writeFileSync(this.filePath(job.id), JSON.stringify(job, null, 2), "utf8");
  }

  async get(id: string): Promise<Job | undefined> {
    try {
      const raw = fs.readFileSync(this.filePath(id), "utf8");
      return JSON.parse(raw) as Job;
    } catch {
      return undefined;
    }
  }

  async list(): Promise<Job[]> {
    try {
      return fs
        .readdirSync(this.dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => {
          const raw = fs.readFileSync(path.join(this.dir, f), "utf8");
          return JSON.parse(raw) as Job;
        });
    } catch {
      return [];
    }
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createJobStore(): IJobStore {
  if (config.orchestrator.jobStore === "supabase") {
    if (!isSupabaseConfigured()) {
      throw new Error("JOB_STORE=supabase but SUPABASE_URL / SUPABASE_SERVICE_KEY are not set.");
    }
    const { SupabaseJobStore } = require("./supabase-job-store");
    logger.info("Job store: supabase", { url: config.supabase.url });
    return new SupabaseJobStore();
  }
  if (config.orchestrator.jobStore === "file") {
    logger.info("Job store: file", { path: config.orchestrator.jobStorePath });
    return new FileJobStore(config.orchestrator.jobStorePath);
  }
  logger.info("Job store: memory");
  return new MemoryJobStore();
}
