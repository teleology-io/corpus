# Local runner — plan

Status: **proposed** (not started). Owner: TBD. Written 2026-11-14.

## Problem

Workbench (`apps/web/src/lib/server/wrx/`) runs git, terminals, dev commands and the Claude /
Codex CLIs **on the machine running the web server**, as that server's OS user, against that
machine's filesystem. With `make dev` that machine is the user's laptop, so it "just works".

Once Corpus is hosted (Docker on a server, `deploy/compose.yml`), "local" means the server or
container: it can't see users' files, use their agent logins, or run on their hardware. Bind
mounts only cover a single-machine setup and need host Docker access for Environments, which is
equivalent to root on the host.

## Goal

Hosted Corpus, with Workbench execution on **each user's own computer**:

- Agents, git, terminals and Run tasks execute on the user's machine, against their files, with
  their own Claude/Codex logins and toolchains.
- The server never holds users' source code or agent credentials, only what Workbench already
  stores (chat transcripts, state).
- Works behind NAT/firewalls: the runner only makes **outbound** connections.
- `make dev` keeps working exactly as today, with no runner needed.

The sidebar already has a "Computers" section and a "Local workbench: on your machine" card,
which is where this fits in the UI.

## Architecture

```
 Browser ──HTTPS/SSE──▶ Corpus web (hosted) ──WebSocket (outbound from laptop)──◀ corpus-runner
                          │  Engine (wrx/core.js)                                  │ spawn / pty / fs / git
                          │  Host interface ──▶ RunnerHost (RPC) ────────────────▶ │ on the user's machine
                          └─ LocalHost (today's behaviour, used by make dev)
```

### 1. A `Host` seam in Workbench (server side)

Every place Workbench touches the OS goes through one interface:

| Capability                                                                          | Today                 | Call sites                                                                                      |
| ----------------------------------------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------- |
| `spawn(cmd, args, opts)` → child-like (stdout/stderr/stdin streams, `exit`, `kill`) | `child_process.spawn` | `core.js` (agents, summaries, commands), `provision.js`, `files.js`                             |
| `pty(shell, opts)` → resize/write/onData/onExit                                     | `node-pty`            | `terminal.js`                                                                                   |
| `fs`: `readdir`, `stat`, `realpath`, `readFile`, `writeFile`                        | `node:fs`             | `directories.js`, `discover.js`, `files.js`, `runner.js`, `core.js` (attachments, codex images) |
| `env`: `homedir`, `PATH` discovery, platform                                        | `os` / `process.env`  | `core.js` (`agentSearchPath`, `hostEnv`, `dockerEnv`)                                           |

`Engine` already accepts `spawnProcess` in its constructor, which is the first seam. Steps:

1. Add `LocalHost` that wraps today's calls unchanged.
2. Route every call site above through `host.*` (mechanical refactor, no behaviour change).
3. Pick the host per **workspace**: each project/workspace records `computerId`; `null` means
   `LocalHost`.

### 2. `RunnerHost` + connection broker (server side)

- New WebSocket endpoint (`/api/runner/connect`) on the web app. One socket per online runner,
  multiplexing many logical streams.
- `RunnerHost` implements the `Host` interface as RPC over that socket. Child processes and ptys
  become stream ids; stdout/stderr/pty data arrive as frames, and `kill`/`write`/`resize` go out
  as frames.
- Presence: runners send heartbeats. Store `computer.lastSeenAt` and show online/offline in the
  sidebar. Starting work on an offline computer fails fast with a clear message.
- Multi-instance web: pin a runner's socket to one web instance and route RPC through Postgres
  `LISTEN/NOTIFY` (already used for realtime) or a sticky load balancer. Start single-instance.

### 3. `corpus-runner` (user's machine)

- A small Node CLI and daemon (`packages/runner`, published as `corpus-runner`, later a menubar
  app). It reuses `LocalHost` from step 1, so the runner is LocalHost behind a socket.
- `corpus-runner login <url>`: device-code pairing. The browser shows a code and the user approves
  it in Corpus. The runner gets a **device token** bound to their user, stored in the OS keychain.
- `corpus-runner start`: connects out, reconnects with backoff, runs as a launchd/systemd service.
- Runs as the user, so it inherits their `~/.claude`, `~/.codex`, git credentials, Colima and PATH.

## Security model

The runner executes commands on a user's machine on behalf of a server, so this is the
high-risk part:

- **Device tokens**: per device, revocable from Corpus (Computers page and the admin panel), stored
  hashed server-side, rotated on reconnect. A token only ever acts as its own user.
- **Ownership check on every RPC**: the server only sends work for workspaces owned by the
  token's user. Shared projects never let user A run on user B's computer.
- **Path allowlist on the runner**: the user picks which folders Corpus may touch (`~/code`, …).
  The runner rejects fs/spawn outside them, even if the server asks. This is the runner's own
  config, not the server's.
- **No arbitrary shell from the server**: RPC verbs are the `Host` operations, with explicit argv
  (Workbench already avoids shell strings, per `runner.js`).
- **Local kill switch**: `corpus-runner pause` stops accepting work immediately.
- **Audit**: log runner connect/disconnect, pairing and revocation to `admin_audit`.
- Transport: WSS only outside localhost; reject plain `ws://` to non-loopback hosts.

## Phases

| #   | Deliverable                                                                                 | Done when                                                |
| --- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 0   | Decide open questions below                                                                 | Answers recorded here                                    |
| 1   | `Host` interface + `LocalHost`; all wrx OS access routed through it                         | `make dev` behaves identically; wrx tests pass           |
| 2   | `computer` + `runner_token` tables, pairing flow, Computers UI (list, online state, revoke) | A paired runner shows online in the sidebar              |
| 3   | WebSocket broker + `RunnerHost` for `spawn` and `fs`                                        | A Run task and git status work on a remote computer      |
| 4   | Agents (Claude/Codex) via runner, incl. attachments and long-lived sessions                 | Agent chats in a runner workspace behave like local ones |
| 5   | Terminals (pty) over the runner                                                             | Run tab terminal works remotely with replay              |
| 6   | Environments (Colima/Docker) via runner                                                     | Workspace environments provision on the user's machine   |
| 7   | Packaging: launchd/systemd install, auto-update, menubar app                                | Non-technical install path                               |
| 8   | Admin panel: runners page (online, version, last seen, revoke)                              | Superadmins can see and revoke any device                |

Phases 1–3 deliver the core value. 4–6 can ship one at a time behind a per-workspace flag.

## Open questions

1. **Hosting model**: is the hosted Corpus multi-tenant (other people's runners), or only
   your own infra? This sets how strict phase 2/security must be on day one.
2. **Where transcripts live**: today in `WRX_DATA` on the server. Keep them server-side (current
   plan), or keep them on the runner for privacy?
3. **Offline behaviour**: should queued agent work wait for the computer to come back, or fail?
4. **Runner distribution**: npm package first, signed macOS app later?
5. **Windows support**: in scope? (node-pty and path handling need extra work.)

## Related

- `deploy/compose.yml`: hosted stack (no local execution without this runner).
- Short-term alternative: run the web app natively and only infra in Docker (see thread notes).
- `apps/admin`: phase 8 adds a runners view to the infra admin panel.
