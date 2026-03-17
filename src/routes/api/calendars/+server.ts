import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	const db = getDb();
	const calendars = await db`
		SELECT id, user_id, name, color, created_at
		FROM calendars
		ORDER BY name
	`;
	return json(calendars);
};
