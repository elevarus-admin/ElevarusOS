import cron, { ScheduledTask } from "node-cron";
import { logger } from "./logger";
import { listInstanceIds, loadInstanceConfig } from "./instance-config";

/**
 * Scheduler - runs bot instances on cron schedules using node-cron.
 *
 * Each bot instance declares its schedule in instance.md frontmatter:
 *
 *   schedule:
 *     enabled: true
 *     cron: "0 9 * * 1"      # every Monday at 9 AM UTC
 *     description: "Weekly U65 report"
 *
 * Cron format (5-field, UTC):
 *   min  hour  day  month  weekday
 *    *    *     *     *       *
 *
 * Common examples:
 *   "0 9 * * 1"         - Every Monday at 9:00 AM UTC
 *   "0 8 * * 1-5"       - Every weekday at 8:00 AM UTC
 *   "0 0 1 * *"         - First of every month at midnight UTC
 *   "0 0 * * *"         - Every day at midnight UTC (daily)
 *   "0 9,17 * * 1-5"    - Weekdays at 9 AM and 5 PM UTC
 *
 * Usage:
 *   const scheduler = new Scheduler(async (instanceId) => {
 *     const req = buildSampleRequest(instanceId);
 *     await orchestrator.submitJob(req, instanceId);
 *   });
 *   scheduler.start();   // call once at daemon startup
 *   scheduler.stop();    // call on SIGINT/SIGTERM
 */
export class Scheduler {
  private readonly tasks = new Map<string, ScheduledTask>();
  private running = false;

  /**
   * @param triggerFn  Called with the instanceId when a schedule fires.
   *                   Runs the job via the orchestrator.
   */
  constructor(
    private readonly triggerFn: (instanceId: string) => Promise<void>
  ) {}

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Load all instance configs and start cron tasks for scheduled instances. */
  start(): void {
    if (this.running) return;
    this.running = true;

    const instanceIds = listInstanceIds();
    let registered = 0;

    for (const instanceId of instanceIds) {
      try {
        const cfg = loadInstanceConfig(instanceId);
        if (!cfg.schedule.enabled || !cfg.schedule.cron) continue;

        const expression = cfg.schedule.cron;

        if (!cron.validate(expression)) {
          logger.warn("Scheduler: invalid cron expression -- skipping", {
            instanceId,
            cron: expression,
            hint: "Use standard 5-field cron: min hour day month weekday",
          });
          continue;
        }

        const task = cron.schedule(
          expression,
          () => {
            logger.info("Scheduler firing", {
              instanceId,
              cron: expression,
              description: cfg.schedule.description,
            });
            void this.triggerFn(instanceId).catch((err) => {
              logger.error("Scheduler trigger failed", {
                instanceId,
                error: String(err),
              });
            });
          },
          { timezone: "UTC" }
        );

        this.tasks.set(instanceId, task);
        registered++;

        logger.info("Scheduler registered", {
          instanceId,
          name: cfg.name,
          cron: expression,
          description: cfg.schedule.description ?? "(no description)",
        });
      } catch (err) {
        logger.warn("Scheduler: could not load instance config", {
          instanceId,
          error: String(err),
        });
      }
    }

    if (registered === 0) {
      logger.info("Scheduler started -- no scheduled instances configured");
    } else {
      logger.info(`Scheduler started -- ${registered} instance(s) scheduled`);
    }
  }

  /** Stop all scheduled tasks. */
  stop(): void {
    for (const [instanceId, task] of this.tasks) {
      task.stop();
      logger.debug("Scheduler task stopped", { instanceId });
    }
    this.tasks.clear();
    this.running = false;
    logger.info("Scheduler stopped");
  }

  // -------------------------------------------------------------------------
  // Introspection
  // -------------------------------------------------------------------------

  /** Returns the cron config for each currently registered instance. */
  getSchedule(): Array<{ instanceId: string; cron: string; description?: string }> {
    const result: Array<{ instanceId: string; cron: string; description?: string }> = [];
    for (const instanceId of this.tasks.keys()) {
      try {
        const cfg = loadInstanceConfig(instanceId);
        result.push({
          instanceId,
          cron: cfg.schedule.cron ?? "",
          description: cfg.schedule.description,
        });
      } catch {
        // skip if config disappeared at runtime
      }
    }
    return result;
  }
}
