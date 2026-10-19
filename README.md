# Corpus

Calendar, prescription cycles, reminders, collaborative notes, teams and GitHub/Linear integrations — in one workspace.

## Stack

| Path            | What                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------- |
| `apps/web`      | SvelteKit 3 (Svelte 5, Tailwind 4) — UI, JSON API, SSE stream, Better Auth                        |
| `apps/collab`   | Hocuspocus (Yjs) websocket server for realtime notes                                              |
| `apps/worker`   | pg-boss cron (reminders/doses/events → notifications), push + email delivery, integration polling |
| `packages/db`   | Drizzle schema + migrations, `notify()`, note access rules                                        |
| `packages/core` | Recurrence (RRULE, DST-safe), cycle math, notification registry, crypto, GitHub/Linear providers  |
| `packages/auth` | Better Auth config (email/password, GitHub, organizations + teams, 2FA)                           |

## Setup

Needs Node 22+ and Docker running. One command:

```sh
make dev    # installs deps, creates .env with secrets, starts Postgres + Mailpit, migrates, runs everything
```

`make help` lists the rest (`stop`, `db-reset`, `studio`, `check`, `test`, …). Manual equivalent:

```sh
cp .env.example .env              # fill in BETTER_AUTH_SECRET, ENCRYPTION_KEY (openssl rand -base64 32)
pnpm dlx web-push generate-vapid-keys   # → PUBLIC_VAPID_KEY / VAPID_PRIVATE_KEY (optional, enables push)
docker compose up -d              # Postgres :5432, Mailpit :1025 (UI at http://localhost:8025)
pnpm install
pnpm db:migrate
pnpm dev                          # web :5173, collab :1234, worker
```

### Integrations (per user)

Create OAuth apps and set the env vars:

- **GitHub** — callback `http://localhost:5173/integrations/github/callback` (and `/api/auth/callback/github` to enable GitHub sign-in). Scopes: `repo read:user`.
- **Linear** — callback `http://localhost:5173/integrations/linear/callback`. Scope: `read`.
- **Google Calendar** (`GOOGLE_CLIENT_ID/SECRET`) — Google Cloud → enable the Calendar API → OAuth client (Web) with redirect `http://localhost:5173/integrations/google-calendar/callback`. While the consent screen is in "Testing", add yourself as a test user.
- **Slack** (`SLACK_CLIENT_ID/SECRET`) — create an app at api.slack.com/apps, add redirect URL `{PUBLIC_APP_URL}/integrations/slack/callback`. Slack only accepts **https** redirects, so in dev run a tunnel (e.g. `cloudflared tunnel --url http://localhost:5173`) and set `PUBLIC_APP_URL` to it. User-token scopes are requested by Corpus: `search:read`, `*:history`, `*:read`, `users:read`, `chat:write`.

**Google Calendar** is two-way: the Google calendars you pick (primary by default) appear as calendars in your personal workspace. Edits made in Corpus are pushed within seconds; changes made in Google are pulled every minute. You're notified when someone invites you, or moves or cancels an event they organize.

**Slack** works with your own user token: threads where you're @mentioned are followed automatically, and you can follow any thread by pasting its link. Read and reply under **Integrations → Slack → Open threads**. You're notified about new mentions and about replies in threads you follow.

Connected accounts are polled about every 60 s; review requests and assigned issues become tasks in your personal workspace and show live on the dashboard.

## Scripts

`pnpm check` (typecheck all) · `pnpm test` (core unit tests) · `pnpm lint` · `pnpm format` · `pnpm db:generate` (after schema changes) · `pnpm db:studio`
