/**
 * Canonical compact-format Slack report spec for scheduled reporting agents.
 *
 * ─── Why this module exists ─────────────────────────────────────────────────
 *
 * Every scheduled Slack-reporting agent (FE, U65, HVAC, ...) posts the same
 * 3-line compact shape. Previously the format was either (a) hardcoded in
 * each stage's prompt or (b) written into each agent's MISSION.md, with the
 * two sources drifting over time. This module is the single source of truth.
 *
 * ─── Format ─────────────────────────────────────────────────────────────────
 *
 *   <emoji> *SHORT* · <date>
 *   *<Period1>* · <volumeToken> · 💰 $X · 💸 $Y spend · 📊 <P&L> ROI <±XX>%
 *   *<Period2>* · <volumeToken> · 💰 $X · 💸 $Y spend · 📊 <P&L> ROI <±XX>%
 *
 * Example (FE, Today + MTD):
 *
 *   🚨 *FE* · Apr 17
 *   *Today* · 📞 20 calls, 14 billable (70.0%) · 💰 $366 · 💸 $734 spend · 📊 ($368) ROI -50%
 *   *MTD Apr 1–17* · 📞 202 calls, 71 billable (35.1%) · 💰 $2,529 · 💸 $4,972 spend · 📊 ($2,443) ROI -49%
 *
 * ─── Adding a new scheduled reporting agent ─────────────────────────────────
 *
 * In the summary stage's `userPrompt`, include:
 *
 *   import { buildCompactSlackFormatSpec } from "../../_shared/compact-slack-format";
 *   // ...
 *   userPrompt.push(buildCompactSlackFormatSpec({
 *     shortName:    "MYAGENT",
 *     alertEmoji,                                       // from analysis.alertLevel
 *     volumeToken:  "📞 <N> calls, <N> billable (<rate>%)",
 *     periodLabels: ["Today", "MTD <Mon D–D>"],
 *   }));
 *
 * The agent's MISSION.md should NOT duplicate the Slack format — mention
 * that the compact spec is injected by the stage.
 */

export interface CompactSlackFormatOptions {
  /** Agent short name — e.g. "FE", "U65", "HVAC". Goes in the header. */
  shortName:     string;
  /**
   * Alert emoji. Pass a concrete value when the analysis stage has already
   * computed `alertLevel` (use `alertEmojiFor(analysis.alertLevel)`).
   *
   * Leave undefined when the analysis stage doesn't produce an alert level —
   * the spec will use a `<emoji>` placeholder and instruct Claude to
   * substitute ✅/⚠️/🚨 based on the alertLevel it selects for the JSON
   * output. This keeps the slackMessage emoji consistent with the
   * alertLevel field without requiring a schema change on every analysis
   * stage.
   */
  alertEmoji?:   string;
  /**
   * The first metric phrase template — describes the volume domain for this
   * agent. Must be a single phrase (no commas). Examples:
   *   - `"📞 <N> calls, <N> billable (<rate>%)"` — call-driven
   *   - `"📊 <N> sessions"`                      — session-driven
   *   - `"📝 <N> leads (<conv>% conv)"`          — lead-driven
   */
  volumeToken:   string;
  /**
   * Two period labels, in order. Most agents use ["Today", "MTD <Mon D–D>"].
   * Agents with an overnight source lag (e.g. HVAC Thumbtack, where today's
   * row isn't in the sheet until tomorrow) use ["Yesterday", "MTD <Mon D–D>"].
   */
  periodLabels:  [string, string];
}

/**
 * Render the canonical compact-format spec as a Claude prompt block. The
 * caller concatenates this into the summary stage's `userPrompt`.
 *
 * Deterministic / no I/O — safe to call on every run.
 */
export function buildCompactSlackFormatSpec(opts: CompactSlackFormatOptions): string {
  const { shortName, alertEmoji, volumeToken, periodLabels } = opts;
  const [p1, p2] = periodLabels;

  // When a concrete alertEmoji is provided (analysis stage computed alertLevel),
  // hard-bake it into the header. Otherwise use a placeholder + a substitution
  // rule so Claude keeps the emoji in sync with the alertLevel it selects.
  const headerEmoji = alertEmoji ?? "<emoji>";
  const emojiSubstitutionRule = alertEmoji
    ? null
    : `- Substitute <emoji> in the header with the ACTUAL emoji matching your chosen alertLevel: ✅ for green, ⚠️ for yellow, 🚨 for red. Never leave the literal <emoji> string in the output.`;

  const lines = [
    `The slackMessage field MUST follow this exact compact format — no deviations, no extra lines:`,
    ``,
    `${headerEmoji} *${shortName}* · <date e.g. Apr 20>`,
    ``,
    `*${p1}* · ${volumeToken} · 💰 $<X,XXX> · 💸 $<X,XXX> spend · 📊 <($X,XXX) or +$X,XXX> ROI <+/-><%>`,
    `*${p2}* · ${volumeToken} · 💰 $<X,XXX> · 💸 $<X,XXX> spend · 📊 <($X,XXX) or +$X,XXX> ROI <+/-><%>`,
    ``,
    `Rules:`,
    `- Exactly 4 lines: alert header, blank line, ${p1} line, ${p2} line.`,
    `- No Trends section, no bullet points, no extra sections.`,
    `- Dollar amounts rounded to the nearest dollar (no cents) with commas: $2,529 not $2,528.74.`,
    `- Negative P&L in parentheses, no minus sign: ($1,848).`,
    `- Positive P&L with '+' prefix: +$1,234.`,
    `- ROI prefixed with '+' or '-' and integer percent: +14%, -49%.`,
    `- Alert emoji at the front of the header only — not repeated per line.`,
    `- Omit the 💸 spend and 📊 P&L tokens only if that data is null — never zero-fill.`,
    `- Use Slack mrkdwn: single *bold*, backtick code. No double-asterisk markdown.`,
    ...(emojiSubstitutionRule ? [emojiSubstitutionRule] : []),
  ];
  return lines.join("\n");
}

/** Convenience: map an alertLevel to its emoji. */
export function alertEmojiFor(alertLevel: "green" | "yellow" | "red"): string {
  if (alertLevel === "green")  return "✅";
  if (alertLevel === "yellow") return "⚠️";
  return "🚨";
}
