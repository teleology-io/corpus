import { env, sql } from '@corpus/db';
import { JOBS, STALE_AFTER_MS, type JobName } from '@corpus/db/ops';

/** Read side of the admin panel. Raw SQL: these are aggregates over tables owned by other apps. */

export const appUrl = env('PUBLIC_APP_URL', 'http://localhost:2222');

export type Health = 'healthy' | 'degraded' | 'down';

// ── Services ────────────────────────────────────────────────────────────────

export type Service = {
	id: 'web' | 'worker' | 'collab';
	name: string;
	health: Health;
	/** One line for lists. */
	detail: string;
	/** What to check when it isn't healthy. */
	advice: string | null;
	instance: string | null;
	startedAt: Date | null;
	beatAt: Date | null;
	meta: Record<string, unknown>;
};

async function probeWeb(): Promise<Service> {
	const base = {
		id: 'web' as const,
		name: 'Web app',
		instance: appUrl,
		startedAt: null,
		beatAt: null,
		meta: {}
	};
	const started = Date.now();
	try {
		const res = await fetch(`${appUrl}/favicon.svg`, { signal: AbortSignal.timeout(3000) });
		const ms = Date.now() - started;
		if (!res.ok)
			return {
				...base,
				health: 'degraded',
				detail: `HTTP ${res.status} from ${appUrl}`,
				advice: 'The web app answered with an error. Check its logs.'
			};
		return {
			...base,
			health: ms > 1500 ? 'degraded' : 'healthy',
			detail: `Responded in ${ms} ms`,
			advice: ms > 1500 ? 'Responses are slow. Check database load and the web process.' : null,
			meta: { responseMs: ms }
		};
	} catch {
		return {
			...base,
			health: 'down',
			detail: `No response from ${appUrl} within 3 s`,
			advice: 'Start the web app (pnpm dev) or check that PUBLIC_APP_URL points at it.'
		};
	}
}

export async function services(): Promise<Service[]> {
	const [web, beats] = await Promise.all([
		probeWeb(),
		sql<
			{
				service: string;
				instance: string;
				beatAt: Date;
				startedAt: Date;
				meta: Record<string, unknown> | null;
			}[]
		>`select service, instance, beat_at as "beatAt", started_at as "startedAt", meta
			from service_heartbeat`
	]);
	const beat = (
		id: 'worker' | 'collab',
		name: string,
		detail: (m: Record<string, unknown>) => string
	): Service => {
		const b = beats.find((x) => x.service === id);
		const start = `pnpm --filter ${id === 'worker' ? '@corpus/worker' : '@corpus/collab'} dev`;
		if (!b)
			return {
				id,
				name,
				health: 'down',
				detail: 'Has never reported a heartbeat',
				advice: `Start it (${start}). Heartbeats begin as soon as it boots.`,
				instance: null,
				startedAt: null,
				beatAt: null,
				meta: {}
			};
		const stale = Date.now() - new Date(b.beatAt).getTime() > STALE_AFTER_MS;
		return {
			id,
			name,
			health: stale ? 'down' : 'healthy',
			detail: stale ? 'Heartbeat stopped' : detail(b.meta ?? {}),
			advice: stale
				? `The process stopped reporting. Check that it is running (${start}) and can reach Postgres.`
				: null,
			instance: b.instance,
			startedAt: b.startedAt,
			beatAt: b.beatAt,
			meta: b.meta ?? {}
		};
	};
	return [
		web,
		beat('worker', 'Worker', () => 'Heartbeat OK'),
		beat(
			'collab',
			'Collab server',
			(m) => `${m.connections ?? 0} connections · ${m.documents ?? 0} open notes`
		)
	];
}

// ── Jobs ────────────────────────────────────────────────────────────────────

export type Job = {
	name: JobName;
	label: string;
	schedule: string;
	paused: boolean;
	pausedBy: string | null;
	lastStartedAt: Date | null;
	lastOk: boolean | null;
	lastError: string | null;
	lastDurationMs: number | null;
	failures24h: number;
	runs24h: number;
};

export async function jobs(): Promise<Job[]> {
	const [states, counts] = await Promise.all([
		sql<
			{
				name: string;
				paused: boolean;
				pausedBy: string | null;
				lastStartedAt: Date | null;
				lastOk: boolean | null;
				lastError: string | null;
				lastDurationMs: number | null;
			}[]
		>`select name, paused, paused_by as "pausedBy", last_started_at as "lastStartedAt",
			last_ok as "lastOk", last_error as "lastError", last_duration_ms as "lastDurationMs"
			from job_state`,
		sql<{ job: string; runs: number; failures: number }[]>`
			select job, count(*)::int as runs, count(*) filter (where not ok)::int as failures
			from job_run where started_at > now() - interval '24 hours' group by job`
	]);
	return (Object.keys(JOBS) as JobName[]).map((name) => {
		const s = states.find((x) => x.name === name);
		const c = counts.find((x) => x.job === name);
		return {
			name,
			...JOBS[name],
			paused: s?.paused ?? false,
			pausedBy: s?.pausedBy ?? null,
			lastStartedAt: s?.lastStartedAt ?? null,
			lastOk: s?.lastOk ?? null,
			lastError: s?.lastError ?? null,
			lastDurationMs: s?.lastDurationMs ?? null,
			failures24h: c?.failures ?? 0,
			runs24h: c?.runs ?? 0
		};
	});
}

export type JobRun = {
	id: string;
	startedAt: Date;
	durationMs: number;
	ok: boolean;
	error: string | null;
	trigger: string;
};

export function jobRuns(name: JobName, limit = 25) {
	return sql<JobRun[]>`
		select id, started_at as "startedAt", duration_ms as "durationMs", ok, error, trigger
		from job_run where job = ${name} order by started_at desc limit ${limit}`;
}

// ── Overview ────────────────────────────────────────────────────────────────

export async function metrics() {
	const [[sessions], [queue], [deliveries], [failures]] = await Promise.all([
		sql<{ active: number; recent: number; workspaces: number }[]>`
			select count(distinct s.user_id)::int as active,
				count(distinct s.user_id) filter (where s.updated_at > now() - interval '24 hours')::int as recent,
				(select count(*)::int from organization) as workspaces
			from session s where s.expires_at > now()`,
		sql<{ depth: number; oldest: Date | null }[]>`
			select count(*)::int as depth, min(created_on) as oldest
			from pgboss.job where state in ('created', 'retry')`.catch(() => [{ depth: 0, oldest: null }]),
		sql<{ pending: number; failed: number }[]>`
			select count(*) filter (where status = 'pending')::int as pending,
				count(*) filter (where status = 'failed' and created_at > now() - interval '24 hours')::int as failed
			from notification_delivery`,
		sql<{ count: number }[]>`
			select count(*)::int as count from job_run
			where not ok and started_at > now() - interval '24 hours'`
	]);
	return {
		activeUsers: sessions!.active,
		recentUsers: sessions!.recent,
		workspaces: sessions!.workspaces,
		queueDepth: queue!.depth + deliveries!.pending,
		pendingDeliveries: deliveries!.pending,
		failedDeliveries: deliveries!.failed,
		oldestQueued: queue!.oldest,
		failedRuns: failures!.count
	};
}

// ── Integrations ────────────────────────────────────────────────────────────

export type Provider = {
	provider: string;
	total: number;
	active: number;
	errored: number;
	revoked: number;
	failing: number;
	rateLimited: number;
	lastPolledAt: Date | null;
};

export function providers() {
	return sql<Provider[]>`
		select c.provider,
			count(*)::int as total,
			count(*) filter (where c.status = 'active')::int as active,
			count(*) filter (where c.status = 'error')::int as errored,
			count(*) filter (where c.status = 'revoked')::int as revoked,
			count(*) filter (where c.failure_count > 0)::int as failing,
			count(*) filter (where exists (
				select 1 from slack_rate_limit r where r.connection_id = c.id and r.blocked_until > now()
			))::int as "rateLimited",
			max(c.last_polled_at) as "lastPolledAt"
		from integration_connection c group by c.provider order by c.provider`;
}

export type Connection = {
	id: string;
	userEmail: string;
	accountLogin: string | null;
	authType: string;
	status: string;
	lastError: string | null;
	failureCount: number;
	lastPolledAt: Date | null;
	nextPollAt: Date | null;
	blockedUntil: Date | null;
};

/** Never selects tokens. */
export function connections(provider: string) {
	return sql<Connection[]>`
		select c.id, u.email as "userEmail", c.account_login as "accountLogin", c.auth_type as "authType",
			c.status, c.last_error as "lastError", c.failure_count as "failureCount",
			c.last_polled_at as "lastPolledAt", c.next_poll_at as "nextPollAt",
			(select max(r.blocked_until) from slack_rate_limit r
				where r.connection_id = c.id and r.blocked_until > now()) as "blockedUntil"
		from integration_connection c join "user" u on u.id = c.user_id
		where c.provider = ${provider}
		order by (c.status <> 'active') desc, c.failure_count desc, u.email`;
}

// ── Users & workspaces ──────────────────────────────────────────────────────

export type UserRow = {
	id: string;
	name: string;
	email: string;
	createdAt: Date;
	twoFactor: boolean;
	superadmin: boolean;
	disabled: boolean;
	workspaces: number;
	sessions: number;
	lastSeen: Date | null;
};

export function users(q: string, limit = 100, id: string | null = null) {
	const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
	return sql<UserRow[]>`
		select u.id, u.name, u.email, u.created_at as "createdAt",
			coalesce(u.two_factor_enabled, false) as "twoFactor",
			coalesce(u.superadmin, false) as superadmin, coalesce(u.disabled, false) as disabled,
			(select count(*)::int from member m where m.user_id = u.id) as workspaces,
			(select count(*)::int from session s where s.user_id = u.id and s.expires_at > now()) as sessions,
			(select max(s.updated_at) from session s where s.user_id = u.id) as "lastSeen"
		from "user" u
		where (${q} = '' or u.email ilike ${like} or u.name ilike ${like})
			and (${id}::text is null or u.id = ${id})
		order by "lastSeen" desc nulls last, u.created_at desc limit ${limit}`;
}

export async function userDetail(id: string) {
	const [[u], memberships, sessions] = await Promise.all([
		users('', 1, id),
		sql<{ id: string; name: string; role: string; kind: string | null }[]>`
			select o.id, o.name, m.role, o.kind from member m join organization o on o.id = m.organization_id
			where m.user_id = ${id} order by o.name`,
		sql<
			{
				id: string;
				createdAt: Date;
				updatedAt: Date;
				ipAddress: string | null;
				userAgent: string | null;
			}[]
		>`
			select id, created_at as "createdAt", updated_at as "updatedAt", ip_address as "ipAddress",
				user_agent as "userAgent"
			from session where user_id = ${id} and expires_at > now() order by updated_at desc`
	]);
	return u ? { user: u, memberships, sessions } : null;
}

export type WorkspaceRow = {
	id: string;
	name: string;
	slug: string;
	kind: string | null;
	createdAt: Date;
	members: number;
	owner: string | null;
};

export function workspaces(q: string, limit = 100) {
	const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
	return sql<WorkspaceRow[]>`
		select o.id, o.name, o.slug, o.kind, o.created_at as "createdAt",
			(select count(*)::int from member m where m.organization_id = o.id) as members,
			(select u.email from member m join "user" u on u.id = m.user_id
				where m.organization_id = o.id and m.role like '%owner%' order by m.created_at limit 1) as owner
		from organization o
		where ${q} = '' or o.name ilike ${like} or o.slug ilike ${like}
		order by o.created_at desc limit ${limit}`;
}

export async function workspaceDetail(id: string) {
	const [[w], members] = await Promise.all([
		sql<WorkspaceRow[]>`
			select o.id, o.name, o.slug, o.kind, o.created_at as "createdAt",
				(select count(*)::int from member m where m.organization_id = o.id) as members,
				null as owner
			from organization o where o.id = ${id}`,
		sql<{ id: string; name: string; email: string; role: string }[]>`
			select u.id, u.name, u.email, m.role from member m join "user" u on u.id = m.user_id
			where m.organization_id = ${id} order by m.role, u.email`
	]);
	return w ? { workspace: w, members } : null;
}

// ── Audit ───────────────────────────────────────────────────────────────────

export type AuditRow = {
	id: string;
	createdAt: Date;
	actorEmail: string;
	action: string;
	targetType: string | null;
	targetId: string | null;
	targetLabel: string | null;
	reason: string | null;
};

export function audit(action: string, limit = 200, before: Date | null = null) {
	return sql<AuditRow[]>`
		select id, created_at as "createdAt", actor_email as "actorEmail", action,
			target_type as "targetType", target_id as "targetId", meta->>'label' as "targetLabel", reason
		from admin_audit
		where (${action} = '' or action like ${action + '%'})
			and (${before}::timestamptz is null or created_at < ${before})
		order by created_at desc limit ${limit}`;
}
