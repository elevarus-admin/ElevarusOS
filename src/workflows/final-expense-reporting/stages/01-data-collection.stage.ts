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
  revenue:  number;   // Ringba total revenue (USD)
  adSpend:  number;   // Meta total spend (USD)
  profit:   number;   // revenue - adSpend
  roi:      number;   // (profit / adSpend) * 100
  margin:   number;   // (profit / revenue) * 100
}

export interface DataCollectionOutput {
  rawData:      Record<string, unknown>;
  dataSource:   string;
  collectedAt:  string;
  // MTD
  ringba?:      RingbaRevenueReport;
  meta?:        MetaSpendReport;
  pl?:          ProfitLoss;
  // Today
  ringbaToday?: RingbaRevenueReport;
  metaToday?:   MetaSpendReport;
  plToday?:     ProfitLoss;
}

/**
 * Stage 1 — Data Collection (Final Expense Reporting)
 *
 * Pulls two date windows in parallel:
 *   - MTD  (Apr 1 → today)  — month-to-date totals
 *   - Today (today → today) — intraday snapshot for twice-daily runs
 *
 * Both Ringba (revenue) and Meta (spend) are pulled for each window.
 * P&L is computed for each window when both sources are available.
 *
 * instance.md config:
 *   ringba:
 *     campaignName: O&O_SOMQ_FINAL_EXPENSE
 *     reportPeriod: mtd           # drives the MTD window
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

    const cfg       = loadInstanceConfig(job.workflowType);
    const ringbaCfg = cfg.ringba;
    const metaCfg   = cfg.meta;

    // ── Date windows ────────────────────────────────────────────────────────
    const { startDate: mtdStart, endDate: mtdEnd } = ringbaCfg
      ? getDateRange(ringbaCfg.reportPeriod ?? "mtd", ringbaCfg.startDate, ringbaCfg.endDate)
      : getDateRange("mtd");

    const todayStr = new Date().toISOString().slice(0, 10);

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

    // ── Pull all four data sources in parallel ───────────────────────────────
    const [ringbaMTD, ringbaToday, metaMTD, metaToday] = await Promise.all([
      // Ringba MTD — minCallDurationSeconds=0: count all records (matches Ringba UI "Incoming")
      ringbaCfg?.campaignName
        ? getCampaignRevenue({ campaignName: ringbaCfg.campaignName, startDate: mtdStart, endDate: mtdEnd, minCallDurationSeconds: 0 })
            .catch((err) => { logger.warn("data-collection: Ringba MTD failed", { error: String(err) }); return null; })
        : Promise.resolve(null),

      // Ringba Today — minCallDurationSeconds=30: drop sub-threshold routing failures and live calls
      ringbaCfg?.campaignName
        ? getCampaignRevenue({ campaignName: ringbaCfg.campaignName, startDate: todayStr, endDate: todayStr, minCallDurationSeconds: 30 })
            .catch((err) => { logger.warn("data-collection: Ringba Today failed", { error: String(err) }); return null; })
        : Promise.resolve(null),

      // Meta MTD
      metaCfg?.adAccountId
        ? getAdAccountSpend({ adAccountId: metaCfg.adAccountId, startDate: mtdStart, endDate: mtdEnd, campaignIds: metaCfg.campaignIds })
            .catch((err) => { logger.warn("data-collection: Meta MTD failed", { error: String(err) }); return null; })
        : Promise.resolve(null),

      // Meta Today
      metaCfg?.adAccountId
        ? getAdAccountSpend({ adAccountId: metaCfg.adAccountId, startDate: todayStr, endDate: todayStr, campaignIds: metaCfg.campaignIds })
            .catch((err) => { logger.warn("data-collection: Meta Today failed", { error: String(err) }); return null; })
        : Promise.resolve(null),
    ]);

    // ── MTD metrics ──────────────────────────────────────────────────────────
    if (ringbaMTD) {
      rawData.mtdTotalCalls   = ringbaMTD.totalCalls;
      rawData.mtdPaidCalls    = ringbaMTD.paidCalls;
      rawData.mtdRevenue      = ringbaMTD.totalRevenue;
      rawData.mtdPayout       = ringbaMTD.totalPayout;
      rawData.mtdAvgPayout    = ringbaMTD.avgPayout;
      rawData.mtdCampaign     = ringbaMTD.campaignName;
      rawData.mtdDateRange    = `${mtdStart} → ${mtdEnd}`;
      if (ringbaMTD.totalCalls > 0) {
        rawData.mtdBillableRate = `${((ringbaMTD.paidCalls / ringbaMTD.totalCalls) * 100).toFixed(1)}%`;
      }
      dataSource = "ringba";
    }

    if (metaMTD) {
      rawData.mtdMetaSpend       = metaMTD.totalSpend;
      rawData.mtdMetaImpressions = metaMTD.impressions;
      rawData.mtdMetaClicks      = metaMTD.clicks;
      rawData.mtdMetaCPC         = metaMTD.cpc;
      rawData.mtdMetaCPM         = metaMTD.cpm;
      rawData.mtdMetaCTR         = metaMTD.ctr;
      if (dataSource === "ringba") dataSource = "ringba+meta";
    }

    const plMTD = this.computePL(ringbaMTD?.totalRevenue, metaMTD?.totalSpend);
    if (plMTD) {
      rawData.mtdProfit = plMTD.profit;
      rawData.mtdROI    = plMTD.roi;
      rawData.mtdMargin = plMTD.margin;
    }

    // ── Today metrics ────────────────────────────────────────────────────────
    if (ringbaToday) {
      rawData.todayTotalCalls   = ringbaToday.totalCalls;
      rawData.todayPaidCalls    = ringbaToday.paidCalls;
      rawData.todayRevenue      = ringbaToday.totalRevenue;
      rawData.todayAvgPayout    = ringbaToday.avgPayout;
      rawData.todayDate         = todayStr;
      if (ringbaToday.totalCalls > 0) {
        rawData.todayBillableRate = `${((ringbaToday.paidCalls / ringbaToday.totalCalls) * 100).toFixed(1)}%`;
      }
    }

    if (metaToday) {
      rawData.todayMetaSpend       = metaToday.totalSpend;
      rawData.todayMetaImpressions = metaToday.impressions;
      rawData.todayMetaClicks      = metaToday.clicks;
      rawData.todayMetaCPC         = metaToday.cpc;
    }

    const plToday = this.computePL(ringbaToday?.totalRevenue, metaToday?.totalSpend);
    if (plToday) {
      rawData.todayProfit = plToday.profit;
      rawData.todayROI    = plToday.roi;
      rawData.todayMargin = plToday.margin;
    }

    // ── Workspace snapshot ───────────────────────────────────────────────────
    this.writeWorkspaceSnapshot(
      job.workflowType, rawData, todayStr,
      ringbaMTD  ?? undefined, metaMTD   ?? undefined, plMTD,
      ringbaToday ?? undefined, metaToday ?? undefined, plToday,
    );

    logger.info("Data collection complete", {
      jobId:      job.id,
      dataSource,
      fieldCount: Object.keys(rawData).length,
      mtd:   { calls: ringbaMTD?.totalCalls, revenue: ringbaMTD?.totalRevenue, spend: metaMTD?.totalSpend, profit: plMTD?.profit },
      today: { calls: ringbaToday?.totalCalls, revenue: ringbaToday?.totalRevenue, spend: metaToday?.totalSpend, profit: plToday?.profit },
    });

    return {
      rawData,
      dataSource,
      collectedAt:  new Date().toISOString(),
      ringba:       ringbaMTD  ?? undefined,
      meta:         metaMTD   ?? undefined,
      pl:           plMTD,
      ringbaToday:  ringbaToday ?? undefined,
      metaToday:    metaToday ?? undefined,
      plToday,
    };
  }

  // ── P&L helper ────────────────────────────────────────────────────────────

  private computePL(revenue?: number, adSpend?: number): ProfitLoss | undefined {
    if (revenue === undefined || adSpend === undefined) return undefined;
    const profit = revenue - adSpend;
    return {
      revenue,
      adSpend,
      profit,
      roi:    adSpend  > 0 ? Math.round((profit / adSpend)  * 10000) / 100 : 0,
      margin: revenue  > 0 ? Math.round((profit / revenue)  * 10000) / 100 : 0,
    };
  }

  // ── Workspace snapshot ────────────────────────────────────────────────────

  private writeWorkspaceSnapshot(
    instanceId:  string,
    rawData:     Record<string, unknown>,
    todayStr:    string,
    ringbaMTD?:  RingbaRevenueReport,
    metaMTD?:    MetaSpendReport,
    plMTD?:      ProfitLoss,
    ringbaToday?: RingbaRevenueReport,
    metaToday?:  MetaSpendReport,
    plToday?:    ProfitLoss,
  ): void {
    try {
      const workspaceDir = path.join(process.cwd(), "src", "instances", instanceId, "workspace");
      fs.mkdirSync(workspaceDir, { recursive: true });

      const ts  = new Date().toISOString();
      const usd = (n: number) =>
        `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;

      const sections: string[] = [`# Current Report Run\n`, `**Last updated:** ${ts}`, `**Instance:** ${instanceId}\n`];

      // Today section
      sections.push(`## Today — ${todayStr}`);
      sections.push(`| Metric | Value |`, `|--------|-------|`);
      if (ringbaToday) {
        sections.push(
          `| Total Calls | ${ringbaToday.totalCalls} |`,
          `| Billable Calls | ${ringbaToday.paidCalls} (${rawData.todayBillableRate ?? "—"}) |`,
          `| Revenue | ${usd(ringbaToday.totalRevenue)} |`,
        );
      }
      if (metaToday) sections.push(`| Meta Spend | ${usd(metaToday.totalSpend)} |`);
      if (plToday)   sections.push(`| Profit | ${usd(plToday.profit)} |`, `| ROI | ${pct(plToday.roi)} |`);
      sections.push("");

      // MTD section
      const mtdStart = ringbaMTD?.startDate ?? "";
      const mtdEnd   = ringbaMTD?.endDate   ?? todayStr;
      sections.push(`## Month to Date — ${mtdStart} → ${mtdEnd}`);
      sections.push(`| Metric | Value |`, `|--------|-------|`);
      if (ringbaMTD) {
        sections.push(
          `| Total Calls | ${ringbaMTD.totalCalls} |`,
          `| Billable Calls | ${ringbaMTD.paidCalls} (${rawData.mtdBillableRate ?? "—"}) |`,
          `| Revenue | ${usd(ringbaMTD.totalRevenue)} |`,
          `| Avg Payout | ${usd(ringbaMTD.avgPayout)} |`,
        );
      }
      if (metaMTD) {
        sections.push(
          `| Meta Spend | ${usd(metaMTD.totalSpend)} |`,
          `| Impressions | ${metaMTD.impressions.toLocaleString()} |`,
          `| Clicks | ${metaMTD.clicks.toLocaleString()} |`,
          `| CPC | ${usd(metaMTD.cpc)} |`,
        );
      }
      if (plMTD) sections.push(`| Profit | ${usd(plMTD.profit)} |`, `| ROI | ${pct(plMTD.roi)} |`, `| Margin | ${plMTD.margin.toFixed(1)}% |`);
      sections.push("");

      sections.push(`## Raw Data`, "```json", JSON.stringify(rawData, null, 2), "```");
      fs.writeFileSync(path.join(workspaceDir, "WORKING.md"), sections.join("\n"), "utf8");

      // MEMORY.md — append per run
      const memPath = path.join(workspaceDir, "MEMORY.md");
      if (!fs.existsSync(memPath)) fs.writeFileSync(memPath, `# Report Run History — ${instanceId}\n`, "utf8");
      fs.appendFileSync(memPath, [
        ``,
        `## ${todayStr} — ${ts}`,
        ringbaMTD  ? `- MTD Ringba: ${ringbaMTD.totalCalls} calls / ${ringbaMTD.paidCalls} billable / ${usd(ringbaMTD.totalRevenue)}` : "- MTD Ringba: skipped",
        metaMTD    ? `- MTD Meta: ${usd(metaMTD.totalSpend)} spend` : "- MTD Meta: skipped",
        plMTD      ? `- MTD P&L: ${usd(plMTD.profit)} profit / ${pct(plMTD.roi)} ROI` : "- MTD P&L: insufficient data",
        ringbaToday ? `- Today Ringba: ${ringbaToday.totalCalls} calls / ${ringbaToday.paidCalls} billable / ${usd(ringbaToday.totalRevenue)}` : "- Today Ringba: skipped",
        metaToday  ? `- Today Meta: ${usd(metaToday.totalSpend)} spend` : "- Today Meta: skipped",
        ``,
      ].join("\n"), "utf8");

      logger.info("data-collection: workspace snapshot written", { path: workspaceDir });
    } catch (err) {
      logger.warn("data-collection: workspace snapshot failed", { error: String(err) });
    }
  }
}
