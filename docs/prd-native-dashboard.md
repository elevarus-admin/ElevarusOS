# PRD: ElevarusOS Native Dashboard

**Status:** Draft
**Date:** 2026-04-18
**Author:** Shane McIntyre
**Depends on:** Phase 1 of `prd-remove-mission-control.md` (MC removal must be complete before this dashboard is useful)
**Target release:** Phase 2a within 2 weeks of Phase 1 completion; Phase 2b+2c within 4 weeks

---

## Quick Reference

### Tech Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Framework | Next.js App Router (v15+) | Already chosen; SSR-compatible with Supabase Auth |
| Component library | shadcn/ui (Radix UI + Tailwind) | Unstyled primitives — fully ownable with Elevarus brand |
| Auth | Supabase Auth (`@supabase/ssr`) | Same Supabase project already in use; no new service |
| Charts | Recharts | React-native, pairs cleanly with shadcn Card wrappers |
| Tables | TanStack Table v8 | Sorting, filtering, pagination; shadcn DataTable pattern |
| Styling | Tailwind CSS v3 | Already configured in `dashboard/` |
| Cron display | `cron-parser` npm package | Client-side next-fire-time computation — no backend change |

### Env Vars

| Variable | Scope | Description |
|----------|-------|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Browser + Server | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Browser + Server | Supabase anon key (used for direct DB reads with RLS) |
| `NEXT_PUBLIC_ELEVARUS_API_URL` | Browser | Base URL of ElevarusOS API (e.g. `http://localhost:3001`) |
| `ELEVARUS_API_SECRET` | Server only | Bearer token for ElevarusOS API calls that mutate state (approve/reject). Never exposed to browser. |
| `SUPABASE_SERVICE_KEY` | Server only | Supabase service role key. For server-side routes that bypass RLS. Never exposed to browser. |

### Files to Create

| Path | Purpose |
|------|---------|
| `dashboard/src/app/(auth)/login/page.tsx` | Login page |
| `dashboard/src/app/(auth)/layout.tsx` | Unauthenticated layout (no sidebar) |
| `dashboard/src/app/(dashboard)/layout.tsx` | Authenticated layout with sidebar |
| `dashboard/src/app/(dashboard)/active/page.tsx` | Active Jobs page |
| `dashboard/src/app/(dashboard)/scheduled/page.tsx` | Scheduled Jobs page |
| `dashboard/src/app/(dashboard)/history/page.tsx` | Job History page |
| `dashboard/src/app/(dashboard)/jobs/[jobId]/page.tsx` | Job Detail page |
| `dashboard/src/app/(dashboard)/agents/page.tsx` | Agent Registry page |
| `dashboard/src/app/(dashboard)/settings/page.tsx` | Settings placeholder |
| `dashboard/src/middleware.ts` | Route protection middleware |
| `dashboard/src/lib/supabase/client.ts` | Browser Supabase client |
| `dashboard/src/lib/supabase/server.ts` | Server Supabase client (SSR) |
| `dashboard/src/lib/api.ts` | Typed fetch wrapper for ElevarusOS API |
| `dashboard/src/components/layout/sidebar.tsx` | Sidebar nav component |
| `dashboard/src/components/layout/user-nav.tsx` | User avatar + logout |
| `dashboard/src/components/jobs/status-badge.tsx` | Job status Badge |
| `dashboard/src/components/jobs/stage-timeline.tsx` | Stage record timeline |
| `dashboard/src/components/jobs/approval-panel.tsx` | Approve/Reject UI |
| `dashboard/src/components/jobs/markdown-viewer.tsx` | Markdown renderer |
| `dashboard/.env.local` | Local env vars (gitignored) |

### Files to Modify

| Path | Change |
|------|--------|
| `dashboard/package.json` | Replace OpenClaw dependencies with ElevarusOS dashboard dependencies; rename package |
| `dashboard/tailwind.config.ts` | Add Elevarus color tokens to `theme.extend.colors` |
| `dashboard/src/app/globals.css` | Add CSS variables for shadcn/ui color mapping |
| `dashboard/next.config.js` | Strip OpenClaw-specific config; keep `output: 'standalone'` |

### New API Change

One backend change required: add `offset` query parameter to `GET /api/jobs` in `src/api/server.ts` for pagination. See section 10 for spec.

### Pages Summary

| Route | Page | Primary Data Source |
|-------|------|---------------------|
| `/active` | Active Jobs | `GET /api/jobs?status=running` + `?status=awaiting_approval` |
| `/scheduled` | Scheduled Jobs | `GET /api/schedule` |
| `/history` | Job History | Supabase `jobs` table (direct, RLS) |
| `/jobs/[jobId]` | Job Detail | `GET /api/jobs/:jobId` + `GET /api/jobs/:jobId/output` |
| `/agents` | Agent Registry | `GET /api/instances` |
| `/settings` | Settings | Static placeholder |

---

## Background

The `dashboard/` directory currently contains the OpenClaw Mission Control Next.js app — an open-source agent orchestration dashboard that ElevarusOS used to rely on as its task board. Phase 1 of `prd-remove-mission-control.md` removes all MC dependencies from the ElevarusOS backend. This PRD covers Phase 2: replacing the MC task board UI with a purpose-built dashboard that is branded for Elevarus and reads directly from ElevarusOS's own data stores.

The new dashboard is a fresh Next.js App Router application written into the same `dashboard/` directory. The existing OpenClaw files will be replaced rather than incrementally modified — the apps are architecturally incompatible (OpenClaw uses SQLite + its own auth; the new dashboard uses Supabase + Supabase Auth).

---

## Architecture

### System Placement

```
Browser (Next.js Dashboard)
        │
        ├── [Supabase Auth]  ──→  Supabase Auth (session management)
        │
        ├── [Direct DB reads] ──→  Supabase PostgREST (jobs table, RLS)
        │                          • Job History pagination
        │                          • Agent Registry (instances table)
        │
        └── [API actions]  ──→  ElevarusOS API Server (port 3001)
                                 • Active job status (live)
                                 • Schedule data
                                 • Approve / Reject mutations
                                 │
                                 └──→  Supabase (service key, no RLS)
                                        • Authoritative job store
                                        • Approval state writes
```

### Data Flow Rules

- **Mutations always go through ElevarusOS API**, never direct to Supabase. The approve/reject endpoints need to resolve in-memory `ApprovalStore` callbacks — PostgREST cannot do this.
- **Historical/paginated reads go direct to Supabase** via the anon key + RLS. This avoids adding pagination logic to every API endpoint and lets TanStack Table drive query params.
- **Live status reads go through ElevarusOS API**. The `jobs` table state is authoritative in the API layer; direct Supabase reads for live status could be stale by the time the approval callback resolves.
- **`ELEVARUS_API_SECRET` is never sent to the browser**. The Next.js App Router server components and Route Handlers proxy approve/reject calls, injecting the secret server-side.

### Dashboard-to-API Auth

All calls from the dashboard to ElevarusOS API use `Authorization: Bearer <ELEVARUS_API_SECRET>`. This header is attached in the server-side API wrapper at `dashboard/src/lib/api.ts`. Client components that need to trigger actions do so via Next.js Route Handlers (`app/api/...`) which inject the secret.

The ElevarusOS API (`src/api/server.ts`) already supports `x-api-key` header auth. The dashboard sends the secret as `Authorization: Bearer` — the API server needs to accept either `x-api-key` or `Authorization: Bearer` to avoid a backend change, or the dashboard can send `x-api-key` instead. Use `x-api-key` for simplicity to match the existing server implementation.

---

## Auth Flow

### Provider

Supabase Auth with email + password login. Magic link is a nice-to-have for v1 but not required.

### Package

`@supabase/ssr` — provides `createBrowserClient` (for Client Components) and `createServerClient` (for Server Components, Server Actions, and Route Handlers). This package handles cookie-based session persistence that works with Next.js SSR.

### Supabase Auth Setup

1. In Supabase dashboard: enable Email provider under Authentication > Providers.
2. Create the operator account manually (no sign-up UI needed — this is an internal tool with a fixed user set).
3. Set `Site URL` to the dashboard domain in Supabase Auth settings.
4. Add `http://localhost:3000` to Redirect URLs for local development.

### Middleware — `dashboard/src/middleware.ts`

Next.js middleware runs on every request before rendering. It refreshes the Supabase session cookie and redirects unauthenticated users to `/login`.

```
Protected routes:  /active, /scheduled, /history, /jobs/*, /agents, /settings
Public routes:     /login, /api/auth/* (Supabase auth callbacks)
```

Middleware pattern using `@supabase/ssr`:

```
createServerClient(url, anonKey, { cookies: { get, set, remove } })
  → supabase.auth.getUser()
  → if no user AND path is not /login: redirect to /login?next=<currentPath>
  → if user AND path is /login: redirect to /active
```

The `next` query param on the login redirect is used post-login to send the user back to the page they were trying to reach.

### Login Page — `/login`

Route: `dashboard/src/app/(auth)/login/page.tsx`

Layout: centered card on a `#155263` (deep teal) background. Elevarus logo at top of card. Email + password fields. "Sign in" submit button in `#04BF7E` (emerald). No "Create account" link — operator accounts are provisioned manually.

On submit: call `supabase.auth.signInWithPassword({ email, password })`. On success, redirect to `next` query param or `/active`. On error, show inline error message using shadcn Alert component.

### Session Storage

`@supabase/ssr` stores the session in HTTP-only cookies. No `localStorage`. The `middleware.ts` file refreshes the session token on each request using `supabase.auth.getUser()` — this keeps the session alive for active users without requiring explicit refresh calls in components.

### Logout

User menu at the bottom of the sidebar calls `supabase.auth.signOut()`, then redirects to `/login`.

---

## Tailwind Theme Config

### `dashboard/tailwind.config.ts` — Color Extension

```ts
theme: {
  extend: {
    colors: {
      brand: {
        sidebar:  '#155263',   // deep teal — sidebar/header bg
        primary:  '#04BF7E',   // emerald green — CTA, active states
        navy:     '#16163F',   // deep navy — headings
        body:     '#0C0D0E',   // body text
        muted:    '#657278',   // secondary text
        surface:  '#F5F5F5',   // card backgrounds
        bg:       '#FFFFFF',   // page background
      },
    },
  },
},
```

### `dashboard/src/app/globals.css` — shadcn CSS Variables

shadcn/ui reads these CSS variables for its component color system. Map Elevarus brand tokens onto the shadcn variable names so all shadcn components automatically use the Elevarus palette.

```css
@layer base {
  :root {
    --background:        0 0% 100%;          /* #FFFFFF */
    --foreground:        240 5% 6%;          /* #0C0D0E */

    --card:              0 0% 96%;           /* #F5F5F5 */
    --card-foreground:   240 5% 6%;

    --popover:           0 0% 100%;
    --popover-foreground: 240 5% 6%;

    --primary:           158 98% 38%;        /* #04BF7E */
    --primary-foreground: 0 0% 100%;

    --secondary:         0 0% 96%;
    --secondary-foreground: 240 5% 6%;

    --muted:             210 4% 55%;         /* #657278 */
    --muted-foreground:  210 4% 55%;

    --accent:            190 61% 22%;        /* #155263 */
    --accent-foreground: 0 0% 100%;

    --destructive:       0 84% 60%;
    --destructive-foreground: 0 0% 100%;

    --border:            210 10% 88%;
    --input:             210 10% 88%;
    --ring:              158 98% 38%;        /* #04BF7E — focus ring */

    --radius: 0.5rem;

    /* Sidebar-specific tokens */
    --sidebar-bg:        190 61% 22%;        /* #155263 */
    --sidebar-fg:        0 0% 100%;
    --sidebar-active-bg: 158 98% 38%;        /* #04BF7E */
    --sidebar-muted:     190 30% 55%;
  }
}
```

---

## Layout

### Route Groups

```
dashboard/src/app/
  (auth)/
    login/page.tsx          — no sidebar
    layout.tsx              — bare layout, teal background
  (dashboard)/
    layout.tsx              — sidebar + main content area
    active/page.tsx
    scheduled/page.tsx
    history/page.tsx
    jobs/[jobId]/page.tsx
    agents/page.tsx
    settings/page.tsx
```

### Sidebar — `dashboard/src/components/layout/sidebar.tsx`

Background: `bg-brand-sidebar` (`#155263`)

Structure (top to bottom):

```
┌─────────────────────────────┐
│  [Logo]  Elevarus            │  ← elevarus-logo.webp, 32px tall
│  OS Dashboard               │
├─────────────────────────────┤
│  ⬤ Active Jobs              │  ← badge showing count of running+awaiting
│    Scheduled                │
│    Job History              │
│    Agents                   │
│    Settings                 │
├─────────────────────────────┤
│  [Avatar] shane@elevarus.com│  ← bottom of sidebar
│  [Sign out]                 │
└─────────────────────────────┘
```

Logo: `<img src="https://elevarus.com/wp-content/uploads/2023/12/elevarus-logo.webp" alt="Elevarus" />`

Active nav item: `bg-brand-primary` (`#04BF7E`) text, or left border accent. Non-active items: `text-white/80` hover `text-white`.

The "Active Jobs" nav item shows a live badge with the count of `running + awaiting_approval` jobs. This count is fetched client-side on mount and refreshed every 15 seconds (same interval as the Active Jobs page).

**Responsive:** On mobile (< `lg` breakpoint), sidebar collapses to a hamburger menu. Use shadcn Sheet component for the mobile drawer. Desktop sidebar is fixed-width (`w-64`).

### shadcn/ui Sidebar Component

Use the shadcn `sidebar` component as the structural base (`npx shadcn add sidebar`). Override CSS variables as defined in `globals.css` to apply Elevarus colors without forking the component source.

### Main Content Area

`bg-brand-bg` (`#FFFFFF`). Max width: `max-w-7xl mx-auto px-6 py-8`. Page titles use `text-brand-navy font-semibold text-2xl`.

---

## Page Specifications

### 5.1 Active Jobs — `/active`

**Purpose:** Real-time view of all jobs currently executing or awaiting human approval. Primary operational screen.

**Data source:**

Two parallel requests on mount and every 15 seconds:
- `GET /api/jobs?status=running`
- `GET /api/jobs?status=awaiting_approval`

Results merged and sorted by `createdAt DESC`.

**Columns (TanStack Table):**

| Column | Source field | Notes |
|--------|-------------|-------|
| Instance | `workflowType` | Render as a pill/badge in muted teal |
| Title | `request.title` | Truncate at 60 chars with tooltip |
| Status | `status` | `StatusBadge` component — see component inventory |
| Current Stage | `currentStage` | From API response; null if not yet started |
| Progress | `completedStages / totalStages` | shadcn Progress bar |
| Started | `createdAt` | Relative time (e.g. "3 min ago") |
| Approver | `request.approver` | Only shown for blog workflow types |
| Actions | — | Approve + Reject buttons; only rendered for `awaiting_approval` rows |

**Interactions:**

- Clicking any row navigates to `/jobs/[jobId]`
- Approve / Reject buttons on `awaiting_approval` rows trigger the approval flow (see section 8)
- Auto-refresh every 15 seconds via `setInterval` — a subtle "Last updated X seconds ago" indicator in the top-right corner of the table

**Empty state:** "No active jobs. All agents are idle." with a muted icon.

**Loading state:** Table skeleton with 3 rows using shadcn Skeleton components.

**Error state:** shadcn Alert (destructive) with the error message and a Retry button.

---

### 5.2 Scheduled Jobs — `/scheduled`

**Purpose:** Shows all instances with scheduling enabled, their next fire times, and last run outcomes.

**Data source:**

- `GET /api/schedule` — returns all scheduled instances with `instanceId`, `cron`, `description`, `timezone`
- `GET /api/bots` — fetches `stats.lastJobStatus` and `stats.lastJobAt` per instance for "Last Run" columns

Both requests on mount. No auto-refresh needed (schedule data changes only on ElevarusOS restart).

**Next fire time computation:**

Computed client-side using the `cron-parser` npm package:

```
import { parseExpression } from 'cron-parser'
const interval = parseExpression(cronExpression, { tz: timezone || 'UTC' })
const nextFire = interval.next().toDate()
```

Render as absolute datetime with relative label (e.g. "Today at 3:00 PM — in 47 min").

**Columns:**

| Column | Source | Notes |
|--------|--------|-------|
| Instance | `instanceId` | Linkable to `/agents` filtered to this instance |
| Schedule Description | `description` | From `GET /api/schedule` |
| Cron Expression | `cron` | Monospace font |
| Next Fire | computed | Absolute + relative |
| Last Run Status | `stats.lastJobStatus` | `StatusBadge` |
| Last Run At | `stats.lastJobAt` | Relative time |

**Empty state:** "No scheduled instances configured."

**Loading state:** Skeleton rows.

---

### 5.3 Job History — `/history`

**Purpose:** Paginated, filterable audit log of all jobs.

**Data source:**

Supabase direct query using the anon key with RLS. Query the `jobs` table:

```sql
SELECT
  id,
  workflow_type,
  status,
  request->>'title'    AS title,
  created_at,
  updated_at,
  completed_at,
  error
FROM jobs
ORDER BY created_at DESC
LIMIT :limit OFFSET :offset
```

Filter clauses appended conditionally:
- Instance filter: `WHERE workflow_type = :instanceId`
- Status filter: `WHERE status = :status`
- Date range: `WHERE created_at BETWEEN :from AND :to`

Total count via separate `SELECT COUNT(*) FROM jobs WHERE <same filters>`.

Use the Supabase JS client's `.from('jobs').select(...)` with `.range(from, to)` for pagination.

**Filters (shown above table):**

- Instance dropdown: populated from `GET /api/instances` on mount; "All instances" default
- Status dropdown: `queued | running | awaiting_approval | approved | completed | failed | all`
- Date range: two shadcn DatePicker inputs (from / to); default: last 30 days
- Apply button triggers re-query; filter state persisted in URL search params

**Columns:**

| Column | Source | Notes |
|--------|--------|-------|
| Job ID | `id` | First 8 chars, monospace; full UUID in tooltip |
| Instance | `workflow_type` | Badge |
| Title | `request->>'title'` | Truncated |
| Status | `status` | `StatusBadge` |
| Created | `created_at` | Relative time |
| Completed | `completed_at` | Relative, null if not done |
| Duration | `completed_at - created_at` | Formatted as "1m 23s"; null if not done |

**Pagination:** shadcn Pagination component. 25 rows per page default. Page state in URL (`?page=2`).

**Interactions:** Clicking any row navigates to `/jobs/[jobId]`.

**Empty state:** "No jobs found matching your filters."

**Loading state:** Skeleton table rows while query runs.

---

### 5.4 Job Detail — `/jobs/[jobId]`

**Purpose:** Full inspection view for a single job — stage timeline, outputs, and approval controls.

**Data source:**

Two parallel requests on mount:
- `GET /api/jobs/:jobId` — metadata, stage records, approval state
- `GET /api/jobs/:jobId/output` — full stage outputs

**Layout (top to bottom):**

```
[ Job Title ]                          [ Status Badge ]  [ Instance Badge ]
Created: ...  |  Duration: ...  |  Approver: ...

[ Stage Timeline ]
[ Output Panel ]
[ Approval Panel ]  ← only shown for blog workflows
```

**Stage Timeline (`dashboard/src/components/jobs/stage-timeline.tsx`):**

One row per `StageRecord` in `job.stages`:

| Field | Display |
|-------|---------|
| Stage name | Human-readable label (title-case of `stage.name`) |
| Status | Colored icon: check (completed), spinner (running), x (failed), dash (pending/skipped) |
| Started at | Absolute time |
| Duration | `completedAt - startedAt`, formatted |
| Attempts | Only shown if `> 1` — renders as "2 attempts" badge in amber |
| Error | Collapsed accordion; expands on click; only shown if `stage.error` is set |

**Output Panel:**

Rendered conditionally by workflow type, detected from `job.workflowType`:

- **Reporting workflows** (`baseWorkflow = "ppc-campaign-report"`): render `output.report` (maps to `stages.summary.markdownReport`) in `MarkdownViewer` component. Alert level badge (green/yellow/red) from `output.alertLevel`.
- **Blog workflows** (`baseWorkflow = "blog"`): two shadcn Tabs — "Final Draft" (`output.finalDraft` = `stages.editorial.editedDraft`) and "Initial Draft" (`output.initialDraft` = `stages.drafting.draft`). Both rendered in `MarkdownViewer`.

**`MarkdownViewer` component (`dashboard/src/components/jobs/markdown-viewer.tsx`):**

Uses `react-markdown` with `remark-gfm`. Styled with Tailwind typography classes. Max-height with scroll. Copy-to-clipboard button in top-right corner.

**Approval Panel (`dashboard/src/components/jobs/approval-panel.tsx`):**

Only rendered when `job.workflowType` matches a blog instance (detected via `job.approval.required === true`).

States:

| `approval` state | Panel content |
|-----------------|---------------|
| `approved: true` | Green banner — "Approved by [approvedBy] at [approvedAt]" |
| `approved: false` AND `job.status !== awaiting_approval` | Not yet reached approval stage |
| `job.status === awaiting_approval` | Approve + Reject buttons with confirmation Dialog |

**Auto-refresh:** If `job.status` is `running` or `awaiting_approval`, poll `GET /api/jobs/:jobId` every 10 seconds to update the stage timeline. Stop polling once `status` is `completed` or `failed`.

---

### 5.5 Agent Registry — `/agents`

**Purpose:** Read-only catalog of all configured bot instances.

**Data source:** `GET /api/instances` on mount.

**Layout:** shadcn Card grid (2 columns on desktop, 1 on mobile). One card per instance.

**Card fields:**

| Field | Source |
|-------|--------|
| Name | `instance.name` |
| ID | `instance.id` (monospace, muted) |
| Base Workflow | `instance.baseWorkflow` — rendered as a badge |
| Enabled | Boolean indicator (green dot / gray dot) |
| Schedule | `instance.schedule.enabled` — if true, show cron + description; if false, "On-demand" |
| Approver | `instance.notify.approver` or "None" |
| Slack Channel | `instance.notify.slackChannel` or "None" |

**Empty state:** "No instances registered. Check ElevarusOS is running."

**Loading state:** Skeleton cards.

**Note:** No create/edit UI. Instance configs are managed via `src/instances/<id>/instance.md` files.

---

### 5.6 Settings — `/settings`

Phase 3 placeholder. Renders a simple card:

```
Settings

Coming soon — Phase 3 will add telemetry chart configuration,
alert rule management, and dashboard preferences.
```

No data fetching.

---

## Component Inventory

All components installed via `npx shadcn add <component>`.

| shadcn Component | Used in |
|-----------------|---------|
| `card` | Agent Registry cards, output panels, login form |
| `table` | Active Jobs, Scheduled Jobs (shadcn DataTable + TanStack) |
| `badge` | Status badges, instance labels, workflow type tags |
| `button` | Approve/Reject actions, pagination, login submit |
| `dialog` | Approve/Reject confirmation modal |
| `tabs` | Job Detail output panel (Final Draft / Initial Draft) |
| `select` | History filters — instance and status dropdowns |
| `calendar` + `popover` | History date range DatePicker |
| `skeleton` | Loading states on every data-fetched page |
| `alert` | Error states, login errors, approval success/failure toast-style alerts |
| `progress` | Active Jobs stage completion progress bar |
| `sidebar` | Main navigation structure |
| `sheet` | Mobile sidebar drawer |
| `separator` | Visual dividers in sidebar, detail panels |
| `tooltip` | Job ID full UUID, truncated title, next-fire countdown |
| `avatar` | User nav — user's initials from email |
| `accordion` | Stage error details in Stage Timeline |
| `input` | Login form fields |
| `label` | Login form labels |

**Custom components (not from shadcn):**

| Component | File | Description |
|-----------|------|-------------|
| `StatusBadge` | `components/jobs/status-badge.tsx` | Maps `JobStatus` to color-coded Badge |
| `StageTimeline` | `components/jobs/stage-timeline.tsx` | Vertical timeline of StageRecord rows |
| `ApprovalPanel` | `components/jobs/approval-panel.tsx` | Approve/Reject UI with confirmation dialog |
| `MarkdownViewer` | `components/jobs/markdown-viewer.tsx` | react-markdown renderer with copy button |
| `RelativeTime` | `components/ui/relative-time.tsx` | Client component — renders `X min ago` with live updates |

**`StatusBadge` color mapping:**

| Status | Badge variant / color |
|--------|----------------------|
| `running` | Blue — `bg-blue-100 text-blue-700` |
| `awaiting_approval` | Amber — `bg-amber-100 text-amber-700` |
| `completed` | Green — `bg-green-100 text-green-700` |
| `failed` | Red — `bg-red-100 text-red-700` |
| `queued` | Gray — `bg-gray-100 text-gray-600` |
| `approved` | Emerald — `bg-emerald-100 text-emerald-700` |

---

## Approval Flow

### Overview

Approve and Reject actions are available on:
1. The Active Jobs table — action buttons on `awaiting_approval` rows
2. The Job Detail page — the ApprovalPanel component

### Flow

```
User clicks "Approve"
  → shadcn Dialog opens: "Approve this job?"
    Shows: Job title, instance, approver email field (pre-filled from job.request.approver)
  → User confirms
  → Optimistic UI: button shows loading spinner; row/panel reflects "processing"
  → Next.js Route Handler: POST /app/api/jobs/[jobId]/approve
    → Server injects x-api-key header from ELEVARUS_API_SECRET env var
    → Proxies to ElevarusOS: POST http://<ELEVARUS_API_URL>/api/jobs/:jobId/approve
      Body: { "approvedBy": "current user email from session" }
  → On 200: success toast (shadcn Alert or Sonner) — "Job approved. Workflow resuming."
    UI refreshes the job status
  → On 4xx/5xx: error toast — show error message; revert optimistic state
```

Reject flow is identical, with a "Reason" textarea in the confirmation Dialog.

### Route Handlers

Two Next.js Route Handlers proxy to ElevarusOS:

- `dashboard/src/app/api/jobs/[jobId]/approve/route.ts`
- `dashboard/src/app/api/jobs/[jobId]/reject/route.ts`

These handlers:
1. Verify the Supabase session (reject unauthenticated requests with 401)
2. Forward the request to ElevarusOS API with `x-api-key: <ELEVARUS_API_SECRET>`
3. Return the ElevarusOS response to the client

`ELEVARUS_API_SECRET` is read from `process.env` — it is never in the browser bundle.

### Optimistic UI Pattern

On Approve/Reject click:
1. Immediately update the local row state to show a "Processing..." status
2. Disable the action buttons
3. On API response: update to final state (approved/rejected) or revert on error

TanStack Table row state can be managed with `useState` in the parent page or via React Query mutations.

---

## Supabase RLS

The `jobs` table was created with `-- RLS is disabled` per migration `20260416000001_initial_schema.sql`. To allow the dashboard's browser-side Supabase client (anon key) to read job data for the Job History page, RLS must be enabled with a read-only policy.

### Migration: `supabase/migrations/20260419000003_dashboard_rls.sql`

```sql
-- Enable RLS on jobs (currently disabled; service role bypasses RLS regardless)
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;

-- Read-only access for the anon role
-- Internal dashboard tool — no user-specific filtering needed
CREATE POLICY "jobs_anon_read"
  ON jobs
  FOR SELECT
  TO anon
  USING (true);

-- instances table (used by Agent Registry page via anon key)
ALTER TABLE instances ENABLE ROW LEVEL SECURITY;

CREATE POLICY "instances_anon_read"
  ON instances
  FOR SELECT
  TO anon
  USING (true);

-- ringba_calls and lp_leads: read-only for anon
-- (used in Phase 3 P&L charts; enabling now so Phase 3 has no schema work)
ALTER TABLE ringba_calls ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ringba_calls_anon_read"
  ON ringba_calls
  FOR SELECT
  TO anon
  USING (true);

ALTER TABLE lp_leads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "lp_leads_anon_read"
  ON lp_leads
  FOR SELECT
  TO anon
  USING (true);
```

**No write policies are created.** All writes continue through the ElevarusOS backend using the service role key, which bypasses RLS.

**Note:** The `stage_outputs` field inside the `stages` JSONB column can be large (full blog drafts). If the anon read policy is too permissive, scope it to exclude output: `SELECT id, workflow_type, status, request, created_at, updated_at, completed_at, error, approval FROM jobs` via a restricted view. For Phase 2, the full policy is acceptable given this is an internal tool with known operators.

---

## New API Endpoint

### Modified: `GET /api/jobs` — Add `offset` Pagination

**File:** `src/api/server.ts`, `listJobs()` handler

**Change:** Add `offset` query parameter. Current implementation has `limit` but no `offset`.

**Request:**

```
GET /api/jobs?status=completed&instanceId=elevarus-blog&limit=25&offset=50
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `status` | string | — | Filter by job status |
| `instanceId` | string | — | Filter by workflow type |
| `limit` | number | `50` | Max results. Capped at `200`. |
| `offset` | number | `0` | Number of records to skip. Used for page-based pagination. |

**Response:** Same shape as current response. Add `total` field (count of matching rows without limit/offset applied).

```json
{
  "jobs": [ ... ],
  "total": 147,
  "limit": 25,
  "offset": 50
}
```

**Backend implementation:** Pass `offset` to the Supabase query as `.range(offset, offset + limit - 1)` using the existing Supabase client in the job store. The `total` count requires a separate `SELECT COUNT(*)` query or use Supabase's `{ count: 'exact' }` option on the same query.

---

## Phase Breakdown

### Phase 2a — Auth + Layout + Active Jobs + Scheduled Jobs

**Goal:** Proves auth works end-to-end; delivers the two highest-value monitoring pages.

**Scope:**
- Full dashboard app scaffold (Next.js App Router, Tailwind, shadcn installed and themed)
- Supabase Auth integration — login page, middleware, session management
- Sidebar layout with Elevarus branding
- Active Jobs page — live polling, status badges, no approval buttons yet
- Scheduled Jobs page — cron display + computed next fire times
- RLS migration applied (`20260419000003_dashboard_rls.sql`)

**Definition of Done:**

- [ ] `npm run dev` in `dashboard/` starts a Next.js app at `http://localhost:3000`
- [ ] Unauthenticated navigation to `/active` redirects to `/login`
- [ ] Login with a valid Supabase Auth email/password succeeds and redirects to `/active`
- [ ] Active Jobs page shows jobs with `running` or `awaiting_approval` status
- [ ] Active Jobs page auto-refreshes every 15 seconds without a page reload
- [ ] Scheduled Jobs page shows all 5 instances with correct next fire times
- [ ] Sidebar displays Elevarus logo and all nav items; active item is visually highlighted
- [ ] Sign out button clears session and redirects to `/login`
- [ ] Dashboard renders correctly on a 1280px desktop viewport

---

### Phase 2b — Job History + Job Detail + Agent Registry

**Goal:** Completes the full read surface. All six pages are functional.

**Scope:**
- Job History page — paginated table with instance/status/date filters; direct Supabase query
- Job Detail page — stage timeline, output rendering (markdown), no approval panel yet
- Agent Registry page — instance cards with full config display
- Settings placeholder page

**Definition of Done:**

- [ ] Job History page paginates correctly; 25 rows per page
- [ ] Instance filter populates from live `GET /api/instances` response
- [ ] Status filter and date range filter narrow results correctly
- [ ] Filter state persists in URL search params (shareable/bookmarkable)
- [ ] Job Detail page shows stage timeline for a completed reporting job
- [ ] Stage timeline shows attempt count badge for retried stages
- [ ] `summary.markdownReport` renders correctly as formatted markdown for a reporting job
- [ ] `editorial.editedDraft` renders in the Final Draft tab for a blog job
- [ ] Agent Registry shows all registered instances with schedule and notify fields
- [ ] All pages handle empty state and loading state correctly

---

### Phase 2c — Approval UI

**Goal:** Approve and Reject actions are available in the dashboard. Closes the loop on the Phase 1 approval flow.

**Scope:**
- Approve/Reject buttons on Active Jobs `awaiting_approval` rows
- Approval panel on Job Detail page (confirmation dialog, optimistic UI)
- Next.js Route Handlers proxying to ElevarusOS approve/reject endpoints
- `ELEVARUS_API_SECRET` injected server-side; never in browser

**Definition of Done:**

- [ ] Approve button on Active Jobs row opens a confirmation dialog
- [ ] Confirming Approve calls `POST /api/jobs/:jobId/approve` via the Route Handler proxy
- [ ] ElevarusOS `ApprovalStore` resolves within 5 seconds of the API call
- [ ] Job status updates in the dashboard within the next 15-second poll cycle
- [ ] Reject button opens dialog with optional reason textarea
- [ ] Rejected job shows `failed` status with rejection notes in Job Detail
- [ ] Approval Panel on Job Detail shows "Approved by [email] at [time]" for approved jobs
- [ ] `ELEVARUS_API_SECRET` is not present in any browser network requests (verify via DevTools)
- [ ] Error toast shown if approve/reject API call fails (e.g. job no longer in awaiting_approval)

---

## What Is NOT in Scope

- **Create/edit instance configs** — managed exclusively via `src/instances/<id>/instance.md` files and ElevarusOS restart. No form-based instance management UI.
- **User management UI** — operator accounts are provisioned manually in Supabase Auth dashboard. No invite/password-reset flows.
- **Social OAuth** — Supabase Auth email + password only. No Google/GitHub login.
- **ClickUp integration surface** — covered by `prd-clickup-integration.md`. No ClickUp task links or status sync in this PRD.
- **Telemetry charts** — Phase 3 per `prd-remove-mission-control.md`. The `job_events`, `scheduler_ticks`, and `agent_heartbeats` tables are out of scope for Phase 2.
- **Mobile-first design** — responsive enough to not break on mobile, but the primary target is a 1280px+ desktop browser.
- **Multi-user access control** — no role-based permissions. All authenticated users have full dashboard access.
- **Direct job submission UI** — jobs are submitted via Slack slash command, ClickUp webhook, or the ElevarusOS CLI. No "New Job" form in the dashboard.

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `ELEVARUS_API_SECRET` accidentally exposed in client bundle | Low | High | Use Next.js Route Handlers for all mutation calls; never import `ELEVARUS_API_SECRET` in Client Components; verify via `NEXT_PUBLIC_` prefix absence |
| Supabase anon key gives too much read access to `stages` JSONB (blog drafts may contain sensitive content instructions) | Low | Medium | Stage outputs are internal workflow data, not credentials; acceptable for Phase 2. Phase 3 can add column-level restrictions via a restricted view if needed |
| ElevarusOS API is unavailable when dashboard loads | Medium | Low | Each page handles error state gracefully; Active Jobs shows "Unable to connect to ElevarusOS API" Alert with retry button |
| `cron-parser` timezone handling differs from `node-cron` | Low | Low | ElevarusOS API returns `timezone: "UTC"` for all schedule entries; client uses UTC for computation; no timezone mismatch |
| OpenClaw dashboard files (SQLite, `better-sqlite3`, `ws`, `node-pty`) conflict with new app | High (if files not replaced) | High | The `dashboard/` directory must be cleared of OpenClaw-specific files before building the new app. Delete: `better-sqlite3` dep, `scripts/`, `wiki/`, `.data/`, `node-pty` dep, `ws` dep. Keep: `next.config.js` (update), `tailwind.config.js` (replace), `tsconfig.json` (keep), `package.json` (rewrite) |
| Session refresh fails in middleware causing redirect loops | Low | High | Follow `@supabase/ssr` middleware pattern exactly; test login → protected page → session expiry → re-login flow before Phase 2a sign-off |
