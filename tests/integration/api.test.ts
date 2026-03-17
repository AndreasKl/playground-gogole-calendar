/**
 * Integration tests for the Calendar API.
 *
 * Requirements:
 *   - PostgreSQL running (docker compose up -d)
 *   - Dev server running on port 5173 (npm run dev)
 *
 * The tests clean up the events they create via afterEach so they can be run
 * against the shared development database without permanent side effects.
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { CalendarEvent, DbCalendar } from '$lib/types';

const BASE = 'http://localhost:5173';

// IDs seeded by migrations/001_initial.sql
const PERSONAL_CAL = '00000000-0000-0000-0000-000000000010';
const WORK_CAL     = '00000000-0000-0000-0000-000000000011';

// Track created event IDs for cleanup
const createdIds: string[] = [];

async function api(path: string, init?: RequestInit) {
	const res = await fetch(`${BASE}${path}`, {
		headers: { 'Content-Type': 'application/json' },
		...init,
	});
	return res;
}

async function createEvent(body: object): Promise<{ id: string } & Record<string, unknown>> {
	const res = await api('/api/events', { method: 'POST', body: JSON.stringify(body) });
	expect(res.status).toBe(201);
	const data = await res.json();
	createdIds.push(data.id);
	return data;
}

async function getEventsInWeek(
	start = '2026-02-23T00:00:00Z',
	end   = '2026-03-02T00:00:00Z',
): Promise<CalendarEvent[]> {
	const res = await api(`/api/events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
	expect(res.ok).toBe(true);
	return res.json();
}

afterEach(async () => {
	// Clean up events created by this test
	for (const id of [...createdIds]) {
		await api(`/api/events/${id}`, {
			method: 'DELETE',
			body: JSON.stringify({ scope: 'all' }),
		});
	}
	createdIds.length = 0;
});

// ─── /api/calendars ───────────────────────────────────────────────────────────

describe('GET /api/calendars', () => {
	it('returns the seeded calendars', async () => {
		const res = await api('/api/calendars');
		expect(res.ok).toBe(true);
		const calendars: DbCalendar[] = await res.json();
		expect(calendars.length).toBeGreaterThanOrEqual(2);
		const names = calendars.map(c => c.name);
		expect(names).toContain('Personal');
		expect(names).toContain('Work');
	});

	it('includes a color field on each calendar', async () => {
		const res  = await api('/api/calendars');
		const cals: DbCalendar[] = await res.json();
		for (const cal of cals) {
			expect(cal.color).toMatch(/^#[0-9a-f]{6}$/i);
		}
	});
});

// ─── POST /api/events ─────────────────────────────────────────────────────────

describe('POST /api/events', () => {
	it('creates a single event and returns 201', async () => {
		const body = {
			calendar_id: PERSONAL_CAL,
			title:       'Single event',
			starts_at:   '2026-02-23T09:00:00Z',
			ends_at:     '2026-02-23T10:00:00Z',
		};
		const res = await api('/api/events', { method: 'POST', body: JSON.stringify(body) });
		expect(res.status).toBe(201);
		const data = await res.json();
		createdIds.push(data.id);
		expect(data.title).toBe('Single event');
		expect(data.is_recurring).toBe(false);
		expect(data.recurrence_rule).toBeNull();
	});

	it('creates a recurring event with the rule stored on the row', async () => {
		const rule = { frequency: 'weekly', interval: 1, byday: ['MO', 'WE'] };
		const ev = await createEvent({
			calendar_id: WORK_CAL,
			title:       'Recurring standup',
			starts_at:   '2026-02-23T09:00:00Z',
			ends_at:     '2026-02-23T09:30:00Z',
			recurrence_rule: rule,
		});
		expect(ev.is_recurring).toBe(true);
		expect(ev.recurrence_rule).toMatchObject(rule);
	});

	it('rejects a request missing required fields with 400', async () => {
		const res = await api('/api/events', {
			method: 'POST',
			body: JSON.stringify({ calendar_id: PERSONAL_CAL }), // missing title, times
		});
		expect(res.status).toBe(400);
	});

	it('rejects ends_at <= starts_at with 400', async () => {
		const res = await api('/api/events', {
			method: 'POST',
			body: JSON.stringify({
				calendar_id: PERSONAL_CAL,
				title:       'Bad times',
				starts_at:   '2026-02-23T10:00:00Z',
				ends_at:     '2026-02-23T09:00:00Z',
			}),
		});
		expect(res.status).toBe(400);
	});
});

// ─── GET /api/events ──────────────────────────────────────────────────────────

describe('GET /api/events', () => {
	it('returns 400 without start/end params', async () => {
		const res = await api('/api/events');
		expect(res.status).toBe(400);
	});

	it('returns single event within the requested window', async () => {
		const ev = await createEvent({
			calendar_id: PERSONAL_CAL,
			title:       'Visible event',
			starts_at:   '2026-02-24T14:00:00Z',
			ends_at:     '2026-02-24T15:00:00Z',
		});
		const events = await getEventsInWeek();
		const found = events.find(e => e.id === ev.id);
		expect(found).toBeDefined();
		expect(found?.title).toBe('Visible event');
		expect(found?.calendar_color).toMatch(/^#/);
		expect(found?.calendar_name).toBeDefined();
	});

	it('does not return an event outside the window', async () => {
		const ev = await createEvent({
			calendar_id: PERSONAL_CAL,
			title:       'Outside window',
			starts_at:   '2026-03-10T09:00:00Z',
			ends_at:     '2026-03-10T10:00:00Z',
		});
		const events = await getEventsInWeek(
			'2026-02-23T00:00:00Z',
			'2026-03-02T00:00:00Z',
		);
		expect(events.find(e => e.id === ev.id)).toBeUndefined();
	});

	it('expands a recurring event into multiple occurrences within the window', async () => {
		await createEvent({
			calendar_id: WORK_CAL,
			title:       'Daily standup',
			starts_at:   '2026-02-23T09:00:00Z',
			ends_at:     '2026-02-23T09:15:00Z',
			recurrence_rule: { frequency: 'daily', interval: 1 },
		});
		const events = await getEventsInWeek();
		const occurrences = events.filter(e => e.title === 'Daily standup');
		// Feb 23–Mar 1 = 7 days → 7 occurrences
		expect(occurrences.length).toBe(7);
	});

	it('expanded occurrences have occurrence_starts_at set', async () => {
		await createEvent({
			calendar_id: WORK_CAL,
			title:       'Check occurrence key',
			starts_at:   '2026-02-25T10:00:00Z',
			ends_at:     '2026-02-25T10:30:00Z',
			recurrence_rule: { frequency: 'weekly', interval: 1 },
		});
		const events = await getEventsInWeek();
		const occ = events.find(e => e.title === 'Check occurrence key');
		expect(occ?.occurrence_starts_at).toBeDefined();
		expect(occ?.is_recurring).toBe(true);
	});

	it('returns events sorted by starts_at', async () => {
		await createEvent({
			calendar_id: PERSONAL_CAL,
			title: 'Later event',
			starts_at: '2026-02-24T15:00:00Z',
			ends_at:   '2026-02-24T16:00:00Z',
		});
		await createEvent({
			calendar_id: PERSONAL_CAL,
			title: 'Earlier event',
			starts_at: '2026-02-24T09:00:00Z',
			ends_at:   '2026-02-24T10:00:00Z',
		});
		const events = await getEventsInWeek();
		const myEvents = events.filter(e => ['Later event', 'Earlier event'].includes(e.title));
		expect(myEvents[0].title).toBe('Earlier event');
		expect(myEvents[1].title).toBe('Later event');
	});
});

// ─── PUT /api/events/:id — scope=all ─────────────────────────────────────────

describe('PUT /api/events/:id scope=all', () => {
	it('updates title across the whole series', async () => {
		const ev = await createEvent({
			calendar_id: WORK_CAL,
			title:       'Original title',
			starts_at:   '2026-02-23T10:00:00Z',
			ends_at:     '2026-02-23T11:00:00Z',
			recurrence_rule: { frequency: 'daily', interval: 1 },
		});

		const putRes = await api(`/api/events/${ev.id}`, {
			method: 'PUT',
			body: JSON.stringify({ scope: 'all', title: 'Updated title' }),
		});
		expect(putRes.ok).toBe(true);

		const events = await getEventsInWeek();
		const occurrences = events.filter(e => e.id === ev.id);
		expect(occurrences.length).toBeGreaterThan(0);
		for (const occ of occurrences) {
			expect(occ.title).toBe('Updated title');
		}
	});

	it('returns 404 for a non-existent event', async () => {
		const res = await api('/api/events/00000000-0000-0000-0000-deadbeef0000', {
			method: 'PUT',
			body: JSON.stringify({ scope: 'all', title: 'Ghost' }),
		});
		expect(res.status).toBe(404);
	});
});

// ─── PUT /api/events/:id — scope=this ────────────────────────────────────────

describe('PUT /api/events/:id scope=this', () => {
	it('overrides only the specified occurrence, leaving others unchanged', async () => {
		const ev = await createEvent({
			calendar_id: WORK_CAL,
			title:       'Weekly sync',
			starts_at:   '2026-02-23T10:00:00Z',
			ends_at:     '2026-02-23T11:00:00Z',
			recurrence_rule: { frequency: 'weekly', interval: 1, byday: ['MO', 'WE', 'FR'] },
		});

		// The Wednesday occurrence
		const occurrenceKey = '2026-02-25T10:00:00Z';
		// Normalize to the format the API returns (Date#toISOString always includes ms)
		const normalizedKey = new Date(occurrenceKey).toISOString();

		await api(`/api/events/${ev.id}`, {
			method: 'PUT',
			body: JSON.stringify({
				scope: 'this',
				occurrence_starts_at: occurrenceKey,
				title: 'Wednesday special',
			}),
		});

		const events = await getEventsInWeek();
		const wednesdayOcc = events.find(
			e => e.id === ev.id && e.occurrence_starts_at === normalizedKey,
		);
		const otherOccs = events.filter(
			e => e.id === ev.id && e.occurrence_starts_at !== normalizedKey,
		);

		expect(wednesdayOcc?.title).toBe('Wednesday special');
		for (const occ of otherOccs) {
			expect(occ.title).toBe('Weekly sync');
		}
	});

	it('400 when occurrence_starts_at is missing for scope=this', async () => {
		const ev = await createEvent({
			calendar_id: WORK_CAL,
			title: 'Missing key test',
			starts_at: '2026-02-23T09:00:00Z',
			ends_at:   '2026-02-23T09:30:00Z',
			recurrence_rule: { frequency: 'weekly', interval: 1 },
		});
		const res = await api(`/api/events/${ev.id}`, {
			method: 'PUT',
			body: JSON.stringify({ scope: 'this', title: 'No key' }), // missing occurrence_starts_at
		});
		expect(res.status).toBe(400);
	});
});

// ─── PUT /api/events/:id — scope=this_and_future ─────────────────────────────

describe('PUT /api/events/:id scope=this_and_future', () => {
	it('creates a new series from the split point, old series is truncated', async () => {
		const ev = await createEvent({
			calendar_id: WORK_CAL,
			title:       'Daily report',
			starts_at:   '2026-02-23T08:00:00Z',
			ends_at:     '2026-02-23T08:30:00Z',
			recurrence_rule: { frequency: 'daily', interval: 1 },
		});

		const splitAt = '2026-02-26T08:00:00Z';

		const putRes = await api(`/api/events/${ev.id}`, {
			method: 'PUT',
			body: JSON.stringify({
				scope: 'this_and_future',
				occurrence_starts_at: splitAt,
				title: 'Renamed daily report',
			}),
		});
		expect(putRes.status).toBe(201);
		const newSeries = await putRes.json();
		createdIds.push(newSeries.id);

		const events = await getEventsInWeek();

		// Original series occurrences (Mon–Wed) have old title
		const original = events.filter(e => e.id === ev.id);
		expect(original.every(e => e.title === 'Daily report')).toBe(true);
		expect(original.every(e => new Date(e.starts_at) < new Date(splitAt))).toBe(true);

		// New series occurrences (Thu–Sun) have new title
		const newOccs = events.filter(e => e.id === newSeries.id);
		expect(newOccs.every(e => e.title === 'Renamed daily report')).toBe(true);
		expect(newOccs.every(e => new Date(e.starts_at) >= new Date(splitAt))).toBe(true);
	});
});

// ─── DELETE /api/events/:id ───────────────────────────────────────────────────

describe('DELETE /api/events/:id scope=all', () => {
	it('removes the entire event (single)', async () => {
		const ev = await createEvent({
			calendar_id: PERSONAL_CAL,
			title:       'To be deleted',
			starts_at:   '2026-02-24T12:00:00Z',
			ends_at:     '2026-02-24T13:00:00Z',
		});

		const delRes = await api(`/api/events/${ev.id}`, {
			method: 'DELETE',
			body: JSON.stringify({ scope: 'all' }),
		});
		expect(delRes.status).toBe(204);
		createdIds.splice(createdIds.indexOf(ev.id), 1); // already deleted

		const events = await getEventsInWeek();
		expect(events.find(e => e.id === ev.id)).toBeUndefined();
	});

	it('removes all occurrences of a recurring series', async () => {
		const ev = await createEvent({
			calendar_id: WORK_CAL,
			title:       'Delete whole series',
			starts_at:   '2026-02-23T08:00:00Z',
			ends_at:     '2026-02-23T08:30:00Z',
			recurrence_rule: { frequency: 'daily', interval: 1 },
		});

		await api(`/api/events/${ev.id}`, {
			method: 'DELETE',
			body: JSON.stringify({ scope: 'all' }),
		});
		createdIds.splice(createdIds.indexOf(ev.id), 1);

		const events = await getEventsInWeek();
		expect(events.filter(e => e.id === ev.id)).toHaveLength(0);
	});
});

describe('DELETE /api/events/:id scope=this', () => {
	it('cancels only the specified occurrence, others remain', async () => {
		const ev = await createEvent({
			calendar_id: WORK_CAL,
			title:       'Cancel one',
			starts_at:   '2026-02-23T10:00:00Z',
			ends_at:     '2026-02-23T10:30:00Z',
			recurrence_rule: { frequency: 'daily', interval: 1 },
		});

		const cancelSlot = '2026-02-25T10:00:00Z';
		const delRes = await api(`/api/events/${ev.id}`, {
			method: 'DELETE',
			body: JSON.stringify({ scope: 'this', occurrence_starts_at: cancelSlot }),
		});
		expect(delRes.status).toBe(204);

		const events  = await getEventsInWeek();
		const results = events.filter(e => e.id === ev.id);

		// Was 7 daily occurrences; now 6
		expect(results).toHaveLength(6);
		expect(results.map(e => e.starts_at)).not.toContain(cancelSlot);
	});
});

describe('DELETE /api/events/:id scope=this_and_future', () => {
	it('truncates the series at the given occurrence', async () => {
		const ev = await createEvent({
			calendar_id: WORK_CAL,
			title:       'Truncate me',
			starts_at:   '2026-02-23T10:00:00Z',
			ends_at:     '2026-02-23T10:30:00Z',
			recurrence_rule: { frequency: 'daily', interval: 1 },
		});

		// Delete from Thursday onwards
		const cutAt = '2026-02-26T10:00:00Z';
		const delRes = await api(`/api/events/${ev.id}`, {
			method: 'DELETE',
			body: JSON.stringify({ scope: 'this_and_future', occurrence_starts_at: cutAt }),
		});
		expect(delRes.status).toBe(204);

		const events  = await getEventsInWeek();
		const results = events.filter(e => e.id === ev.id);

		// Only Mon, Tue, Wed remain (3 occurrences)
		expect(results).toHaveLength(3);
		for (const occ of results) {
			expect(new Date(occ.starts_at) < new Date(cutAt)).toBe(true);
		}
	});
});

// ─── GET /api/events/:id ─────────────────────────────────────────────────────

describe('GET /api/events/:id', () => {
	it('returns the raw event row', async () => {
		const ev = await createEvent({
			calendar_id: PERSONAL_CAL,
			title:       'Fetch me',
			starts_at:   '2026-02-24T11:00:00Z',
			ends_at:     '2026-02-24T12:00:00Z',
		});
		const res = await api(`/api/events/${ev.id}`);
		expect(res.ok).toBe(true);
		const data = await res.json();
		expect(data.id).toBe(ev.id);
		expect(data.title).toBe('Fetch me');
	});

	it('returns 404 for a non-existent id', async () => {
		const res = await api('/api/events/00000000-0000-0000-0000-000000000000');
		expect(res.status).toBe(404);
	});
});
