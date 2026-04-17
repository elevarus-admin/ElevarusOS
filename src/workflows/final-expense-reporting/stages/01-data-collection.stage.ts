import * as fs   from "fs";
import * as path from "path";
import { IStage } from "../../../core/stage.interface";
import { Job }    from "../../../models/job.model";
import { loadInstanceConfig } from "../../../core/instance-config";
import { getCampaignRevenue, getDateRange } from "../../../integrations/ringba";
import type { RingbaRevenueReport } from "../../../integrations/ringba";
import { logger } from "../../../core/logger";

export interface DataCollectionOutput {
  rawData:     Record<string, unknown>;
  dataSource:  string;
  collectedAt: string;
  ringba?:     RingbaRevenueReport;
}

/**
 * Stage 1 — Data Collection
 *
 * Pulls live data from configured integrations (Ringba, Meta — future), then
 * merges any additional manual metrics from the job brief.
 * Writes a raw data snapshot to the instance's workspace/ directory.
 *
 * instance.md config:
 *   ringba:
 *     campaignName: O&O_SOMQ_FINAL_EXPENSE
 *     reportPeriod: mtd           # mtd | wtd | ytd | custom
 *     startDate: ~                # used when reportPeriod = custom
 *     endDate: ~                  # used when reportPeriod = custom
 *
 * Env vars:
 *   RINGBA_API_KEY      — API Access Token from integrations/ringba
 *   RINGBA_ACCOUNT_ID   — RA_XXXXXXXX
 */
export class DataCollectionStage implements IStage {
  readonly stageName = "data-collection";

  async run(job: Job): Promise<DataCollectionOutput> {
    logger.info("Running data-collection stage", { jobId: job.id });

    // 1. Parse any manual data from brief
    let rawData: Record<string, unknown> = {};
    let dataSource = "manual";

    try {
      const parsed = JSON.parse(job.request.brief ?? "{}");
      if (typeof parsed === "object" && parsed !== null) {
        rawData    = parsed as Record<string, unknown>;
        dataSource = "brief-json";
      }
    } catch {
      rawData    = { description: job.request.brief };
      dataSource = "brief-text";
    }

    // 2. Pull Ringba data if configured in instance.md
    let ringbaReport: RingbaRevenueReport | undefined;

    try {
      const cfg       = loadInstanceConfig(job.workflowType);
      const ringbaCfg = cfg.ringba;

      if (ringbaCfg?.campaignName) {
        const { startDate, endDate } = getDateRange(
          ringbaCfg.reportPeriod ?? "mtd",
          ringbaCfg.startDate,
          ringbaCfg.endDate,
        );

        const report = await getCampaignRevenue({
          campaignName: ringbaCfg.campaignName,
          startDate,
          endDate,
        });

        if (report) {
          ringbaReport = report;
          rawData.ringbaTotalCalls   = report.totalCalls;
          rawData.ringbaPaidCalls    = report.paidCalls;
          rawData.ringbaRevenue      = report.totalRevenue;
          rawData.ringbaPayout       = report.totalPayout;
          rawData.ringbaAvgPayout    = report.avgPayout;
          rawData.ringbaCampaign     = report.campaignName;
          rawData.ringbaDateRange    = `${startDate} → ${endDate}`;
          dataSource = "ringba";
        }
      }
    } catch (err) {
      logger.warn("data-collection: Ringba pull failed — using manual data only", {
        jobId: job.id,
        error: String(err),
      });
    }

    // 3. TODO: Pull Meta Ads spend when meta integration is ready
    // import { getAdSpend } from '../../../integrations/meta';

    // 4. Write snapshot to instance workspace
    this.writeWorkspaceSnapshot(job.workflowType, rawData, ringbaReport);

    logger.info("Data collection complete", {
      jobId:      job.id,
      dataSource,
      fieldCount: Object.keys(rawData).length,
      ringba:     ringbaReport
        ? { totalCalls: ringbaReport.totalCalls, paidCalls: ringbaReport.paidCalls, revenue: ringbaReport.totalRevenue }
        : "skipped",
    });

    return {
      rawData,
      dataSource,
      collectedAt: new Date().toISOString(),
      ringba: ringbaReport,
    };
  }

  // ── Workspace snapshot ────────────────────────────────────────────────────

  private writeWorkspaceSnapshot(
    instanceId: string,
    rawData:    Record<string, unknown>,
    ringba?:    RingbaRevenueReport
  ): void {
    try {
      const workspaceDir = path.join(process.cwd(), "src", "instances", instanceId, "workspace");
      fs.mkdirSync(workspaceDir, { recursive: true });

      const ts      = new Date().toISOString();
      const dateStr = ts.slice(0, 10);

      // WORKING.md — current run (overwritten each time)
      fs.writeFileSync(path.join(workspaceDir, "WORKING.md"), [
        `# Current Report Run`,
        ``,
        `**Last updated:** ${ts}  `,
        `**Instance:** ${instanceId}`,
        ``,
        ringba ? [
          `## Ringba`,
          `| Metric | Value |`,
          `|--------|-------|`,
          `| Campaign | ${ringba.campaignName} |`,
          `| Period | ${ringba.startDate} → ${ringba.endDate} |`,
          `| Total Calls | ${ringba.totalCalls} |`,
          `| Total Billable Calls | ${ringba.paidCalls} |`,
          `| Ringba Revenue | $${ringba.totalRevenue.toLocaleString("en-US", { minimumFractionDigits: 2 })} |`,
          `| Avg Payout | $${ringba.avgPayout.toFixed(2)} |`,
        ].join("\n") : "## Ringba\n_Not configured_",
        ``,
        rawData.metaSpend
          ? `## Meta Ads\n| Metric | Value |\n|--------|-------|\n| Spend | $${rawData.metaSpend} |`
          : "",
        ``,
        `## Raw Data Snapshot`,
        "```json",
        JSON.stringify(rawData, null, 2),
        "```",
      ].filter(Boolean).join("\n"), "utf8");

      // MEMORY.md — append one line per run
      const memPath = path.join(workspaceDir, "MEMORY.md");
      if (!fs.existsSync(memPath)) {
        fs.writeFileSync(memPath, `# Report Run History — ${instanceId}\n`, "utf8");
      }
      fs.appendFileSync(memPath, [
        ``,
        `## ${dateStr} — ${ts}`,
        ringba
          ? `- Ringba: ${ringba.totalCalls} calls / ${ringba.paidCalls} billable / $${ringba.totalRevenue.toFixed(2)} revenue`
          : `- Ringba: skipped`,
        rawData.metaSpend ? `- Meta Spend: $${rawData.metaSpend}` : "",
        ``,
      ].filter(Boolean).join("\n"), "utf8");

      logger.info("data-collection: workspace snapshot written", { path: workspaceDir });
    } catch (err) {
      logger.warn("data-collection: workspace snapshot failed", { error: String(err) });
    }
  }
}
