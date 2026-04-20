/**
 * Cost helpers — pure functions over instance cost-config blocks.
 *
 * Currently exports `accruedTier1Cost(now, cfg)` for the flat-fee daily
 * platform charge that prorates across business hours.
 */

import type { InstanceTier1Cost } from "./instance-config";

/**
 * Compute the as-of accrued tier-1 cost for a single day.
 *
 *   - Before business hours start: 0
 *   - Inside business hours:       linearly prorated from 0 → dailyAmount
 *   - After business hours end:    full dailyAmount
 *
 * `referenceTime` is the moment to evaluate "as of." Defaults to now.
 *
 * Example: cfg = { dailyAmount: 367, start: 10, end: 18, tz: "America/Los_Angeles" }
 *   - 9:00 PT → 0
 *   - 14:00 PT (4 of 8 hours into business hours) → 183.50
 *   - 19:00 PT → 367
 */
export function accruedTier1Cost(
  cfg: InstanceTier1Cost,
  referenceTime: Date = new Date(),
): number {
  const fractional = currentFractionOfBusinessDay(cfg, referenceTime);
  return cfg.dailyAmount * fractional;
}

/**
 * Sum tier-1 cost across a date range — full days for any past date,
 * prorated for `today` (PT). Range is inclusive on both ends, in PT
 * YYYY-MM-DD strings.
 *
 * Skips weekends only if `skipWeekends: true` (default false; the spec
 * says "$367 per day prorated based on time of day with business hours
 * starting at 10am" — no weekend exclusion specified).
 */
export function tier1CostForRange(
  cfg: InstanceTier1Cost,
  startDate: string,
  endDate: string,
  opts: { skipWeekends?: boolean; referenceTime?: Date } = {},
): number {
  const referenceTime = opts.referenceTime ?? new Date();
  const todayPt       = ymdInTz(referenceTime, cfg.timezone);

  // Build the list of YYYY-MM-DD dates in PT
  const dates: string[] = [];
  let cursor = new Date(`${startDate}T12:00:00Z`); // noon UTC anchor avoids DST edges
  const end  = new Date(`${endDate}T12:00:00Z`);
  while (cursor.getTime() <= end.getTime()) {
    const d = ymdInTz(cursor, cfg.timezone);
    dates.push(d);
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
  }

  let total = 0;
  for (const d of dates) {
    if (opts.skipWeekends) {
      const dow = new Intl.DateTimeFormat("en-US", { timeZone: cfg.timezone, weekday: "short" })
        .format(new Date(`${d}T12:00:00Z`));
      if (dow === "Sat" || dow === "Sun") continue;
    }
    if (d < todayPt) {
      total += cfg.dailyAmount;
    } else if (d === todayPt) {
      total += accruedTier1Cost(cfg, referenceTime);
    } else {
      // Future dates accrue 0
    }
  }
  return total;
}

// ─── Internals ────────────────────────────────────────────────────────────────

/**
 * Fraction of the business day that has elapsed in `cfg.timezone` as of
 * `referenceTime`. Returns a value in [0, 1].
 */
function currentFractionOfBusinessDay(cfg: InstanceTier1Cost, referenceTime: Date): number {
  const totalHours = cfg.businessHoursEnd - cfg.businessHoursStart;
  if (totalHours <= 0) return 0;

  const tzHourMinute = hourMinuteInTz(referenceTime, cfg.timezone);
  const elapsedMin   = (tzHourMinute.hour * 60 + tzHourMinute.minute)
                     - (cfg.businessHoursStart * 60);

  if (elapsedMin <= 0) return 0;
  if (elapsedMin >= totalHours * 60) return 1;
  return elapsedMin / (totalHours * 60);
}

/** YYYY-MM-DD string for the given Date evaluated in `tz`. */
function ymdInTz(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year:  "numeric",
    month: "2-digit",
    day:   "2-digit",
  }).formatToParts(d);
  const y   = parts.find((p) => p.type === "year")?.value  ?? "1970";
  const m   = parts.find((p) => p.type === "month")?.value ?? "01";
  const day = parts.find((p) => p.type === "day")?.value   ?? "01";
  return `${y}-${m}-${day}`;
}

/** { hour, minute } in `tz` for the given Date. */
function hourMinuteInTz(d: Date, tz: string): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour:     "2-digit",
    minute:   "2-digit",
    hour12:   false,
  }).formatToParts(d);
  const h = parts.find((p) => p.type === "hour")?.value   ?? "0";
  const m = parts.find((p) => p.type === "minute")?.value ?? "0";
  // "24" wraps to "00" sometimes — normalize
  const hour = Number(h) % 24;
  return { hour, minute: Number(m) };
}
