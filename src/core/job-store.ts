import * as fs from "fs";
import * as path from "path";
import { Job } from "../models/job.model";
import { config } from "../config";
import { logger } from "./logger";

/**
 * Lightweight job persistence layer.
 *
 * In "memory" mode, jobs are stored in-process only (lost on restart).
 * In "file" mode, each job is written as a JSON file under JOB_STORE_PATH.
 *
 * In a future version, swap this for a real database (Postgres, SQLite, etc.)
 * by implementing the same IJobStore interface.
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
  if (config.orchestrator.jobStore === "file") {
    logger.info("Job store: file", { path: config.orchestrator.jobStorePath });
    return new FileJobStore(config.orchestrator.jobStorePath);
  }
  logger.info("Job store: memory");
  return new MemoryJobStore();
}
