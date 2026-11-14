# Admin panel build checklist (Direction A)

Live progress for the admin panel build. If a session gets cut off, resume from the first
unchecked item. Design reference: `design/admin/direction-a.html`.

## Foundation

- [x] `apps/admin` SvelteKit app on port 2223 (localhost only), added to `pnpm dev`
- [x] Auth gate: main app session cookie + `user.superadmin` checked per request (401/403 pages)
- [x] `user.superadmin` column (better-auth `input: false`) + grant script `pnpm --filter admin grant <email> [--revoke]`
- [x] `admin_audit` table (migration 0009)
- [x] Superadmin granted to chrissullivan.dev@gmail.com (local DB)

## Ops plumbing (worker / collab)

- [x] `job_state`, `job_run`, `service_heartbeat` tables + `user.disabled` (migration 0010)
- [x] `@corpus/db/ops`: job registry, `tracked()` runs, pause flag, run-now NOTIFY, heartbeat
- [x] Worker: all 5 jobs tracked, pause respected, run-now listener, heartbeat, run pruning in cleanup
- [x] Collab: heartbeat with connection/document counts
- [x] Disabled users blocked from new sessions (better-auth session.create hook)
- [x] Apply migration 0010 (`pnpm db:migrate`)

## Admin server (apps/admin/src/lib/server)

- [x] Audit helper (`logAction`)
- [x] Queries: overview metrics, service health (web probe + heartbeats)
- [x] Queries: jobs list + job run history
- [x] Queries: integrations by provider + connection detail
- [x] Queries: users, user detail, workspaces, workspace detail
- [x] Queries: audit log

## UI (Direction A)

- [x] Shell: sidebar (Corpus + ADMIN badge), top bar (env pill, admin user), page header
- [x] Shared components: Pill, Card, Drawer, ConfirmModal (required reason), EmptyState, Metric
- [x] Overview: metrics, attention notice, jobs needing attention, service health, recent activity
- [x] Jobs: table + history drawer, Run now, Pause (confirm + reason), Resume
- [x] Integrations: provider cards + connection drawer, Retry connection
- [x] Users & workspaces: search, user drawer (Revoke sessions, Disable/Enable), workspace drawer
- [x] Audit log: table with action filter
- [x] Error page, empty states, auto-refresh

## Validate

- [x] `pnpm check` for admin, web, worker, collab, db, auth
- [x] admin lint + build

## Later

- [x] Docker: one image (root `Dockerfile`) for web, admin, worker, collab + migrations; `deploy/compose.yml` (project `corpus-deploy`) with Postgres, Mailpit, volumes; `make deploy-up`. Image builds (verified); stack not started yet

## Design review round 1 (designer scores: Overview 7.5, Jobs 7, Integrations 7, Users 7.5, Audit 7; target ≥ 8)

Shared

- [x] Responsive: sidebar collapses to a top nav on narrow screens; wide tables scroll horizontally
- [x] Toasts for action success/error; failures keep context (dialog stays open with error)
- [x] Confirm dialog: focus Cancel, `aria-describedby` impact, reason cleared on reopen
- [x] Refresh: try/finally, failure toast, "Updated Xs ago" freshness
- [x] Single definition for button/table CSS
- [x] Explicit dates: year + timezone, rendered client-side (no SSR timezone drift)

Overview

- [x] Service alerts open a service detail drawer (instance, uptime, last heartbeat)
- [x] Jobs card: "not reported yet" state instead of "All jobs healthy" when jobs haven't run

Jobs

- [x] Feedback: "Run requested" (vs completed), "Job paused/resumed"; inline failure
- [x] History links have accessible names with the job name

Integrations

- [x] Cards show retrying + rate-limited counts together
- [x] Retry explains rate-limit behaviour and reports result
- [x] Connection drawer: search + status filter

Users & workspaces

- [x] View switch as plain nav links with aria-current
- [x] Search progress indicator + result counts
- [x] Explain why self-disable is unavailable
- [x] Confirm successful account/session changes (toasts)

Audit log

- [x] Readable action labels next to identifiers
- [x] Explicit timezone + year
- [x] "Load older" pagination beyond 200
- [x] Filtered empty state with "Clear filters"

## Design review round 2 (Overview 8, Jobs 7.5, Integrations 7.5, Users 7.5, Audit 8)

- [x] Toasts render inside the open drawer (modal dialogs are top-layer and make the page inert)
- [x] Jobs drawer: "Refresh history" button; after Run now, a pending banner polls history every 3 s until the manual run lands (2 min cap) without closing the drawer
- [x] Round 3 (all screens 8/10): polling timeout shows "No result received yet" with Refresh history + worker health link; clears if the run reports late
- [ ] Browser acceptance by @you: toasts with drawers open, keyboard focus through drawer → confirm, narrow-screen overflow
