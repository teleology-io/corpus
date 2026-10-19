// Creates .env from .env.example with fresh secrets. Never rewrites an existing .env
// (changing BETTER_AUTH_SECRET / ENCRYPTION_KEY invalidates sessions and stored tokens);
// it only fills in web-push keys when they're blank.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const ENV = '.env';
const secret = () => randomBytes(32).toString('base64');

function vapidKeys() {
	try {
		const require = createRequire(new URL('../apps/worker/package.json', import.meta.url));
		return require('web-push').generateVAPIDKeys();
	} catch {
		return null;
	}
}

function set(text, key, value) {
	const line = new RegExp(`^${key}=.*$`, 'm');
	return line.test(text) ? text.replace(line, `${key}=${value}`) : `${text}\n${key}=${value}\n`;
}

const fresh = !existsSync(ENV);
let text = readFileSync(fresh ? '.env.example' : ENV, 'utf8');

if (fresh) {
	text = set(text, 'BETTER_AUTH_SECRET', secret());
	text = set(text, 'ENCRYPTION_KEY', secret());
}

const blank = (key) => !new RegExp(`^${key}=\\S`, 'm').test(text);
if (blank('PUBLIC_VAPID_KEY') || blank('VAPID_PRIVATE_KEY')) {
	const keys = vapidKeys();
	if (keys) {
		text = set(text, 'PUBLIC_VAPID_KEY', keys.publicKey);
		text = set(text, 'VAPID_PRIVATE_KEY', keys.privateKey);
		if (!fresh) console.log('[env] added web-push keys to .env');
	}
}

if (fresh || text !== readFileSync(ENV, 'utf8')) writeFileSync(ENV, text);
if (fresh) console.log('[env] created .env with generated secrets');

if (/^(BETTER_AUTH_SECRET|ENCRYPTION_KEY)=(change-me)?\s*$/m.test(text)) {
	console.warn(
		'[env] warning: BETTER_AUTH_SECRET / ENCRYPTION_KEY still unset in .env — generate with: openssl rand -base64 32'
	);
}
