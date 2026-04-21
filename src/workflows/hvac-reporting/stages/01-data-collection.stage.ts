import * as fs   from "fs";
import * as path from "path";
import { IStage } from "../../../core/stage.interface";
import { Job }    from "../../../models/job.model";
import { loadInstanceConfig } from "../../../core/instance-config";
import { getCampaignRevenue, getDateRange } from "../../../integrations/ringba";
import { getAdAccountSpend } from "../../../integrations/meta";
import { getSupabaseClient, isSupabaseConfigured } from "../../../core/supabase-client";
import type { RingbaRevenueReport } from "../../../integrations/ringba";
import type { MetaSpendReport }     from "../../../integrations/meta";
import { logger } from "../../../core/logger";

export interface ThumbtackReport {
  startDate:    string;
  endDate:      string;
  sessions:     number;
  owedRevenue:  number;
  rowCount:     number;
}

export interface ProfitLoss {
  revenue:  number;   // Thumbtack owedRevenue + Ringba totalRevenue
  adSpend:  number;   // Meta total spend (USD)
  profit:   number;   // revenue - adSpend
  roi:      number;   // (profit / adSpend) * 100
  margin:   number;   // (profit / revenue) * 100
}

export interface DataCollectionOutput {
  rawData:         Record<string, unknown>;
  dataSource:      string;
  collectedAt:     string;
  // MTD
  thumbtack?:      ThumbtackReport;
  ringba?:         RingbaRevenueReport;
  meta?:           MetaSpendReport;
  pl?:             ProfitLoss;
  // Yesterday
  thumbtackYday?:  ThumbtackReport;
  ringbaYday?:     RingbaRevenueReport;
  metaYday?:       MetaSpendReport;
  plYday?:         ProfitLoss;
}

/**
 * Stage 1 — Data Collection (HVAC Reporting)
 *
 * Pulls two date windows in parallel:
 *   - MTD       (1st of month → yesterday)
 *   - Yesterday (single day)
 *
 * Primary comparison is *Yesterday* (not Today) because the Thumbtack sheet
 * updates overnight — today's row isn't present until tomorrow's 9am run.
 *
 * Revenue for HVAC is the sum of two sources:
 *   - Thumbtack  — owed_revenue from `thumbtack_daily_sessions` (Supabase)
 *   - Ringba     — totalRevenue for the configured campaign (when set)
 *
 * Expense is Meta ad spend for the HVAC ad account.
 *
 * instance.md config:
 *   ringba:
 *     campaignName: <HVAC Ringba campaign exact name>   # optional
 *     reportPeriod: mtd                                 # drives the MTD window
 *   meta:
 *     adAccountId: "24568971736103024"
 *     campaignIds: []                                   # empty = entire account spend
 *
 * Env vars:
 *   SUPABASE_URL / SUPABASE_SERVICE_KEY  — Thumbtack reads
 *   RINGBA_API_KEY / RINGBA_ACCOUNT_ID   — Ringba
 *   META_ACCESS_TOKEN                    — Meta
 */
export class DataCollectionStage implements IStage {
  readonly stageName = "data-collection";

  async run(job: Job): Promise<DataCollectionOutput> {
    logger.info("Running data-collection stage", { jobId: job.id });

    const cfg       = loadInstanceConfig(job.workflowType);
    const ringbaCfg = cfg.ringba;
    const metaCfg   = cfg.meta;

    // ── Date windows ─────────────────────────────────────────────────────────
    // MTD runs from the 1st of the current month through yesterday (the
    // Thumbtack sheet hasn't populated today's row yet at 9am).
    const yesterdayStr = yesterdayIsoDate();
    const mtdStart     = firstOfMonthIsoDate();
    const mtdEnd       = yesterdayStr;

    // Ringba honours per-instance config for MTD but we force endDate=yesterday
    // so both sources line up.
    const ringbaMtd = ringbaCfg
      ? getDateRange(ringbaCfg.reportPeriod ?? "mtd", ringbaCfg.startDate, ringbaCfg.endDate)
      : { startDate: mtdStart, endDate: mtdEnd };

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

    // ── Pull all six data sources in parallel ────────────────────────────────
    const [
      thumbtackMTD, thumbtackYday,
      ringbaMTD,    ringbaYday,
      metaMTD,      metaYday,
    ] = await Promise.all([
      // Thumbtack MTD — Supabase aggregate across the window
      fetchThumbtack(mtdStart, mtdEnd)
        .catch((err) => { logger.warn("data-collection: Thumbtack MTD failed", { error: String(err) }); return null; }),

      // Thumbtack Yesterday — single day
      fetchThumbtack(yesterdayStr, yesterdayStr)
        .catch((err) => { logger.warn("data-collection: Thumbtack Yesterday failed", { error: String(err) }); return null; }),

      // Ringba MTD — counts all records (matches Ringba UI "Incoming")
      ringbaCfg?.campaignName
        ? getCampaignRevenue({
            campaignName:           ringbaCfg.campaignName,
            startDate:              ringbaMtd.startDate,
            endDate:                ringbaMtd.endDate,
            minCallDurationSeconds: 0,
          }).catch((err) => { logger.warn("data-collection: Ringba MTD failed", { error: String(err) }); return null; })
        : Promise.resolve(null),

      // Ringba Yesterday — drop sub-30s routing failures
      ringbaCfg?.campaignName
        ? getCampaignRevenue({
            campaignName:           ringbaCfg.campaignName,
            startDate:              yesterdayStr,
            endDate:                yesterdayStr,
            minCallDurationSeconds: 30,
          }).catch((err) => { logger.warn("data-collection: Ringba Yesterday failed", { error: String(err) }); return null; })
        : Promise.resolve(null),

      // Meta MTD
      metaCfg?.adAccountId
        ? getAdAccountSpend({
            adAccountId: metaCfg.adAccountId,
            startDate:   mtdStart,
            endDate:     mtdEnd,
            campaignIds: metaCfg.campaignIds,
          }).catch((err) => { logger.warn("data-collection: Meta MTD failed", { error: String(err) }); return null; })
        : Promise.resolve(null),

      // Meta Yesterday
      metaCfg?.adAccountId
        ? getAdAccountSpend({
            adAccountId: metaCfg.adAccountId,
            startDate:   yesterdayStr,
            endDate:     yesterdayStr,
            campaignIds: metaCfg.campaignIds,
          }).catch((err) => { logger.warn("data-collection: Meta Yesterday failed", { error: String(err) }); return null; })
        : Promise.resolve(null),
    ]);

    // ── MTD metrics ──────────────────────────────────────────────────────────
    if (thumbtackMTD) {
      rawData.mtdSessions           = thumbtackMTD.sessions;
      rawData.mtdThumbtackRevenue   = thumbtackMTD.owedRevenue;
      rawData.mtdThumbtackRowCount  = thumbtackMTD.rowCount;
      rawData.mtdDateRange          = `${mtdStart} → ${mtdEnd}`;
      dataSource = "thumbtack";
    }
    if (ringbaMTD) {
      rawData.mtdRingbaCalls       = ringbaMTD.totalCalls;
      rawData.mtdRingbaPaidCalls   = ringbaMTD.paidCalls;
      rawData.mtdRingbaRevenue     = ringbaMTD.totalRevenue;
      rawData.mtdRingbaCampaign    = ringbaMTD.campaignName;
      dataSource = dataSource === "thumbtack" ? "thumbtack+ringba" : "ringba";
    }
    const mtdRevenue = combineRevenue(thumbtackMTD, ringbaMTD);
    if (mtdRevenue !== undefined) rawData.mtdRevenue = mtdRevenue;

    if (metaMTD) {
      rawData.mtdMetaSpend       = metaMTD.totalSpend;
      rawData.mtdMetaImpressions = metaMTD.impressions;
      rawData.mtdMetaClicks      = metaMTD.clicks;
      rawData.mtdMetaCPC         = metaMTD.cpc;
      rawData.mtdMetaCTR         = metaMTD.ctr;
      if (dataSource !== "manual" && !dataSource.includes("meta")) dataSource = `${dataSource}+meta`;
      if (dataSource === "manual") dataSource = "meta";
    }

    const plMTD = this.computePL(mtdRevenue, metaMTD?.totalSpend);
    if (plMTD) {
      rawData.mtdProfit = plMTD.profit;
      rawData.mtdROI    = plMTD.roi;
      rawData.mtdMargin = plMTD.margin;
    }

    // ── Yesterday metrics ────────────────────────────────────────────────────
    if (thumbtackYday) {
      rawData.ydaySessions          = thumbtackYday.sessions;
      rawData.ydayThumbtackRevenue  = thumbtackYday.owedRevenue;
      rawData.ydayDate              = yesterdayStr;
    }
    if (ringbaYday) {
      rawData.ydayRingbaCalls     = ringbaYday.totalCalls;
      rawData.ydayRingbaPaidCalls = ringbaYday.paidCalls;
      rawData.ydayRingbaRevenue   = ringbaYday.totalRevenue;
    }
    const ydayRevenue = combineRevenue(thumbtackYday, ringbaYday);
    if (ydayRevenue !== undefined) rawData.ydayRevenue = ydayRevenue;

    if (metaYday) {
      rawData.ydayMetaSpend       = metaYday.totalSpend;
      rawData.ydayMetaImpressions = metaYday.impressions;
      rawData.ydayMetaClicks      = metaYday.clicks;
      rawData.ydayMetaCPC         = metaYday.cpc;
    }

    const plYday = this.computePL(ydayRevenue, metaYday?.totalSpend);
    if (plYday) {
      rawData.ydayProfit = plYday.profit;
      rawData.ydayROI    = plYday.roi;
      rawData.ydayMargin = plYday.margin;
    }

    // ── Workspace snapshot ───────────────────────────────────────────────────
    this.writeWorkspaceSnapshot(
      job.workflowType, rawData, yesterdayStr,
      thumbtackMTD  ?? undefined, ringbaMTD  ?? undefined, metaMTD  ?? undefined, plMTD,
      thumbtackYday ?? undefined, ringbaYday ?? undefined, metaYday ?? undefined, plYday,
    );

    logger.info("Data collection complete", {
      jobId:      job.id,
      dataSource,
      fieldCount: Object.keys(rawData).length,
      mtd: {
        sessions: thumbtackMTD?.sessions,
        revenue:  mtdRevenue,
        spend:    metaMTD?.totalSpend,
        profit:   plMTD?.profit,
      },
      yday: {
        sessions: thumbtackYday?.sessions,
        revenue:  ydayRevenue,
        spend:    metaYday?.totalSpend,
        profit:   plYday?.profit,
      },
    });

    return {
      rawData,
      dataSource,
      collectedAt:    new Date().toISOString(),
      thumbtack:      thumbtackMTD  ?? undefined,
      ringba:         ringbaMTD     ?? undefined,
      meta:           metaMTD       ?? undefined,
      pl:             plMTD,
      thumbtackYday:  thumbtackYday ?? undefined,
      ringbaYday:     ringbaYday    ?? undefined,
      metaYday:       metaYday      ?? undefined,
      plYday,
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
      roi:    adSpend > 0 ? Math.round((profit / adSpend)  * 10000) / 100 : 0,
      margin: revenue > 0 ? Math.round((profit / revenue)  * 10000) / 100 : 0,
    };
  }

  // ── Workspace snapshot ────────────────────────────────────────────────────

  private writeWorkspaceSnapshot(
    instanceId:     string,
    rawData:        Record<string, unknown>,
    yesterdayStr:   string,
    thumbtackMTD?:  ThumbtackReport,
    ringbaMTD?:     RingbaRevenueReport,
    metaMTD?:       MetaSpendReport,
    plMTD?:         ProfitLoss,
    thumbtackYday?: ThumbtackReport,
    ringbaYday?:    RingbaRevenueReport,
    metaYday?:      MetaSpendReport,
    plYday?:        ProfitLoss,
  ): void {
    try {
      const workspaceDir = path.join(process.cwd(), "src", "instances", instanceId, "workspace");
      fs.mkdirSync(workspaceDir, { recursive: true });

      const ts  = new Date().toISOString();
      const usd = (n: number) =>
        `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;

      const sections: string[] = [
        `# Current Report Run`, ``,
        `**Last updated:** ${ts}`,
        `**Instance:** ${instanceId}`, ``,
      ];

      // Yesterday
      sections.push(`## Yesterday — ${yesterdayStr}`);
      sections.push(`| Metric | Value |`, `|--------|-------|`);
      if (thumbtackYday) {
        sections.push(
          `| Sessions | ${thumbtackYday.sessions} |`,
          `| Thumbtack owed revenue | ${usd(thumbtackYday.owedRevenue)} |`,
        );
      } else {
        sections.push(`| Thumbtack | _data unavailable_ |`);
      }
      if (ringbaYday) {
        sections.push(
          `| Ringba calls | ${ringbaYday.totalCalls} (${ringbaYday.paidCalls} billable) |`,
          `| Ringba revenue | ${usd(ringbaYday.totalRevenue)} |`,
        );
      }
      if (metaYday) sections.push(`| Meta spend | ${usd(metaYday.totalSpend)} |`);
      if (plYday)   sections.push(`| Profit | ${usd(plYday.profit)} |`, `| ROI | ${pct(plYday.roi)} |`);
      sections.push("");

      // MTD
      const mtdStart = (rawData.mtdDateRange as string | undefined)?.split(" → ")[0] ?? "";
      const mtdEnd   = (rawData.mtdDateRange as string | undefined)?.split(" → ")[1] ?? yesterdayStr;
      sections.push(`## Month to Date — ${mtdStart} → ${mtdEnd}`);
      sections.push(`| Metric | Value |`, `|--------|-------|`);
      if (thumbtackMTD) {
        sections.push(
          `| Sessions | ${thumbtackMTD.sessions} |`,
          `| Thumbtack owed revenue | ${usd(thumbtackMTD.owedRevenue)} |`,
          `| Thumbtack rows | ${thumbtackMTD.rowCount} |`,
        );
      } else {
        sections.push(`| Thumbtack | _data unavailable_ |`);
      }
      if (ringbaMTD) {
        sections.push(
          `| Ringba calls | ${ringbaMTD.totalCalls} (${ringbaMTD.paidCalls} billable) |`,
          `| Ringba revenue | ${usd(ringbaMTD.totalRevenue)} |`,
        );
      }
      if (metaMTD) {
        sections.push(
          `| Meta spend | ${usd(metaMTD.totalSpend)} |`,
          `| Impressions | ${metaMTD.impressions.toLocaleString()} |`,
          `| Clicks | ${metaMTD.clicks.toLocaleString()} |`,
          `| CPC | ${usd(metaMTD.cpc)} |`,
        );
      }
      if (plMTD) sections.push(
        `| Profit | ${usd(plMTD.profit)} |`,
        `| ROI | ${pct(plMTD.roi)} |`,
        `| Margin | ${plMTD.margin.toFixed(1)}% |`,
      );
      sections.push("");

      sections.push(`## Raw Data`, "```json", JSON.stringify(rawData, null, 2), "```");
      fs.writeFileSync(path.join(workspaceDir, "WORKING.md"), sections.join("\n"), "utf8");

      // MEMORY.md — append per run
      const memPath = path.join(workspaceDir, "MEMORY.md");
      if (!fs.existsSync(memPath)) fs.writeFileSync(memPath, `# Report Run History — ${instanceId}\n`, "utf8");
      fs.appendFileSync(memPath, [
        ``,
        `## ${yesterdayStr} — ${ts}`,
        thumbtackMTD  ? `- MTD Thumbtack: ${thumbtackMTD.sessions} sessions / ${usd(thumbtackMTD.owedRevenue)}` : "- MTD Thumbtack: skipped",
        ringbaMTD     ? `- MTD Ringba: ${ringbaMTD.totalCalls} calls / ${usd(ringbaMTD.totalRevenue)}`         : "- MTD Ringba: skipped",
        metaMTD       ? `- MTD Meta: ${usd(metaMTD.totalSpend)} spend` : "- MTD Meta: skipped",
        plMTD         ? `- MTD P&L: ${usd(plMTD.profit)} profit / ${pct(plMTD.roi)} ROI` : "- MTD P&L: insufficient data",
        thumbtackYday ? `- Yday Thumbtack: ${thumbtackYday.sessions} sessions / ${usd(thumbtackYday.owedRevenue)}` : "- Yday Thumbtack: skipped",
        ringbaYday    ? `- Yday Ringba: ${ringbaYday.totalCalls} calls / ${usd(ringbaYday.totalRevenue)}` : "- Yday Ringba: skipped",
        metaYday      ? `- Yday Meta: ${usd(metaYday.totalSpend)} spend` : "- Yday Meta: skipped",
        ``,
      ].join("\n"), "utf8");

      logger.info("data-collection: workspace snapshot written", { path: workspaceDir });
    } catch (err) {
      logger.warn("data-collection: workspace snapshot failed", { error: String(err) });
    }
  }
}

// ─── Thumbtack (Supabase) ─────────────────────────────────────────────────────

/**
 * Sum sessions + owed_revenue from `thumbtack_daily_sessions` for the HVAC
 * feed across a closed date range. Returns null when Supabase is not
 * configured or no rows exist for the window (caller treats null as
 * "data unavailable" — never zero-fill).
 */
async function fetchThumbtack(
  startDate: string,
  endDate:   string,
): Promise<ThumbtackReport | null> {
  if (!isSupabaseConfigured()) {
    logger.warn("data-collection: Supabase not configured — skipping Thumbtack");
    return null;
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("thumbtack_daily_sessions")
    .select("day, sessions, owed_revenue")
    .eq("source", "hvac")
    .gte("day", startDate)
    .lte("day", endDate);

  if (error) {
    logger.warn("data-collection: Thumbtack query failed", { error: error.message });
    return null;
  }
  if (!data || data.length === 0) return null;

  let sessions = 0;
  let owedRevenue = 0;
  for (const row of data as Array<{ sessions: number | null; owed_revenue: number | string | null }>) {
    sessions    += Number(row.sessions ?? 0);
    owedRevenue += Number(row.owed_revenue ?? 0);
  }

  return {
    startDate,
    endDate,
    sessions,
    owedRevenue,
    rowCount: data.length,
  };
}

// ─── Revenue combiner ────────────────────────────────────────────────────────

/**
 * Combined revenue = Thumbtack owedRevenue + Ringba totalRevenue.
 * Returns undefined if BOTH sources are missing — never zero-fills.
 * If only one source has data, returns just that source's revenue.
 */
function combineRevenue(
  thumbtack: ThumbtackReport | null | undefined,
  ringba:    RingbaRevenueReport | null | undefined,
): number | undefined {
  if (!thumbtack && !ringba) return undefined;
  return (thumbtack?.owedRevenue ?? 0) + (ringba?.totalRevenue ?? 0);
}

// ─── Date helpers (UTC) ──────────────────────────────────────────────────────

function yesterdayIsoDate(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function firstOfMonthIsoDate(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}
