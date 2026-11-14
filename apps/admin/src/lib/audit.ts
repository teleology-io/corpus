/** Human labels for audit action ids. Unknown ids fall back to the raw id. */
export const ACTION_LABELS: Record<string, string> = {
	'job.run': 'Requested job run',
	'job.pause': 'Paused job',
	'job.resume': 'Resumed job',
	'connection.retry': 'Retried connection',
	'user.revoke_sessions': 'Revoked sessions',
	'user.disable': 'Disabled user',
	'user.enable': 'Enabled user',
	'superadmin.grant': 'Granted superadmin',
	'superadmin.revoke': 'Revoked superadmin'
};

export const actionLabel = (id: string) => ACTION_LABELS[id] ?? id;
