/**
 * Date / time helpers — Pacific Time (America/Los_Angeles) by default.
 *
 * Every user-facing report, every "today / yesterday / WTD / MTD / YTD"
 * range, and the current-date summary injected into the Slack bot's
 * system prompt all resolve against America/Los_Angeles. Background
 * jobs (sync workers, audit rows) still use UTC for storage — PST is a
 * presentation + semantic layer.
 *
 * Exports:
 *   todayPst()            → YYYY-MM-DD, based on current PT wall clock
 *   nowPstSummary()       → human-readable "Today is ..." line for prompts
 *   pstOffsetString(date) → "-07:00" (PDT) or "-08:00" (PST), DST-aware
 *   toPstIso(ymd, endOfDay?) → YYYY-MM-DD → full ISO with PT offset
 *   getPstDateRange(period, start?, end?) → {startDate, endDate} in YYYY-MM-DD
 *
 * All helpers use the runtime's Intl implementation — no external
 * timezone library required. Works in Node 20+.
 */

export const DEFAULT_TZ = "America/Los_Angeles";

// ─── Low-level formatters ─────────────────────────────────────────────────────

/** YYYY-MM-DD for the given Date in PT (default: now). */
export function todayPst(d: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: DEFAULT_TZ,
    year:  "numeric",
    month: "2-digit",
    day:   "2-digit",
  }).formatToParts(d);
  const y   = parts.find((p) => p.type === "year")?.value  ?? "1970";
  const m   = parts.find((p) => p.type === "month")?.value ?? "01";
  const day = parts.find((p) => p.type === "day")?.value   ?? "01";
  return `${y}-${m}-${day}`;
}

/** Weekday name (Monday..Sunday) of the given Date in PT. */
export function weekdayPst(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: DEFAULT_TZ,
    weekday:  "long",
  }).format(d);
}

/**
 * UTC offset string for PT at the given moment — "-07:00" in PDT,
 * "-08:00" in PST. Computed via Intl so DST transitions are automatic.
 */
export function pstOffsetString(d: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone:     DEFAULT_TZ,
      timeZoneName: "longOffset",
    }).formatToParts(d);
    const label = parts.find((p) => p.type === "timeZoneName")?.value;
    if (label) {
      const m = label.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
      if (m) {
        const sign = m[1];
        const hh   = (m[2] ?? "0").padStart(2, "0");
        const mm   = m[3] ?? "00";
        return `${sign}${hh}:${mm}`;
      }
    }
  } catch { /* fall through */ }

  // Fallback: compute via locale diff. Standard time offset is -08:00.
  const utcMs   = Date.UTC(
    d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
    d.getUTCHours(),    d.getUTCMinutes(), d.getUTCSeconds(),
  );
  const local   = new Date(d.toLocaleString("en-US", { timeZone: DEFAULT_TZ }));
  const diffMin = Math.round((local.getTime() - utcMs) / 60000);
  const sign    = diffMin >= 0 ? "+" : "-";
  const abs     = Math.abs(diffMin);
  const hh      = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm      = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

/** Abbreviated name — "PDT" in summer, "PST" in winter. */
export function pstAbbr(d: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone:     DEFAULT_TZ,
      timeZoneName: "short",
    }).formatToParts(d);
    return parts.find((p) => p.type === "timeZoneName")?.value ?? "PT";
  } catch {
    return "PT";
  }
}

// ─── Prompt summary ──────────────────────────────────────────────────────────

/**
 * Human-readable "Today is ..." line for the system prompt. Claude uses
 * this to interpret "today", "yesterday", "last week", etc. — always
 * anchored in PT, never UTC and never training-data-cached.
 *
 * Example output:
 *   "Today is Saturday, April 18, 2026 at 5:12 PM PDT (ISO 2026-04-18, -07:00)."
 */
export function nowPstSummary(d: Date = new Date()): string {
  const dateStr = new Intl.DateTimeFormat("en-US", {
    timeZone: DEFAULT_TZ,
    weekday:  "long",
    year:     "numeric",
    month:    "long",
    day:      "numeric",
  }).format(d);
  const timeStr = new Intl.DateTimeFormat("en-US", {
    timeZone: DEFAULT_TZ,
    hour:     "numeric",
    minute:   "2-digit",
    hour12:   true,
  }).format(d);
  const offset = pstOffsetString(d);
  const abbr   = pstAbbr(d);
  const ymd    = todayPst(d);
  return `Today is ${dateStr} at ${timeStr} ${abbr} (ISO ${ymd}, offset ${offset}). All date references below default to PT (America/Los_Angeles).`;
}

// ─── YYYY-MM-DD → ISO with PT offset ─────────────────────────────────────────

/**
 * Convert a YYYY-MM-DD date string (in PT) into a full ISO-8601 timestamp
 * with the PT offset attached. Used by tools that pass dates to Postgres
 * TIMESTAMPTZ columns — ensures "2026-04-13" means "Monday 00:00 PT",
 * not "Sunday 5pm PT" (which is what YYYY-MM-DDT00:00:00Z means in PT).
 *
 * endOfDay=true produces 23:59:59 instead of 00:00:00 — useful for
 * inclusive range upper bounds.
 */
export function toPstIso(ymd: string, endOfDay = false): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return ymd;

  // Compute the PT offset at the target midnight by picking a probe Date
  // that roughly lands in that day, then reading its PT offset. DST shifts
  // happen at 02:00 PT so midnight-anchored probes are safe on boundary days.
  const probe = new Date(`${ymd}T12:00:00Z`);
  const offset = pstOffsetString(probe);
  return endOfDay
    ? `${ymd}T23:59:59${offset}`
    : `${ymd}T00:00:00${offset}`;
}

// ─── Relative ranges ─────────────────────────────────────────────────────────

export type PstPeriod =
  | "today"
  | "yesterday"
  | "wtd"              // Monday-of-this-week (PT) through today
  | "mtd"              // 1st-of-this-month (PT) through today
  | "ytd"              // Jan 1 of this year (PT) through today
  | "last_week"        // previous Mon–Sun
  | "last_month"
  | "last_7d"
  | "last_30d"
  | "last_90d"
  | "custom";

/**
 * Return {startDate, endDate} in YYYY-MM-DD form (interpreted in PT) for
 * common reporting periods. Callers convert to ISO with toPstIso() before
 * passing to RPCs / TIMESTAMPTZ comparisons.
 *
 * Week boundary: Monday start (ISO-8601 convention).
 */
export function getPstDateRange(
  period: PstPeriod,
  start?: string,
  end?:   string,
  ref:    Date = new Date(),
): { startDate: string; endDate: string } {
  if (period === "custom") {
    if (!start || !end) {
      throw new Error("period=custom requires both start and end (YYYY-MM-DD)");
    }
    return { startDate: start, endDate: end };
  }

  const todayYmd = todayPst(ref);

  // Parse PT today into its parts, then reason about Y/M/D in PT.
  const [yStr, mStr, dStr] = todayYmd.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  const d = Number(dStr);

  // Construct a naive UTC date used purely for arithmetic — we only read
  // Y/M/D/weekday back via PT formatters so DST doesn't perturb results.
  const ptAnchor = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));

  const addDays = (from: Date, n: number): Date =>
    new Date(from.getTime() + n * 86_400_000);

  const startOfWeekPt = (anchor: Date): Date => {
    // weekdayPst returns "Monday".."Sunday" in PT
    const wd = weekdayPst(anchor);
    const daysBackMap: Record<string, number> = {
      Monday: 0, Tuesday: 1, Wednesday: 2, Thursday: 3,
      Friday: 4, Saturday: 5, Sunday: 6,
    };
    const back = daysBackMap[wd] ?? 0;
    return addDays(anchor, -back);
  };

  switch (period) {
    case "today":
      return { startDate: todayYmd, endDate: todayYmd };

    case "yesterday": {
      const y1 = todayPst(addDays(ptAnchor, -1));
      return { startDate: y1, endDate: y1 };
    }

    case "wtd": {
      const weekStart = todayPst(startOfWeekPt(ptAnchor));
      return { startDate: weekStart, endDate: todayYmd };
    }

    case "mtd":
      return { startDate: `${yStr}-${mStr}-01`, endDate: todayYmd };

    case "ytd":
      return { startDate: `${yStr}-01-01`, endDate: todayYmd };

    case "last_week": {
      const thisMon = startOfWeekPt(ptAnchor);
      const lastMon = addDays(thisMon, -7);
      const lastSun = addDays(thisMon, -1);
      return { startDate: todayPst(lastMon), endDate: todayPst(lastSun) };
    }

    case "last_month": {
      // First day of previous month, last day of previous month, in PT.
      const prevMonthYear  = m === 1 ? y - 1 : y;
      const prevMonthMonth = m === 1 ? 12    : m - 1;
      const prevMonthEndDay = new Date(Date.UTC(prevMonthYear, prevMonthMonth, 0)).getUTCDate();
      const mm = String(prevMonthMonth).padStart(2, "0");
      return {
        startDate: `${prevMonthYear}-${mm}-01`,
        endDate:   `${prevMonthYear}-${mm}-${String(prevMonthEndDay).padStart(2, "0")}`,
      };
    }

    case "last_7d":
      return { startDate: todayPst(addDays(ptAnchor, -6)),  endDate: todayYmd };
    case "last_30d":
      return { startDate: todayPst(addDays(ptAnchor, -29)), endDate: todayYmd };
    case "last_90d":
      return { startDate: todayPst(addDays(ptAnchor, -89)), endDate: todayYmd };
  }
}
