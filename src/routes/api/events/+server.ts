import { json, error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { applyExceptions } from '$lib/server/recurrence';
import type { DbEvent, DbEventException, CalendarEvent, CreateEventPayload, RecurrenceRule } from '$lib/types';
import type { RequestHandler } from './$types';

// ─── GET /api/events?start=&end= ─────────────────────────────────────────────
export const GET: RequestHandler = async ({ url }) => {
	const db = getDb();

	const startParam = url.searchParams.get('start');
	const endParam = url.searchParams.get('end');
	if (!startParam || !endParam) {
		return error(400, 'start and end query params required (ISO strings)');
	}

	const rangeStart = new Date(startParam);
	const rangeEnd = new Date(endParam);
	if (isNaN(rangeStart.getTime()) || isNaN(rangeEnd.getTime())) {
		return error(400, 'Invalid start or end date');
	}

	// Fetch single events that overlap the window
	const singleEvents = await db<DbEvent[]>`
		SELECT e.*, c.color AS calendar_color, c.name AS calendar_name
		FROM events e
		JOIN calendars c ON c.id = e.calendar_id
		WHERE e.is_recurring = FALSE
		  AND e.starts_at < ${rangeEnd}
		  AND e.ends_at   > ${rangeStart}
		ORDER BY e.starts_at
	`;

	// Fetch recurring series whose anchor is before rangeEnd and (no ceiling or ceiling > rangeStart)
	const recurringEvents = await db<DbEvent[]>`
		SELECT e.*, c.color AS calendar_color, c.name AS calendar_name
		FROM events e
		JOIN calendars c ON c.id = e.calendar_id
		WHERE e.is_recurring = TRUE
		  AND e.starts_at < ${rangeEnd}
		  AND (e.series_ends_at IS NULL OR e.series_ends_at > ${rangeStart})
		ORDER BY e.starts_at
	`;

	// Collect series IDs for bulk exception fetch
	const seriesIds = recurringEvents.map((e) => e.id);
	let exceptions: DbEventException[] = [];
	if (seriesIds.length > 0) {
		exceptions = await db<DbEventException[]>`
			SELECT * FROM event_exceptions
			WHERE event_id::text = ANY(${db.array(seriesIds)})
			  AND occurrence_starts_at >= ${rangeStart}
			  AND occurrence_starts_at <  ${rangeEnd}
		`;
	}

	// Group exceptions by event_id
	const exMap = new Map<string, DbEventException[]>();
	for (const ex of exceptions) {
		const list = exMap.get(ex.event_id) ?? [];
		list.push(ex);
		exMap.set(ex.event_id, list);
	}

	// Build response
	const results: CalendarEvent[] = [];

	// Single events
	for (const ev of singleEvents) {
		const row = ev as DbEvent & { calendar_color: string; calendar_name: string };
		results.push({
			id: row.id,
			calendar_id: row.calendar_id,
			calendar_color: row.calendar_color,
			calendar_name: row.calendar_name,
			title: row.title,
			description: row.description,
			location: row.location,
			starts_at: row.starts_at.toISOString(),
			ends_at: row.ends_at.toISOString(),
			all_day: row.all_day,
			is_recurring: false,
			recurrence_rule: null,
		});
	}

	// Recurring events: expand and apply exceptions
	for (const ev of recurringEvents) {
		const row = ev as DbEvent & { calendar_color: string; calendar_name: string };
		const exList = exMap.get(row.id) ?? [];
		const expanded = applyExceptions(row, exList, rangeStart, rangeEnd, row.calendar_color, row.calendar_name);
		results.push(...expanded);
	}

	// Sort by start time
	results.sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime());

	return json(results);
};

// ─── POST /api/events ─────────────────────────────────────────────────────────
export const POST: RequestHandler = async ({ request }) => {
	const db = getDb();

	const body: CreateEventPayload = await request.json();

	if (!body.calendar_id || !body.title || !body.starts_at || !body.ends_at) {
		return error(400, 'calendar_id, title, starts_at, ends_at are required');
	}

	const startsAt = new Date(body.starts_at);
	const endsAt = new Date(body.ends_at);
	if (endsAt <= startsAt) {
		return error(400, 'ends_at must be after starts_at');
	}

	const isRecurring = Boolean(body.recurrence_rule);
	let seriesEndsAt: Date | null = null;

	if (isRecurring && body.recurrence_rule) {
		const rule = body.recurrence_rule as RecurrenceRule;
		if (rule.until) {
			seriesEndsAt = new Date(rule.until + 'T23:59:59Z');
		} else if (rule.count) {
			// Approximate series end for indexing purposes
			seriesEndsAt = approximateSeriesEnd(startsAt, rule);
		}
	}

	const [event] = await db<DbEvent[]>`
		INSERT INTO events (
			calendar_id, title, description, location,
			starts_at, ends_at, all_day,
			is_recurring, recurrence_rule, series_ends_at
		) VALUES (
			${body.calendar_id},
			${body.title},
			${body.description ?? null},
			${body.location ?? null},
			${startsAt},
			${endsAt},
			${body.all_day ?? false},
			${isRecurring},
			${isRecurring ? body.recurrence_rule : null},
			${seriesEndsAt}
		)
		RETURNING *
	`;

	return json(event, { status: 201 });
};

// ─── helpers ──────────────────────────────────────────────────────────────────

function approximateSeriesEnd(start: Date, rule: RecurrenceRule): Date {
	const count = rule.count ?? 365;
	const interval = rule.interval ?? 1;
	const d = new Date(start);
	switch (rule.frequency) {
		case 'daily':   d.setUTCDate(d.getUTCDate() + count * interval); break;
		case 'weekly':  d.setUTCDate(d.getUTCDate() + count * interval * 7); break;
		case 'monthly': d.setUTCMonth(d.getUTCMonth() + count * interval); break;
		case 'yearly':  d.setUTCFullYear(d.getUTCFullYear() + count * interval); break;
	}
	return d;
}
