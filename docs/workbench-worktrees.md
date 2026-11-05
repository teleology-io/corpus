# Workbench worktrees

Commit a `.workbench.json` to a repository and each new Workbench workspace becomes a runnable
checkout: dependencies, env values, free ports and a database of its own. Creating a workspace
returns immediately and setup finishes in the background. Agents start when it's ready. Without
this file, a workspace is only a Git worktree.

New worktrees live in `~/.workbench/worktrees/<project>/` (`WRX_WORKTREES` overrides this). Keep
this outside any repository, because tools that search upward for config would otherwise find the
outer repository's files.

## Config

```json
{
	"copy": [".env", ".env.local"],
	"clone": ["node_modules", ".next/cache"],
	"share": [".cache/models"],
	"ports": { "web": "PORT", "api": "API_PORT" },
	"env": { "PUBLIC_URL": "http://localhost:${ports.web}" },
	"envFile": ".env",
	"services": { "compose": "docker-compose.yml", "shared": ["postgres", "redis"] },
	"database": {
		"engine": "postgres",
		"urlEnv": "DATABASE_URL",
		"source": "postgres://app:app@localhost:5432/app",
		"service": "postgres",
		"seed": "clone",
		"excludeData": ["pgboss.*", "integration_tokens"],
		"migrate": "pnpm db:migrate"
	},
	"scripts": { "setup": "pnpm install --frozen-lockfile --prefer-offline", "teardown": "" }
}
```

Every key is optional, and unknown keys are rejected.

| Key                | What it does                                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `copy`             | Gitignored paths each worktree gets its own copy of.                                                                    |
| `clone`            | Same, using an APFS or reflink clone when possible, so large directories are cheap. Absolute symlinks still point back. |
| `share`            | Symlinks to the primary checkout. Only for caches and read-only assets, since every worktree writes to the same files.  |
| `ports`            | Name to env var. Each workspace gets a free block of 10 ports from 20000.                                               |
| `env`              | Templates using `${ports.<name>}`, `${database.url}`, `${workspace.id}`, `.name`, `.branch` or `.path`.                 |
| `envFile`          | Gitignored dotenv file to write the values into. Other lines are kept.                                                  |
| `services`         | Compose services started once from the primary checkout, then shared. Existing containers are reused.                   |
| `database`         | See below.                                                                                                              |
| `scripts.setup`    | Runs in the worktree after the database exists, before `migrate`.                                                       |
| `scripts.teardown` | Runs in the worktree when it's deleted. A failure is reported but doesn't block deletion.                               |

Agents and scripts also receive the ports, database URL and `env` values as process env, so these
win over dotenv files. Scripts additionally get `WORKBENCH_WORKSPACE_PATH`,
`WORKBENCH_PRIMARY_PATH`, `WORKBENCH_BRANCH` and `WORKBENCH_SLOT`.

Anything fixed in the repository has to read these env vars: a dev script hard-coding its port, or
a Compose file publishing a fixed port for a service that isn't shared, will still collide.

## Approval

Setup commands from a repository run on your computer as your user, so Workbench shows them and
asks first. It asks again whenever the file changes. The config is read from the Git ref being
checked out, and that approved copy is used for retries and teardown, so an agent editing the file
in its checkout can't change what runs on the host.

## Databases

Each workspace gets `wb_<id>` on one local Postgres server. No Postgres extension is involved.

- **`seed: "clone"`** copies a golden template, `wb_base_<project>`, built from `source` with
  `pg_dump`. Nothing connects to the template, so your running app is never disconnected. Use
  **Refresh base** to rebuild it, which doesn't change existing workspaces.
- **`seed: "blank"`** creates an empty database. Either way, the branch's `migrate` command runs next.
- **Snapshot and Restore** give you a retry loop for migrations, without needing down migrations:
  snapshot, migrate, restore, edit, retry. Both disconnect that workspace's apps. **Reset** goes back
  to the seed and migrates again.

`source` must be on this computer: Workbench refuses any other host, and only ever drops databases
named `wb_*`.

**Scrub clones with `excludeData`.** A clone holds whatever the source holds. Without exclusions, a
background worker running in a worktree can act on real integration tokens and queued jobs.

With `service` set, `pg_dump` and `psql` run inside that Compose service, so their versions match
the server. Otherwise they run from your `PATH`.

**Large databases:** templates over 1 GB are copied with `STRATEGY FILE_COPY`. On Postgres 18 with
`file_copy_method = clone` on a filesystem with reflinks, this can share blocks instead of copying
them. Workbench never changes server settings. Whether this works with Postgres in Docker on macOS
depends on the VM's filesystem, so measure before relying on it.

## Dependency and build caches

- **pnpm:** `pnpm install --frozen-lockfile --prefer-offline` links from the global store and is
  usually fast already. pnpm's global virtual store is still experimental, so it isn't recommended.
- **npm and Yarn:** `clone` `node_modules`, then let `scripts.setup` reconcile what differs on the branch.
- **Nx:** per Nx's docs, a worktree's cache resolves to the main repository's, so no config is needed.
  Avoid setting `NX_CACHE_DIRECTORY` to a shared folder, which has a reported collision issue.
- **Others:** `clone` their cache directories.

Don't `share` `node_modules`: branches can need different dependencies.

## Isolated VMs

Colima VMs are opt-in, for repositories that need Docker isolation. Agents still run on the host.
Deleting a workspace deletes its dedicated VM, including container data.
