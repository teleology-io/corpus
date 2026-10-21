import type { PageLoad } from './$types';

// Recording needs browser APIs only.
export const ssr = false;
export const load: PageLoad = () => ({ title: 'New recording' });
