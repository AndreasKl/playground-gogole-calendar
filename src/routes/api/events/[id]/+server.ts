import { json, error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import type { DbEvent, UpdateEventPayload, DeleteEventPayload, RecurrenceRule } from '$lib/types';
import type { RequestHandler } from './$types';

// ─── GET /api/events/[id] ─────────────────────────────────────────────────────
export const GET: RequestHandler = async ({ params }) => {
	const db = getDb();
	const [event] = await db<DbEvent[]>`
		SELECT * FROM events WHERE id = ${params.id}
	`;
	if (!event) return error(404, 'Event not found');
	return json(event);
};

// ─── PUT /api/events/[id] ─────────────────────────────────────────────────────
export const PUT: RequestHandler = async ({ params, request }) => {
	const db = getDb();
	const body: UpdateEventPayload = await request.json();

	const [existing] = await db<DbEvent[]>`SELECT * FROM events WHERE id = ${params.id}`;
	if (!existing) return error(404, 'Event not found');

	switch (body.scope) {
		case 'all':
			return updateAll(db, existing, body);
		case 'this':
			return updateThis(db, existing, body);
		case 'this_and_future':
			return updateThisAndFuture(db, existing, body);
		default:
			return error(400, 'Invalid scope');
	}
};

// ─── DELETE /api/events/[id] ──────────────────────────────────────────────────
export const DELETE: RequestHandler = async ({ params, request }) => {
	const db = getDb();
	const body: DeleteEventPayload = await request.json();

	const [existing] = await db<DbEvent[]>`SELECT * FROM events WHERE id = ${params.id}`;
	if (!existing) return error(404, 'Event not found');

	switch (body.scope) {
		case 'all': {
			await db`DELETE FROM events WHERE id = ${params.id}`;
			return new Response(null, { status: 204 });
		}
		case 'this': {
			if (!body.occurrence_starts_at) return error(400, 'occurrence_starts_at required');
			// Create a cancellation exception
			await db`
				INSERT INTO event_exceptions (event_id, occurrence_starts_at, is_cancelled)
				VALUES (${params.id}, ${new Date(body.occurrence_starts_at)}, TRUE)
				ON CONFLICT (event_id, occurrence_starts_at)
				DO UPDATE SET is_cancelled = TRUE, updated_at = NOW()
			`;
			return new Response(null, { status: 204 });
		}
		case 'this_and_future': {
			if (!body.occurrence_starts_at) return error(400, 'occurrence_starts_at required');
			// Truncate the series: set series_ends_at to the day before this occurrence
			const cutoff = new Date(body.occurrence_starts_at);
			cutoff.setUTCDate(cutoff.getUTCDate() - 1);

			// Also update rule.until if present
			const rule = existing.recurrence_rule as RecurrenceRule | null;
			let updatedRule = rule;
			if (rule) {
				updatedRule = { ...rule, until: cutoff.toISOString().slice(0, 10) };
				delete updatedRule.count;
			}

			await db`
				UPDATE events
				SET series_ends_at = ${cutoff},
				    recurrence_rule = ${updatedRule ?? null},
				    updated_at = NOW()
				WHERE id = ${params.id}
			`;

			// Remove any exceptions on or after cutoff
			await db`
				DELETE FROM event_exceptions
				WHERE event_id = ${params.id}
				  AND occurrence_starts_at >= ${new Date(body.occurrence_starts_at)}
			`;
			return new Response(null, { status: 204 });
		}
		default:
			return error(400, 'Invalid scope');
	}
};

// ─── Scope handlers ───────────────────────────────────────────────────────────

async function updateAll(db: ReturnType<typeof getDb>, existing: DbEvent, body: UpdateEventPayload) {
	const rule = body.recurrence_rule ?? (existing.recurrence_rule as RecurrenceRule | null);
	const isRecurring = Boolean(rule);

	let seriesEndsAt = existing.series_ends_at;
	if (rule?.until) seriesEndsAt = new Date(rule.until + 'T23:59:59Z');

	const [updated] = await db<DbEvent[]>`
		UPDATE events SET
			title            = ${body.title ?? existing.title},
			description      = ${body.description ?? existing.description},
			location         = ${body.location ?? existing.location},
			starts_at        = ${body.starts_at ? new Date(body.starts_at) : existing.starts_at},
			ends_at          = ${body.ends_at   ? new Date(body.ends_at)   : existing.ends_at},
			is_recurring     = ${isRecurring},
			recurrence_rule  = ${isRecurring ? rule : null},
			series_ends_at   = ${seriesEndsAt},
			updated_at       = NOW()
		WHERE id = ${existing.id}
		RETURNING *
	`;
	return json(updated);
}

async function updateThis(db: ReturnType<typeof getDb>, existing: DbEvent, body: UpdateEventPayload) {
	if (!body.occurrence_starts_at) {
		return error(400, 'occurrence_starts_at required for scope=this');
	}
	const occurrenceKey = new Date(body.occurrence_starts_at);

	// Upsert an exception row
	const [ex] = await db`
		INSERT INTO event_exceptions (
			event_id, occurrence_starts_at,
			title, description, location, starts_at, ends_at
		) VALUES (
			${existing.id},
			${occurrenceKey},
			${body.title ?? null},
			${body.description ?? null},
			${body.location ?? null},
			${body.starts_at ? new Date(body.starts_at) : null},
			${body.ends_at   ? new Date(body.ends_at)   : null}
		)
		ON CONFLICT (event_id, occurrence_starts_at) DO UPDATE SET
			title       = COALESCE(EXCLUDED.title,       event_exceptions.title),
			description = COALESCE(EXCLUDED.description, event_exceptions.description),
			location    = COALESCE(EXCLUDED.location,    event_exceptions.location),
			starts_at   = COALESCE(EXCLUDED.starts_at,   event_exceptions.starts_at),
			ends_at     = COALESCE(EXCLUDED.ends_at,     event_exceptions.ends_at),
			is_cancelled = FALSE,
			updated_at  = NOW()
		RETURNING *
	`;
	return json(ex);
}

async function updateThisAndFuture(db: ReturnType<typeof getDb>, existing: DbEvent, body: UpdateEventPayload) {
	if (!body.occurrence_starts_at) {
		return error(400, 'occurrence_starts_at required for scope=this_and_future');
	}

	const splitPoint = new Date(body.occurrence_starts_at);

	// 1. Truncate the original series to end just before splitPoint
	const cutoff = new Date(splitPoint);
	cutoff.setUTCDate(cutoff.getUTCDate() - 1);

	const origRule = existing.recurrence_rule as RecurrenceRule | null;
	let truncatedRule = origRule;
	if (origRule) {
		truncatedRule = { ...origRule, until: cutoff.toISOString().slice(0, 10) };
		delete truncatedRule.count;
	}

	await db`
		UPDATE events SET
			series_ends_at  = ${cutoff},
			recurrence_rule = ${truncatedRule ?? null},
			updated_at      = NOW()
		WHERE id = ${existing.id}
	`;

	// Remove exceptions on or after splitPoint from old series
	await db`
		DELETE FROM event_exceptions
		WHERE event_id = ${existing.id}
		  AND occurrence_starts_at >= ${splitPoint}
	`;

	// 2. Create new series from splitPoint onwards with updated fields
	const newRule = body.recurrence_rule ?? (existing.recurrence_rule as RecurrenceRule | null);
	const isRecurring = Boolean(newRule);
	const newStart = body.starts_at ? new Date(body.starts_at) : splitPoint;
	const duration = existing.ends_at.getTime() - existing.starts_at.getTime();
	const newEnd = body.ends_at ? new Date(body.ends_at) : new Date(newStart.getTime() + duration);

	let newSeriesEndsAt: Date | null = null;
	if (newRule?.until) newSeriesEndsAt = new Date(newRule.until + 'T23:59:59Z');

	const [newEvent] = await db<DbEvent[]>`
		INSERT INTO events (
			calendar_id, title, description, location,
			starts_at, ends_at, all_day,
			is_recurring, recurrence_rule, series_ends_at
		) VALUES (
			${existing.calendar_id},
			${body.title ?? existing.title},
			${body.description ?? existing.description},
			${body.location    ?? existing.location},
			${newStart},
			${newEnd},
			${existing.all_day},
			${isRecurring},
			${isRecurring ? newRule : null},
			${newSeriesEndsAt}
		)
		RETURNING *
	`;

	return json(newEvent, { status: 201 });
}
