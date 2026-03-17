import { describe, it, expect } from 'vitest';
import { expandOccurrences, applyExceptions } from '$lib/server/recurrence';
import type { DbEvent, DbEventException } from '$lib/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal DbEvent for testing */
function makeEvent(overrides: Partial<DbEvent> & {
	starts_at: Date;
	ends_at: Date;
	recurrence_rule?: DbEvent['recurrence_rule'];
}): DbEvent {
	return {
		id: 'evt-1',
		calendar_id: 'cal-1',
		title: 'Test event',
		description: null,
		location: null,
		all_day: false,
		is_recurring: overrides.recurrence_rule != null,
		series_ends_at: null,
		created_at: new Date('2026-01-01T00:00:00Z'),
		updated_at: new Date('2026-01-01T00:00:00Z'),
		...overrides,
	};
}

/** Build a minimal DbEventException */
function makeException(
	eventId: string,
	occurrenceStartsAt: Date,
	overrides: Partial<DbEventException> = {},
): DbEventException {
	return {
		id: 'ex-1',
		event_id: eventId,
		occurrence_starts_at: occurrenceStartsAt,
		is_cancelled: false,
		title: null,
		description: null,
		location: null,
		starts_at: null,
		ends_at: null,
		created_at: new Date('2026-01-01T00:00:00Z'),
		updated_at: new Date('2026-01-01T00:00:00Z'),
		...overrides,
	};
}

/** UTC date shorthand */
const d = (iso: string) => new Date(iso);

// ─── expandOccurrences ────────────────────────────────────────────────────────

describe('expandOccurrences', () => {

	// ── non-recurring ────────────────────────────────────────────────────────

	it('returns empty array for a non-recurring event', () => {
		const ev = makeEvent({
			starts_at: d('2026-02-23T09:00:00Z'),
			ends_at:   d('2026-02-23T10:00:00Z'),
		});
		const result = expandOccurrences(ev, d('2026-02-23T00:00:00Z'), d('2026-03-02T00:00:00Z'));
		expect(result).toEqual([]);
	});

	// ── daily ────────────────────────────────────────────────────────────────

	it('daily: produces one occurrence per day in range', () => {
		const ev = makeEvent({
			starts_at: d('2026-02-23T09:00:00Z'),
			ends_at:   d('2026-02-23T10:00:00Z'),
			recurrence_rule: { frequency: 'daily', interval: 1 },
		});

		const result = expandOccurrences(ev, d('2026-02-23T00:00:00Z'), d('2026-02-28T00:00:00Z'));
		expect(result).toHaveLength(5);
		expect(result[0]).toEqual(d('2026-02-23T09:00:00Z'));
		expect(result[4]).toEqual(d('2026-02-27T09:00:00Z'));
	});

	it('daily: omits occurrences before rangeStart', () => {
		const ev = makeEvent({
			starts_at: d('2026-02-20T09:00:00Z'),
			ends_at:   d('2026-02-20T10:00:00Z'),
			recurrence_rule: { frequency: 'daily', interval: 1 },
		});
		const result = expandOccurrences(ev, d('2026-02-23T00:00:00Z'), d('2026-02-25T00:00:00Z'));
		expect(result).toHaveLength(2);
		expect(result[0]).toEqual(d('2026-02-23T09:00:00Z'));
	});

	it('daily: stops at count limit', () => {
		const ev = makeEvent({
			starts_at: d('2026-02-23T09:00:00Z'),
			ends_at:   d('2026-02-23T10:00:00Z'),
			recurrence_rule: { frequency: 'daily', interval: 1, count: 3 },
		});
		// Range is much wider than count allows
		const result = expandOccurrences(ev, d('2026-02-23T00:00:00Z'), d('2026-03-10T00:00:00Z'));
		expect(result).toHaveLength(3);
	});

	it('daily: stops at until date', () => {
		const ev = makeEvent({
			starts_at: d('2026-02-23T09:00:00Z'),
			ends_at:   d('2026-02-23T10:00:00Z'),
			recurrence_rule: { frequency: 'daily', interval: 1, until: '2026-02-25' },
			series_ends_at: d('2026-02-25'),
		});
		const result = expandOccurrences(ev, d('2026-02-23T00:00:00Z'), d('2026-03-01T00:00:00Z'));
		// until 2026-02-25: occurrences on 23, 24, 25
		expect(result.length).toBeGreaterThanOrEqual(2);
		// None should be after the until date
		for (const occ of result) {
			expect(occ.getTime()).toBeLessThanOrEqual(d('2026-02-25T23:59:59Z').getTime());
		}
	});

	it('daily: interval=2 produces every-other-day occurrences', () => {
		const ev = makeEvent({
			starts_at: d('2026-02-23T09:00:00Z'),
			ends_at:   d('2026-02-23T10:00:00Z'),
			recurrence_rule: { frequency: 'daily', interval: 2 },
		});
		const result = expandOccurrences(ev, d('2026-02-23T00:00:00Z'), d('2026-03-01T00:00:00Z'));
		// 23, 25, 27 → 3 occurrences (Mar 1 is range end, exclusive)
		expect(result).toHaveLength(3);
		expect(result[0]).toEqual(d('2026-02-23T09:00:00Z'));
		expect(result[1]).toEqual(d('2026-02-25T09:00:00Z'));
		expect(result[2]).toEqual(d('2026-02-27T09:00:00Z'));
	});

	it('daily: returns empty when range is entirely before series start', () => {
		const ev = makeEvent({
			starts_at: d('2026-03-01T09:00:00Z'),
			ends_at:   d('2026-03-01T10:00:00Z'),
			recurrence_rule: { frequency: 'daily', interval: 1 },
		});
		const result = expandOccurrences(ev, d('2026-02-01T00:00:00Z'), d('2026-02-28T00:00:00Z'));
		expect(result).toHaveLength(0);
	});

	// ── weekly (no byday) ─────────────────────────────────────────────────────

	it('weekly: produces one occurrence per week', () => {
		const ev = makeEvent({
			starts_at: d('2026-02-23T10:00:00Z'), // Monday
			ends_at:   d('2026-02-23T11:00:00Z'),
			recurrence_rule: { frequency: 'weekly', interval: 1 },
		});
		const result = expandOccurrences(ev, d('2026-02-23T00:00:00Z'), d('2026-03-16T00:00:00Z'));
		expect(result).toHaveLength(3); // Feb 23, Mar 2, Mar 9
		expect(result[1]).toEqual(d('2026-03-02T10:00:00Z'));
	});

	it('weekly: interval=2 produces biweekly occurrences', () => {
		const ev = makeEvent({
			starts_at: d('2026-02-23T10:00:00Z'),
			ends_at:   d('2026-02-23T11:00:00Z'),
			recurrence_rule: { frequency: 'weekly', interval: 2 },
		});
		const result = expandOccurrences(ev, d('2026-02-23T00:00:00Z'), d('2026-03-23T00:00:00Z'));
		// Feb 23, Mar 9, Mar 23 (exclusive → Mar 9 only within range)
		expect(result).toHaveLength(2);
		expect(result[1]).toEqual(d('2026-03-09T10:00:00Z'));
	});

	// ── weekly with byday ─────────────────────────────────────────────────────

	it('weekly+byday: emits correct days within each qualifying week', () => {
		// Every Mon, Wed, Fri
		const ev = makeEvent({
			starts_at: d('2026-02-23T09:00:00Z'), // anchor = Monday
			ends_at:   d('2026-02-23T09:30:00Z'),
			recurrence_rule: { frequency: 'weekly', interval: 1, byday: ['MO', 'WE', 'FR'] },
		});
		const result = expandOccurrences(
			ev,
			d('2026-02-23T00:00:00Z'),
			d('2026-03-02T00:00:00Z'), // one week window
		);
		expect(result).toHaveLength(3);
		expect(result[0]).toEqual(d('2026-02-23T09:00:00Z')); // Mon
		expect(result[1]).toEqual(d('2026-02-25T09:00:00Z')); // Wed
		expect(result[2]).toEqual(d('2026-02-27T09:00:00Z')); // Fri
	});

	it('weekly+byday: single day (Wednesday standup)', () => {
		const ev = makeEvent({
			starts_at: d('2026-02-25T09:00:00Z'), // Wed anchor
			ends_at:   d('2026-02-25T09:30:00Z'),
			recurrence_rule: { frequency: 'weekly', interval: 1, byday: ['WE'] },
		});
		const result = expandOccurrences(
			ev,
			d('2026-02-23T00:00:00Z'),
			d('2026-03-16T00:00:00Z'),
		);
		// Wed Feb 25, Mar 4, Mar 11
		expect(result).toHaveLength(3);
		for (const occ of result) {
			expect(occ.getUTCDay()).toBe(3); // 3 = Wednesday
		}
	});

	it('weekly+byday: does not emit days before the series anchor', () => {
		// Anchor is Wednesday; Mon/Wed/Fri requested — should NOT emit Monday of the anchor week
		const ev = makeEvent({
			starts_at: d('2026-02-25T09:00:00Z'), // Wednesday
			ends_at:   d('2026-02-25T10:00:00Z'),
			recurrence_rule: { frequency: 'weekly', interval: 1, byday: ['MO', 'WE', 'FR'] },
		});
		const result = expandOccurrences(
			ev,
			d('2026-02-23T00:00:00Z'), // range starts on Mon of same week
			d('2026-03-02T00:00:00Z'),
		);
		// Only Wed Feb 25 and Fri Feb 27 — NOT Mon Feb 23 (before anchor)
		expect(result.some(d => d.getUTCDate() === 23)).toBe(false);
		expect(result.some(d => d.getUTCDate() === 25)).toBe(true);
		expect(result.some(d => d.getUTCDate() === 27)).toBe(true);
	});

	it('weekly+byday: respects count limit across multiple days per week', () => {
		const ev = makeEvent({
			starts_at: d('2026-02-23T09:00:00Z'),
			ends_at:   d('2026-02-23T09:30:00Z'),
			recurrence_rule: { frequency: 'weekly', interval: 1, byday: ['MO', 'WE', 'FR'], count: 5 },
		});
		const result = expandOccurrences(ev, d('2026-02-23T00:00:00Z'), d('2026-04-01T00:00:00Z'));
		expect(result).toHaveLength(5);
	});

	// ── monthly ───────────────────────────────────────────────────────────────

	it('monthly: produces one occurrence per month', () => {
		const ev = makeEvent({
			starts_at: d('2026-01-15T10:00:00Z'),
			ends_at:   d('2026-01-15T11:00:00Z'),
			recurrence_rule: { frequency: 'monthly', interval: 1 },
		});
		const result = expandOccurrences(ev, d('2026-01-01T00:00:00Z'), d('2026-05-01T00:00:00Z'));
		expect(result).toHaveLength(4); // Jan, Feb, Mar, Apr
		expect(result[0]).toEqual(d('2026-01-15T10:00:00Z'));
		expect(result[3]).toEqual(d('2026-04-15T10:00:00Z'));
	});

	// ── yearly ────────────────────────────────────────────────────────────────

	it('yearly: produces one occurrence per year', () => {
		const ev = makeEvent({
			starts_at: d('2024-03-14T09:00:00Z'),
			ends_at:   d('2024-03-14T10:00:00Z'),
			recurrence_rule: { frequency: 'yearly', interval: 1 },
		});
		const result = expandOccurrences(ev, d('2024-01-01T00:00:00Z'), d('2027-01-01T00:00:00Z'));
		expect(result).toHaveLength(3); // 2024, 2025, 2026
		expect(result[1]).toEqual(d('2025-03-14T09:00:00Z'));
	});

	// ── time of day preserved ─────────────────────────────────────────────────

	it('preserves the anchor time-of-day on all occurrences', () => {
		const ev = makeEvent({
			starts_at: d('2026-02-23T14:30:00Z'), // 2:30 PM UTC
			ends_at:   d('2026-02-23T15:00:00Z'),
			recurrence_rule: { frequency: 'daily', interval: 1 },
		});
		const result = expandOccurrences(ev, d('2026-02-23T00:00:00Z'), d('2026-02-26T00:00:00Z'));
		for (const occ of result) {
			expect(occ.getUTCHours()).toBe(14);
			expect(occ.getUTCMinutes()).toBe(30);
		}
	});
});

// ─── applyExceptions ──────────────────────────────────────────────────────────

describe('applyExceptions', () => {
	const baseEvent = makeEvent({
		id: 'evt-recurring',
		starts_at: d('2026-02-23T09:00:00Z'),
		ends_at:   d('2026-02-23T10:00:00Z'),
		recurrence_rule: { frequency: 'daily', interval: 1 },
	});

	const range = {
		start: d('2026-02-23T00:00:00Z'),
		end:   d('2026-02-28T00:00:00Z'),
	};

	it('returns all occurrences when no exceptions exist', () => {
		const result = applyExceptions(baseEvent, [], range.start, range.end, '#1a73e8', 'Work');
		expect(result).toHaveLength(5);
	});

	it('includes calendar metadata on each occurrence', () => {
		const result = applyExceptions(baseEvent, [], range.start, range.end, '#0f9d58', 'Personal');
		expect(result[0].calendar_color).toBe('#0f9d58');
		expect(result[0].calendar_name).toBe('Personal');
	});

	it('sets occurrence_starts_at to the original scheduled time', () => {
		const result = applyExceptions(baseEvent, [], range.start, range.end, '#000', 'X');
		expect(result[0].occurrence_starts_at).toBe(d('2026-02-23T09:00:00Z').toISOString());
		expect(result[2].occurrence_starts_at).toBe(d('2026-02-25T09:00:00Z').toISOString());
	});

	it('cancellation removes the occurrence', () => {
		const exceptions = [
			makeException('evt-recurring', d('2026-02-25T09:00:00Z'), { is_cancelled: true }),
		];
		const result = applyExceptions(baseEvent, exceptions, range.start, range.end, '#000', 'X');
		expect(result).toHaveLength(4);
		expect(result.map(e => e.starts_at)).not.toContain(d('2026-02-25T09:00:00Z').toISOString());
	});

	it('title override applies only to the specified occurrence', () => {
		const exceptions = [
			makeException('evt-recurring', d('2026-02-25T09:00:00Z'), { title: 'Special edition' }),
		];
		const result = applyExceptions(baseEvent, exceptions, range.start, range.end, '#000', 'X');
		expect(result).toHaveLength(5);
		const modified = result.find(e => e.occurrence_starts_at === d('2026-02-25T09:00:00Z').toISOString());
		expect(modified?.title).toBe('Special edition');
		// Others keep original title
		const others = result.filter(e => e.occurrence_starts_at !== d('2026-02-25T09:00:00Z').toISOString());
		for (const o of others) expect(o.title).toBe('Test event');
	});

	it('time override shifts starts_at and ends_at but keeps occurrence_starts_at stable', () => {
		const rescheduledStart = d('2026-02-25T11:00:00Z');
		const rescheduledEnd   = d('2026-02-25T12:00:00Z');
		const exceptions = [
			makeException('evt-recurring', d('2026-02-25T09:00:00Z'), {
				starts_at: rescheduledStart,
				ends_at:   rescheduledEnd,
			}),
		];
		const result = applyExceptions(baseEvent, exceptions, range.start, range.end, '#000', 'X');
		const modified = result.find(e => e.occurrence_starts_at === d('2026-02-25T09:00:00Z').toISOString());
		expect(modified?.starts_at).toBe(rescheduledStart.toISOString());
		expect(modified?.ends_at).toBe(rescheduledEnd.toISOString());
		// occurrence_starts_at is the ORIGINAL slot — unchanged
		expect(modified?.occurrence_starts_at).toBe(d('2026-02-25T09:00:00Z').toISOString());
	});

	it('null fields in exception inherit from the series', () => {
		const exceptions = [
			makeException('evt-recurring', d('2026-02-24T09:00:00Z'), {
				// Only description is overridden; title, location are null → inherit
				description: 'Custom notes',
			}),
		];
		const result = applyExceptions(baseEvent, exceptions, range.start, range.end, '#000', 'X');
		const modified = result.find(e => e.occurrence_starts_at === d('2026-02-24T09:00:00Z').toISOString());
		expect(modified?.title).toBe('Test event');        // inherited
		expect(modified?.description).toBe('Custom notes'); // overridden
	});

	it('exception_id is set on overridden occurrences but absent on clean ones', () => {
		const ex = makeException('evt-recurring', d('2026-02-24T09:00:00Z'), { id: 'ex-special' });
		const result = applyExceptions(baseEvent, [ex], range.start, range.end, '#000', 'X');
		const withException    = result.find(e => e.occurrence_starts_at === d('2026-02-24T09:00:00Z').toISOString());
		const withoutException = result.find(e => e.occurrence_starts_at === d('2026-02-23T09:00:00Z').toISOString());
		expect(withException?.exception_id).toBe('ex-special');
		expect(withoutException?.exception_id).toBeUndefined();
	});

	it('exceptions outside the requested range are ignored (not applied)', () => {
		// Exception is on Feb 20 — outside the Feb 23–28 range
		const exceptions = [
			makeException('evt-recurring', d('2026-02-20T09:00:00Z'), { is_cancelled: true }),
		];
		const result = applyExceptions(baseEvent, exceptions, range.start, range.end, '#000', 'X');
		// Should still return 5 occurrences (the Feb 20 cancellation is irrelevant to this window)
		expect(result).toHaveLength(5);
	});

	it('is_recurring flag is set to true on all expanded occurrences', () => {
		const result = applyExceptions(baseEvent, [], range.start, range.end, '#000', 'X');
		for (const occ of result) expect(occ.is_recurring).toBe(true);
	});

	it('duration is preserved from the base event when no time override', () => {
		// Base event is 1 hour long
		const result = applyExceptions(baseEvent, [], range.start, range.end, '#000', 'X');
		for (const occ of result) {
			const dur = new Date(occ.ends_at).getTime() - new Date(occ.starts_at).getTime();
			expect(dur).toBe(60 * 60 * 1000); // 1 hour in ms
		}
	});

	it('multiple cancellations reduce the result count correctly', () => {
		const exceptions = [
			makeException('evt-recurring', d('2026-02-24T09:00:00Z'), { is_cancelled: true }),
			makeException('evt-recurring', d('2026-02-26T09:00:00Z'), { is_cancelled: true }),
		];
		const result = applyExceptions(baseEvent, exceptions, range.start, range.end, '#000', 'X');
		expect(result).toHaveLength(3);
	});
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe('expandOccurrences edge cases', () => {
	it('range end is exclusive — occurrence exactly at rangeEnd is not included', () => {
		const ev = makeEvent({
			starts_at: d('2026-02-23T09:00:00Z'),
			ends_at:   d('2026-02-23T10:00:00Z'),
			recurrence_rule: { frequency: 'daily', interval: 1 },
		});
		// rangeEnd is exactly the occurrence time
		const result = expandOccurrences(ev, d('2026-02-22T00:00:00Z'), d('2026-02-23T09:00:00Z'));
		expect(result).toHaveLength(0);
	});

	it('single occurrence exactly at rangeStart is included', () => {
		const ev = makeEvent({
			starts_at: d('2026-02-23T09:00:00Z'),
			ends_at:   d('2026-02-23T10:00:00Z'),
			recurrence_rule: { frequency: 'daily', interval: 1 },
		});
		const result = expandOccurrences(ev, d('2026-02-23T09:00:00Z'), d('2026-02-24T00:00:00Z'));
		expect(result).toHaveLength(1);
		expect(result[0]).toEqual(d('2026-02-23T09:00:00Z'));
	});

	it('zero-width range returns empty', () => {
		const ev = makeEvent({
			starts_at: d('2026-02-23T09:00:00Z'),
			ends_at:   d('2026-02-23T10:00:00Z'),
			recurrence_rule: { frequency: 'daily', interval: 1 },
		});
		const result = expandOccurrences(ev, d('2026-02-23T09:00:00Z'), d('2026-02-23T09:00:00Z'));
		expect(result).toHaveLength(0);
	});

	it('series_ends_at on the DbEvent itself acts as a ceiling', () => {
		const ev = makeEvent({
			starts_at:      d('2026-02-23T09:00:00Z'),
			ends_at:        d('2026-02-23T10:00:00Z'),
			series_ends_at: d('2026-02-25'),
			recurrence_rule: { frequency: 'daily', interval: 1 },
		});
		const result = expandOccurrences(ev, d('2026-02-23T00:00:00Z'), d('2026-03-01T00:00:00Z'));
		expect(result.every(o => o <= d('2026-02-25T23:59:59Z'))).toBe(true);
	});
});
