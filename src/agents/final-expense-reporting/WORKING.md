# Working — Final Expense Campaign Report Bot

Operational status log. Updated manually when behavior is confirmed or changed. Not cleared between runs.

---

## Status

**ACTIVE**

Last confirmed working: 2026-04-17

---

## Configuration

| Setting | Value |
|---------|-------|
| Campaign | `O&O_SOMQ_FINAL_EXPENSE` |
| Meta account | `999576488367816` |
| Slack channel | `#cli-final-expense` |
| Schedule | Mon–Fri every 4h: 9am, 1pm, 5pm EST |
| Cron expression | `0 9,13,17 * * 1-5` |
| Timezone | `America/New_York` |
| Base workflow | `ppc-campaign-report` |

---

## Known Behavior

**Call duration filtering (Ringba):**
- Today window uses `minCallDurationSeconds=30` — drops sub-30s calls (routing failures, abandoned, live in-progress). This matches the Ringba UI "Billable" count for today.
- MTD window uses `minCallDurationSeconds=0` — counts all call records. This matches the Ringba UI "Incoming" total for the month.

This means Today and MTD billable rates are not directly comparable on methodology — the Today window is more conservative. This is intentional and correct.

**DRY_RUN mode:**
Set `DRY_RUN=true` in the environment to run the full workflow (data collection → analysis → summary) without posting to Slack. Output is logged and written to the workspace. Useful for testing schedule changes or prompt updates without polluting the channel.

```bash
DRY_RUN=true npm run dev
```

**--once mode:**
Run a single job directly without MC or the scheduler. Useful for local debugging.

```bash
npm run dev -- --once --bot final-expense-reporting
```

---

## Report Output

Each run writes a markdown report to:
`src/instances/final-expense-reporting/workspace/reports/YYYY-MM-DD.md`

Multiple runs on the same day overwrite the same file.

---

## Change Log

| Date | Change |
|------|--------|
| 2026-04-17 | Agent confirmed active. minCallDurationSeconds behavior documented. WORKING.md updated to operational status log format. |
| 2026-04-21 | Cadence eased from every 2h (5 runs/day) to every 4h (3 runs/day: 9am, 1pm, 5pm EST). |
