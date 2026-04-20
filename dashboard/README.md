# ElevarusOS Dashboard

The operations dashboard for the ElevarusOS agent orchestration platform. Monitor running jobs, review blog drafts, approve content before it publishes, and track scheduled bot activity — all in one place.

**Stack**: Next.js 15 · React 19 · TypeScript · Supabase Auth · Tailwind CSS · pnpm

---

## Quick start

From the **repo root** (recommended):

```bash
make start       # ElevarusOS API on :3001 + Dashboard on :3000
```

Dashboard only:

```bash
make dashboard   # cd dashboard && pnpm dev
```

Or manually:

```bash
cd dashboard
pnpm install
pnpm dev         # http://localhost:3000
```

---

## Environment

`dashboard/.env.local`:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
SUPABASE_SERVICE_KEY=<service role key>
NEXT_PUBLIC_ELEVARUS_API_URL=http://localhost:3001
ELEVARUS_API_SECRET=          # leave blank if API_SECRET is unset in root .env
```

---

## Pages

| Page | URL | Description |
|------|-----|-------------|
| Login | `/login` | Email/password via Supabase Auth |
| Active Jobs | `/active` | Live view of running and pending jobs (polls every 15 s) |
| Scheduled | `/scheduled` | Enabled bots with cron expression and next-fire time |
| History | `/history` | Paginated job log with status and instance filters |
| Job Detail | `/jobs/:id` | Stage-by-stage timeline, output viewer, approve/reject panel |
| Agents | `/agents` | All registered bot instances and their configs |
| Settings | `/settings` | Platform settings (Phase 3) |

---

## Approving blog drafts

When a blog job reaches the `approval_notify` stage the dashboard shows an **Approve / Reject** panel on the Job Detail page. The draft text is rendered inline via react-markdown.

- **Approve** — ElevarusOS resumes the remaining stages (publish + completion)
- **Reject** — job is marked `rejected`; no content is published

Approval requests also arrive in Slack via Block Kit buttons if `SLACK_BOT_TOKEN` is configured in the root `.env`.

---

## Development

```bash
pnpm dev          # hot-reload dev server
pnpm typecheck    # TypeScript check (zero errors expected)
pnpm lint         # ESLint
pnpm build        # production build
```

## License

[MIT](LICENSE).

This dashboard was originally based on the open-source [mission-control](https://github.com/builderz-labs/mission-control) project by Builderz Labs (MIT). It has been substantially modified and extended for ElevarusOS — the LICENSE file is preserved per MIT terms.
