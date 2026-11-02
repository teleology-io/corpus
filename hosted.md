# Corpus: hosted product and monetization plan

## Proposed direction

Offer Corpus as a subscription workspace that brings a person's calendar, tasks, notes, reminders, connected work, and screen recordings into one daily dashboard. Customers pay for a managed service: create an account, connect their tools, invite collaborators, and use Corpus without running servers or configuring OAuth applications.

Start with independent developers and small software teams. GitHub, Linear, Slack, collaborative notes, calendar sync, and Telescope give this audience a concrete workflow: see today's commitments, handle assigned work, and share an asynchronous update from the same workspace. Personal routines remain useful, but family plans and specialized enterprise offerings can follow after the initial audience demonstrates retention.

This document is a proposal based on the repository, not an implementation or a production readiness certification. All prices, budgets, and targets below are illustrative assumptions to validate with customers; they are not researched market prices or vendor quotes.

## What already exists

| Foundation | Evidence in this project | Hosted implication |
| --- | --- | --- |
| Web application and API | `apps/web`, SvelteKit with the Node adapter | Run as a persistent application service. |
| Accounts and workspaces | Better Auth; organizations, teams, membership, personal workspace creation | Build subscriptions around existing workspace ownership. |
| Shared notes | Hocuspocus and Yjs in `apps/collab` | Operate a WebSocket service alongside the web application. |
| Reminders and integration sync | `apps/worker`, pg-boss, PostgreSQL | Run durable background workers independently of web requests. |
| Connected tools | GitHub, Linear, Google Calendar, Slack | Provide operator-managed OAuth applications and connection health visibility. |
| Telescope recordings | Private recordings, share links, browser transcription, local/R2 storage | Offer bounded hosted storage and sharing as paid value. |
| Workspace-scoped records | Workspace references and membership/access helpers | Useful starting point for tenancy; isolation still needs comprehensive verification. |
| Workbench | Host-side Git, coding agents, and local tooling, described in `.env.example` | Requires a separate execution architecture before public hosted access. |

The inspected schema and manifests do not establish a subscription system. Billing, plan enforcement, usage accounting, customer operations, and production verification should be treated as additional work.

## How we could charge

Use recurring subscriptions as the main revenue stream. Charge individuals a flat amount and teams per member, with pooled storage. Avoid advertising or monetizing personal notes, calendar contents, recordings, or connected-account data.

### Initial pricing experiment

| Plan | Proposed monthly price | Proposed allowance and value |
| --- | --- | --- |
| Free | $0 | One personal workspace, core planning and reminders, one connected integration account, 1 GB of recording storage, recordings up to 10 minutes. |
| Personal Pro | $12 per personal workspace | Multiple connected accounts, full personal workflow, 25 GB of recording storage, recordings up to 60 minutes. |
| Team | $18 per member; minimum three members | Shared workspace, team notes and planning, integrations, billing administration, 25 GB pooled storage per paid member, recordings up to 60 minutes. |
| Dedicated | Individually quoted, later | Isolated deployment, agreed support and recovery terms, and separately priced infrastructure and onboarding. |

These are proposed product limits, not existing capabilities. Keep core reminder behavior available across plans; upgrades should buy capacity and collaboration rather than the dependability of a reminder.

Begin with monthly billing and a 14-day Team trial. Test annual billing at ten times the monthly price after customers demonstrate repeat use. Trial expiration should return the workspace to defined free/read-only behavior without silently charging an unapproved payment method.

Make billing workspace-specific: Personal Pro covers one personal workspace, while Team covers one organization. Someone belonging to several organizations may occupy a paid seat in each; disclose this before invitations are accepted. Public recording viewers and guests viewing an explicitly shared note should not consume seats. Members with workspace editing access should.

Start with storage caps and upgrade prompts. Later, test an optional $5/month additional 50 GB storage pack once measured storage and playback costs support it. Notify owners before limits, reject additional uploads when full, and preserve existing data under the published retention policy. Do not introduce surprise usage charges.

Defer enterprise identity, advanced audit reporting, custom domains, and contractual availability guarantees until they are implemented and supportable. Dedicated hosting should cover deployment and ongoing operating effort, not simply add a small surcharge to shared hosting.

## Hosted architecture

Use one primary region and managed infrastructure for the first paid release. Keep the existing monorepo and application boundaries rather than redesigning the product around microservices.

| Component | Initial hosting approach | Operational requirement |
| --- | --- | --- |
| Web/API | Persistent Node service behind HTTPS | Support streaming responses, secure cookies, uploads, and graceful shutdown. |
| Collaboration | Separate long-lived WebSocket service behind WSS | Authenticate documents, enforce sharing rules, and persist updates. |
| Worker | Persistent background process | Track queue lag, failed jobs, sync progress, and notification delays. |
| Database | Managed PostgreSQL with backups and point-in-time recovery | Private connectivity, connection limits, migration discipline, restore drills. |
| Recordings | Private R2 bucket using the existing storage adapter | Exact production CORS origins, short-lived access URLs, upload cleanup, usage accounting. |
| Note attachments | Durable storage; move beyond a local development directory | Audit existing upload paths, authorize downloads, and include attachments in recovery and deletion. |
| Email and push | Production email delivery and configured web push | Verified sending domain, bounce handling, delivery monitoring, stable push keys. |
| Secrets | Deployment secret manager | Separate production/staging credentials, least privilege, rotation and recoverable encryption keys. |

Select a hosting platform that supports long-running Node processes and WebSockets. The initial requirement does not demand Kubernetes. Evaluate providers against these needs and actual quotes before committing.

Use separate production and staging databases, buckets, OAuth applications, and secrets. Set public URLs to the production HTTPS/WSS addresses. Explicitly configure operator admin emails; do not rely on a first-user default. Keep PostgreSQL and worker administration inaccessible from the public internet.

Run migrations as a controlled release step, with a backup and a compatible rollback plan. Initially keep collaboration on one instance: before adding replicas, establish shared document coordination and verify concurrent writes. Scale workers only after confirming job locking, deduplication, and integration ownership under concurrent execution.

### Workbench boundary

Do not enable the current host-executed Workbench for public tenants. Its commands run as the server's OS user, so an email allowlist alone is insufficient isolation for a commercial multi-tenant execution service.

A future hosted Workbench could be a separate paid product using disposable, isolated execution environments with per-tenant credentials, resource/time budgets, restricted network access, and no access to the production application database or host filesystem. Define who pays for coding-agent usage and verify tool licensing before selling it. The initial hosted Corpus offering can launch with Workbench inaccessible at both the page and API layers.

## Work required before accepting payments

### Billing and entitlements

Add a billing customer and subscription relationship for each billable workspace, plus plan, status, billing period, seat quantity, and usage records. Use a payment provider's hosted checkout and customer portal to reduce payment handling work; select the provider after reviewing supported markets, recurring billing needs, and fees.

Verify payment webhook signatures, process events idempotently, tolerate out-of-order delivery, and reconcile subscriptions periodically. Derive entitlements from verified billing state rather than a checkout redirect. Enforce permissions and limits on the server for API calls, invitations, uploads, and integration creation, not only in the interface.

Define seat additions, removals, proration, failed payments, refunds, and cancellation before launch. Restrict billing management to authorized owners/admins. Provide a documented grace period for failed payments, then restrict paid activity while preserving access to export and account management. Cancellation should stop renewal; deletion should remain an explicit, separate action.

### Tenant isolation and privacy

Review every data path for workspace and user authorization: web APIs, background jobs, live updates, note collaboration, recording URLs, attachments, and integration tokens. Verify that removing membership or revoking a share terminates access appropriately, including already-open collaboration connections and the bounded lifetime of presigned media URLs. A foreign key or active workspace selection does not establish isolation on its own.

Separate personal information from organization visibility. Team administrators should not gain access to members' personal calendars, prescription cycles, private notes, or personal integration credentials by purchasing seats. Preserve explicit sharing boundaries and make them understandable to customers.

Publish data handling, retention, export, deletion, support-access, and incident processes before public launch. Account deletion needs rules for organization ownership, shared records, integration disconnection, recordings, and eventual backup expiration. Prescription-related data deserves particular care; this proposal makes no medical or regulatory compliance claim.

### Integrations and service reliability

Create production OAuth applications and verify each provider's current review, scope, distribution, and usage requirements before onboarding external users. Ask for the minimum necessary access. Handle token refresh, revocation, rate limits, retries, and reconnects visibly.

The README describes approximately minute-based polling. Budget polling across all connected accounts with jitter, backoff, and concurrency limits; adopt provider webhooks where appropriate after verification. Do not multiply a development polling loop across tenants without measuring request volume.

Add rate limits for signups, login attempts, invitations, public share endpoints, downloads, and uploads. Meter storage using completed uploads and account for deletion, abandoned multipart uploads, and concurrent upload reservations. Monitor database health, reminder lateness, integration sync failures, email delivery, WebSocket disconnects, and storage growth without logging sensitive content or tokens.

Test backup restoration across database and file storage, including access to encryption keys needed to decrypt integration credentials. Set internal recovery objectives and verify them before selling contractual guarantees. Test deployment/restart behavior for pending reminders and live note edits.

## Economics to validate

The following is a planning example, not a forecast:

| Monthly recurring revenue source | Calculation | Revenue |
| --- | --- | --- |
| Personal Pro | 200 subscriptions × $12 | $2,400 |
| Team | 20 workspaces × 8 seats × $18 | $2,880 |
| Total | 360 paid seats/subscriptions across these plans | $5,280 |

If infrastructure, database, storage, delivery, payment fees, and direct customer support total $1,200/month, the example leaves $4,080, or approximately 77%, before engineering, sales, general overhead, and taxes. Annual discounts, refunds, churn, and acquisition costs would change the result. This is not net profit.

For an initial budgeting exercise, reserve $300–$800/month for baseline hosting, database, backups, monitoring, and delivery, then separately model recording storage/playback, payment fees, and support. Replace that placeholder with actual quotes and observed usage before setting final allowances.

Track direct service cost per paid workspace and per active user, including free users. Recording size, playback frequency, retained history, integration polling, and support demand are likely cost drivers. Browser-side transcription avoids a server transcription charge for the existing Telescope workflow, but does not eliminate storage, delivery, or support costs.

Target at least 75% gross margin once usage stabilizes. At that target, a $12 subscription allows $3/month in direct cost and an $18 seat allows $4.50/month. Adjust storage packs, free allowances, or pricing if measured costs exceed those budgets. Measure acquisition payback against gross profit rather than subscription revenue.

## Launch and growth

1. **Validate the workflow:** recruit 5–10 independent developers or small teams. Have them connect tools, plan a day, share a note or recording, and return the following week. Ask which workflow they would pay to keep.
2. **Run an invite-only hosted pilot:** deploy the core services, disable Workbench, verify isolation and recovery, operate production OAuth connections, and observe delivery and storage costs. Give support personally and record recurring friction.
3. **Launch paid beta:** introduce checkout, workspace entitlements, usage limits, export/deletion, and documented billing policies. Charge a small cohort and verify payments, seat changes, cancellation, and failed-payment recovery end to end.
4. **Open self-service signup:** expand only after onboarding works without operator intervention, restores have been demonstrated, and several weeks of cohort usage show retention and manageable support costs.
5. **Expand what customers buy:** prioritize storage, team administration, and dedicated deployments according to paid demand. Consider a Family plan and isolated Workbench only as separately validated additions.

Use short product demonstrations around a specific result: “Open Corpus and see your meetings, assigned issues, review requests, notes, and follow-ups for today.” Reach developer communities and small-team founders with that workflow. Shared notes and recordings can introduce collaborators to the product; keep viewing simple and ask for signup when a viewer wants their own workspace or editing access.

Measure activation as connecting an integration, creating useful personal content, and returning within seven days. Track week-four retention, trial conversion, paid workspace churn, seat expansion, recurring revenue, support time, and gross margin by plan. Suggested pilot gates are 60% activation among recruited users, 40% week-four retention among activated users, and at least five customers paying the proposed price. These are decision hypotheses for a small cohort, not industry benchmarks.

## Recommended first commitment

Fund a narrow hosted pilot for the existing planning, integration, notes, and Telescope workflows. Validate Personal Pro and Team pricing, make tenant isolation and recovery demonstrable, and keep storage bounded. Broader packaging and execution hosting should follow evidence of recurring use and willingness to pay.

Repository references: `README.md`, `.env.example`, `apps/web/package.json`, `apps/collab/src/index.ts`, `packages/auth/src/workspace.ts`, `packages/db/src/schema/auth.ts`, and `packages/db/src/apps.ts`.
