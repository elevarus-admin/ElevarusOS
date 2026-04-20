# Tools — U65 Campaign Report Bot

ElevarusOS exposes the following endpoints + integration tools this agent can call to gather data and post results.

---

## Data — Revenue (Ringba)

```
GET /api/data/ringba/revenue?instanceId=u65-reporting&period=mtd
GET /api/data/ringba/revenue?instanceId=u65-reporting&period=custom&startDate=&endDate=
```

Returns `totalCalls`, `paidCalls`, `totalRevenue`, `avgPayout`. Reads `ringba.campaignName` from this agent's `instance.md` (TODO: configure).

---

## Data — Expenses (multiple sources)

### Meta Ads
```
GET /api/data/meta/spend?instanceId=u65-reporting&period=mtd
```
Reads `meta.adAccountId` from `instance.md` (`510515032059235` — Covered Health Plans U65 Private Health). Returns `totalSpend`, `cpc`, `ctr`.

### Everflow partner payouts
Use the integration's QA tool directly (or call from the data-collection stage):

```
EverflowClient.getOfferPayouts({
  offerId: 8,
  startDate: '<YYYY-MM-DD PT>',
  endDate:   '<YYYY-MM-DD PT>',
  excludePartnerPatterns: ['INTERNAL'],
})
```

Returns `totalPayout`, `totalRevenue`, `totalConversions`, per-partner breakdown, and the list of excluded partner names.

### Tier 1 platform fee
```
import { accruedTier1Cost, tier1CostForRange } from '../../core/cost-helpers';
const cfg   = loadInstanceConfig('u65-reporting').tier1Cost!;
const today = accruedTier1Cost(cfg);              // prorated as of now
const mtd   = tier1CostForRange(cfg, '<MTD start>', '<today PT>');
```

### Google Ads (PENDING)
Requires `GOOGLE_ADS_CLIENT_ID`/`CLIENT_SECRET`/`REFRESH_TOKEN` in `.env`. See `docs/prd-google-ads-integration.md`.

### Bing Ads (PENDING)
No Microsoft Advertising integration in the repo. Requires OAuth + dev token.

---

## Action — Post to Slack

```
POST /api/actions/slack
Content-Type: application/json

{
  "channel": "cli-u65-bluejay",
  "text": "Plain text fallback (required)",
  "blocks": [ ... ]  // optional Block Kit layout
}
```

---

## Environment

| Var | Description |
|-----|-------------|
| `RINGBA_API_KEY` / `RINGBA_ACCOUNT_ID` | Revenue source |
| `META_ACCESS_TOKEN` | Meta ad-spend source — must include the U65 ad account |
| `EVERFLOW_API_KEY` | Partner payout source |
| `SLACK_BOT_TOKEN` | `xoxb-...` — must be invited to `#cli-u65-bluejay` |
