# ElevarusOS Dashboard

Next.js App Router dashboard for the ElevarusOS agent orchestration platform. Provides a UI for monitoring active jobs, reviewing job history, approving blog drafts, and managing scheduled agents.

**Stack**: Next.js 15, React 19, TypeScript 5, Supabase Auth (`@supabase/ssr`), Tailwind CSS 3, pnpm

## Prerequisites

- Node.js >= 20
- pnpm (`corepack enable` to auto-install)
- ElevarusOS API running on port 3001 (`make dev` from repo root)

## Setup

```bash
pnpm install
cp .env.local.example .env.local   # fill in Supabase credentials
pnpm dev                            # http://localhost:3000
```

Or from the repo root:

```bash
make start       # ElevarusOS API + Dashboard together
make dashboard   # Dashboard only
```

## Environment

```
NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
SUPABASE_SERVICE_KEY=<service role key>        # server-side only
NEXT_PUBLIC_ELEVARUS_API_URL=http://localhost:3001
ELEVARUS_API_SECRET=                           # must match API_SECRET in root .env
```

## Pages

| Route | Component | Notes |
|-------|-----------|-------|
| `/login` | Server page | Email/password auth via Supabase |
| `/active` | Client page | Live jobs, polls every 15 s |
| `/scheduled` | Client page | Enabled bots with next-fire time |
| `/history` | Client page | Paginated job log with filters |
| `/jobs/[jobId]` | Client page | Stage timeline, output, approve/reject |
| `/agents` | Client page | Instance card grid |
| `/settings` | Server page | Placeholder for Phase 3 |

## Key Directories

```
src/
├── app/
│   ├── (auth)/login/         Login page
│   ├── (dashboard)/          Authenticated layout with sidebar
│   │   ├── layout.tsx        Server Component — session guard + sidebar
│   │   ├── active/           Active jobs
│   │   ├── scheduled/        Scheduled bots
│   │   ├── history/          Job history
│   │   ├── jobs/[jobId]/     Job detail
│   │   ├── agents/           Agent registry
│   │   └── settings/         Settings
│   └── api/jobs/[jobId]/     Approve / Reject route handlers (proxy to API)
├── components/
│   ├── layout/               Sidebar, UserNav
│   ├── jobs/                 StatusBadge
│   └── ui/                   shadcn/ui primitives (Button, Card, Badge, …)
├── lib/
│   ├── api.ts                Typed fetch helpers for ElevarusOS API
│   ├── utils.ts              cn, formatRelativeTime, formatDuration
│   └── supabase/             client.ts (browser) + server.ts (SSR)
└── middleware.ts              Supabase session refresh + auth redirect
```

## Auth flow

1. `middleware.ts` runs on every request: refreshes Supabase session cookie; redirects unauthenticated requests to `/login?next=<path>`
2. `(dashboard)/layout.tsx` is a Server Component that double-checks the session and redirects to `/login` if missing
3. Client Components use `createBrowserClient` for any client-side auth calls (sign-out)

## Approve / Reject

The `/jobs/[jobId]` page shows an Approve/Reject panel for jobs in `awaiting_approval` status. Clicking either button calls the Next.js Route Handler (`/api/jobs/[jobId]/approve` or `.../reject`), which:

1. Verifies the Supabase session
2. Proxies the request to `POST http://localhost:3001/api/jobs/:jobId/approve` (or `/reject`)
3. Injects `x-api-key: ELEVARUS_API_SECRET` server-side (never exposed to the browser)

## Conventions

- **Package manager**: pnpm only
- **Path alias**: `@/*` maps to `./src/*`
- **Icons**: lucide-react
- **Commits**: Conventional Commits (`feat:`, `fix:`, `docs:`, etc.)
- **Typecheck**: `pnpm typecheck` (zero errors expected)
- **Lint**: `pnpm lint`
