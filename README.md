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

### Telescope (screen recordings)

**Telescope** in the sidebar records your whole desktop, a window, or a browser tab, plus an optional mic and camera bubble. It runs in any desktop browser on any OS.

- **Browser support:** tab capture and tab audio need Chrome or Edge. Whole-desktop system audio works in Chrome/Edge on Windows only; elsewhere, share a tab for audio. Phones can watch recordings but can't record a screen.
- **Transcription:** after you stop, the browser transcribes the recording with the same sherpa-onnx model dictation uses (`make models`). No audio is sent to a server. It is English only, with one timestamp per phrase.
- **Sharing:** videos start private. Under **Share**, turn on _Anyone with the link_ to get a `/v/<token>` URL. Turning it off disables the URL; _Reset link_ swaps it for a new one.
- **Views:** each viewer counts once, after 2 seconds of playback. Signed-in viewers are counted by account and anonymous viewers by a cookie. The owner's own plays don't count.

Every storage setting starts with `STORAGE_` (see `.env.example`). `STORAGE_DRIVER=local` keeps files in `STORAGE_VIDEO_DIR`, which is fine for dev. For production, use Cloudflare R2:

1. In the Cloudflare dashboard, go to **R2** → **Create bucket** and name it `corpus-telescope` (or set `STORAGE_BUCKET`). Leave public access **off**; all access goes through short-lived presigned URLs.
2. Go to **R2 → Manage API tokens** and create a token with **Object Read & Write**, limited to that bucket. Copy the Access Key ID and Secret into `STORAGE_ACCESS_KEY_ID` / `STORAGE_SECRET_ACCESS_KEY`, and your account ID into `STORAGE_ACCOUNT_ID`.
3. Go to **Bucket → Settings → CORS policy**. Browsers upload directly to the bucket, so this step is required:
   ```json
   [
   	{
   		"AllowedOrigins": ["http://localhost:5173", "https://your-domain"],
   		"AllowedMethods": ["PUT", "GET", "HEAD"],
   		"AllowedHeaders": ["content-type"],
   		"ExposeHeaders": ["ETag"],
   		"MaxAgeSeconds": 3600
   	}
   ]
   ```
   `ExposeHeaders: ETag` is required; without it every upload fails at the last step.
4. Go to **Bucket → Settings → Object lifecycle rules** and add _Abort incomplete multipart uploads after 1 day_.
5. Set `STORAGE_DRIVER=r2` and restart. Missing `STORAGE_*` values cause a descriptive error on the first Telescope request.

The worker removes recordings that never finished uploading (24 h old) every hour.

## Scripts

`pnpm check` (typecheck all) · `pnpm test` (core unit tests) · `pnpm lint` · `pnpm format` · `pnpm db:generate` (after schema changes) · `pnpm db:studio`
