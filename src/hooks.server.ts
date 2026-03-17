import { runMigrations } from '$lib/server/db';
import type { Handle } from '@sveltejs/kit';

// Run DB migrations once when the server starts
await runMigrations();

export const handle: Handle = async ({ event, resolve }) => {
	return resolve(event);
};
