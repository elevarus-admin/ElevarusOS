import * as fs   from "fs";
import * as path from "path";
import { IStage } from "../../../core/stage.interface";
import { Job }    from "../../../models/job.model";
import { loadInstanceConfig } from "../../../core/instance-config";
import { getCampaignRevenue, getDateRange } from "../../../integrations/ringba";
import { getAdAccountSpend } from "../../../integrations/meta";
import type { RingbaRevenueReport } from "../../../integrations/ringba";
import type { MetaSpendReport }     from "../../../integrations/meta";
import { logger } from "../../../core/logger";

export interface ProfitLoss {
  revenue:    number;   // Ringba total revenue (USD)
  adSpend:    number;   // Meta total spend (USD)
  profit:     number;   // revenue - adSpend
  roi:        number;   // (profit / adSpend) * 100  — percent return on ad spend
  margin:     number;   // (profit / revenue) * 100  — profit margin percent
}

export interface DataCollectionOutput {
  rawData:     Record<string, unknown>;
  dataSource:  string;
  collectedAt: string;
  ringba?:     RingbaRevenueReport;
  meta?:       MetaSpendReport;
  pl?:         ProfitLoss;
}

/**
 * Stage 1 — Data Collection (Final Expense Reporting)
 *
 * Pulls live data from Ringba (revenue) and Meta Ads (spend), computes P&L,
 * and writes a workspace snapshot. All three data sets are passed to the
 * analysis stage as structured rawData for Claude.
 *
 * instance.md config:
 *   ringba:
 *     campaignName: O&O_SOMQ_FINAL_EXPENSE
 *     reportPeriod: mtd           # mtd | wtd | ytd | custom
 *
 *   meta:
 *     adAccountId: "999576488367816"
 *     campaignIds: []             # empty = entire account spend
 *
 * Env vars:
 *   RINGBA_API_KEY      — API Access Token
 *   RINGBA_ACCOUNT_ID   — RA_XXXXXXXX
 *   META_ACCESS_TOKEN   — System User token from Meta Business Manager
 */
export class DataCollectionStage implements IStage {
  readonly stageName = "data-collection";

  async run(job: Job): Promise<DataCollectionOutput> {
    logger.info("Running data-collection stage", { jobId: job.id });

    const cfg = loadInstanceConfig(job.workflowType);

    // Resolve date range once — shared by both Ringba and Meta pulls
    const ringbaCfg = cfg.ringba;
    const { startDate, endDate } = ringbaCfg
      ? getDateRange(ringbaCfg.reportPeriod ?? "mtd", ringbaCfg.startDate, ringbaCfg.endDate)
      : getDateRange("mtd");

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

    // 2. Pull Ringba revenue
    let ringbaReport: RingbaRevenueReport | undefined;

    try {
      if (ringbaCfg?.campaignName) {
        const report = await getCampaignRevenue({
          campaignName: ringbaCfg.campaignName,
          startDate,
          endDate,
        });

        if (report) {
          ringbaReport = report;
          rawData.ringbaTotalCalls = report.totalCalls;
          rawData.ringbaPaidCalls  = report.paidCalls;
          rawData.ringbaRevenue    = report.totalRevenue;
          rawData.ringbaPayout     = report.totalPayout;
          rawData.ringbaAvgPayout  = report.avgPayout;
          rawData.ringbaCampaign   = report.campaignName;
          rawData.ringbaDateRange  = `${startDate} → ${endDate}`;
          dataSource = "ringba";
        }
      }
    } catch (err) {
      logger.warn("data-collection: Ringba pull failed", { jobId: job.id, error: String(err) });
    }

    // 3. Pull Meta Ads spend
    let metaReport: MetaSpendReport | undefined;

    try {
      const metaCfg = cfg.meta;
      if (metaCfg?.adAccountId) {
        const report = await getAdAccountSpend({
          adAccountId: metaCfg.adAccountId,
          startDate,
          endDate,
          campaignIds: metaCfg.campaignIds,
        });

        if (report) {
          metaReport = report;
          rawData.metaAdAccountId  = report.adAccountId;
          rawData.metaSpend        = report.totalSpend;
          rawData.metaImpressions  = report.impressions;
          rawData.metaClicks       = report.clicks;
          rawData.metaCPM          = report.cpm;
          rawData.metaCPC          = report.cpc;
          rawData.metaCTR          = report.ctr;
          rawData.metaDateRange    = `${startDate} → ${endDate}`;
          if (dataSource === "ringba") dataSource = "ringba+meta";
        }
      }
    } catch (err) {
      logger.warn("data-collection: Meta pull failed", { jobId: job.id, error: String(err) });
    }

    // 4. Compute P&L when both data sources are available
    let pl: ProfitLoss | undefined;

    if (ringbaReport && metaReport) {
      const revenue = ringbaReport.totalRevenue;
      const adSpend = metaReport.totalSpend;
      const profit  = revenue - adSpend;

      pl = {
        revenue,
        adSpend,
        profit,
        roi:    adSpend    > 0 ? Math.round((profit / adSpend)  * 10000) / 100 : 0,
        margin: revenue    > 0 ? Math.round((profit / revenue)  * 10000) / 100 : 0,
      };

      rawData.plRevenue = revenue;
      rawData.plAdSpend = adSpend;
      rawData.plProfit  = profit;
      rawData.plROI     = pl.roi;
      rawData.plMargin  = pl.margin;

      logger.info("data-collection: P&L computed", {
        jobId:    job.id,
        revenue:  `$${revenue.toFixed(2)}`,
        adSpend:  `$${adSpend.toFixed(2)}`,
        profit:   `$${profit.toFixed(2)}`,
        roi:      `${pl.roi}%`,
        margin:   `${pl.margin}%`,
      });
    }

    // 5. Write workspace snapshot
    this.writeWorkspaceSnapshot(job.workflowType, rawData, ringbaReport, metaReport, pl);

    logger.info("Data collection complete", {
      jobId:      job.id,
      dataSource,
      fieldCount: Object.keys(rawData).length,
      ringba:     ringbaReport
        ? { totalCalls: ringbaReport.totalCalls, paidCalls: ringbaReport.paidCalls, revenue: ringbaReport.totalRevenue }
        : "skipped",
      meta:       metaReport
        ? { spend: metaReport.totalSpend }
        : "skipped",
      pl:         pl ? { profit: pl.profit, roi: `${pl.roi}%` } : "skipped",
    });

    return {
      rawData,
      dataSource,
      collectedAt: new Date().toISOString(),
      ringba:      ringbaReport,
      meta:        metaReport,
      pl,
    };
  }

  // ── Workspace snapshot ────────────────────────────────────────────────────

  private writeWorkspaceSnapshot(
    instanceId: string,
    rawData:    Record<string, unknown>,
    ringba?:    RingbaRevenueReport,
    meta?:      MetaSpendReport,
    pl?:        ProfitLoss
  ): void {
    try {
      const workspaceDir = path.join(process.cwd(), "src", "instances", instanceId, "workspace");
      fs.mkdirSync(workspaceDir, { recursive: true });

      const ts      = new Date().toISOString();
      const dateStr = ts.slice(0, 10);
      const usd     = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

      // WORKING.md — current run (overwritten each time)
      const sections: string[] = [
        `# Current Report Run`,
        ``,
        `**Last updated:** ${ts}`,
        `**Instance:** ${instanceId}`,
        ``,
      ];

      // Ringba section
      if (ringba) {
        sections.push(
          `## Ringba Revenue`,
          `| Metric | Value |`,
          `|--------|-------|`,
          `| Campaign | ${ringba.campaignName} |`,
          `| Period | ${ringba.startDate} → ${ringba.endDate} |`,
          `| Total Calls | ${ringba.totalCalls} |`,
          `| Billable Calls | ${ringba.paidCalls} |`,
          `| Billable Rate | ${ringba.totalCalls > 0 ? ((ringba.paidCalls / ringba.totalCalls) * 100).toFixed(1) : "0"}% |`,
          `| Revenue | ${usd(ringba.totalRevenue)} |`,
          `| Avg Payout | ${usd(ringba.avgPayout)} |`,
          ``,
        );
      } else {
        sections.push(`## Ringba Revenue\n_Not configured_\n`);
      }

      // Meta section
      if (meta) {
        sections.push(
          `## Meta Ads Spend`,
          `| Metric | Value |`,
          `|--------|-------|`,
          `| Ad Account | ${meta.adAccountId} |`,
          `| Period | ${meta.startDate} → ${meta.endDate} |`,
          `| Total Spend | ${usd(meta.totalSpend)} |`,
          `| Impressions | ${meta.impressions.toLocaleString()} |`,
          `| Clicks | ${meta.clicks.toLocaleString()} |`,
          `| CPM | ${usd(meta.cpm)} |`,
          `| CPC | ${usd(meta.cpc)} |`,
          `| CTR | ${meta.ctr.toFixed(2)}% |`,
          ``,
        );
      } else {
        sections.push(`## Meta Ads Spend\n_Not configured or unavailable_\n`);
      }

      // P&L section
      if (pl) {
        const roiLabel  = pl.roi    >= 0 ? `+${pl.roi}%`    : `${pl.roi}%`;
        const profitLbl = pl.profit >= 0 ? usd(pl.profit)   : `-${usd(Math.abs(pl.profit))}`;
        sections.push(
          `## P&L Summary`,
          `| Metric | Value |`,
          `|--------|-------|`,
          `| Revenue (Ringba) | ${usd(pl.revenue)} |`,
          `| Ad Spend (Meta) | ${usd(pl.adSpend)} |`,
          `| **Profit** | **${profitLbl}** |`,
          `| ROI | ${roiLabel} |`,
          `| Margin | ${pl.margin}% |`,
          ``,
        );
      }

      sections.push(`## Raw Data Snapshot`, "```json", JSON.stringify(rawData, null, 2), "```");

      fs.writeFileSync(
        path.join(workspaceDir, "WORKING.md"),
        sections.join("\n"),
        "utf8"
      );

      // MEMORY.md — append one line per run
      const memPath = path.join(workspaceDir, "MEMORY.md");
      if (!fs.existsSync(memPath)) {
        fs.writeFileSync(memPath, `# Report Run History — ${instanceId}\n`, "utf8");
      }
      fs.appendFileSync(memPath, [
        ``,
        `## ${dateStr} — ${ts}`,
        ringba
          ? `- Ringba: ${ringba.totalCalls} calls / ${ringba.paidCalls} billable / ${usd(ringba.totalRevenue)} revenue`
          : `- Ringba: skipped`,
        meta
          ? `- Meta: ${usd(meta.totalSpend)} spend / ${meta.impressions.toLocaleString()} impressions`
          : `- Meta: skipped`,
        pl
          ? `- P&L: ${usd(pl.profit)} profit / ${pl.roi >= 0 ? "+" : ""}${pl.roi}% ROI / ${pl.margin}% margin`
          : `- P&L: insufficient data`,
        ``,
      ].filter(Boolean).join("\n"), "utf8");

      logger.info("data-collection: workspace snapshot written", { path: workspaceDir });
    } catch (err) {
      logger.warn("data-collection: workspace snapshot failed", { error: String(err) });
    }
  }
}
