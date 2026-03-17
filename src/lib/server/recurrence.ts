/**
 * Recurrence expansion engine.
 *
 * Given a recurring event series definition, produces all concrete occurrences
 * that fall within a [rangeStart, rangeEnd) window, then applies any stored
 * exceptions (cancellations / field overrides) to produce the final list.
 */

import type { DbEvent, DbEventException, CalendarEvent, RecurrenceRule, WeekDay } from '$lib/types';

// ─── Day-of-week helpers ──────────────────────────────────────────────────────

const WEEKDAY_INDEX: Record<WeekDay, number> = {
	SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6,
};

/** Return a new Date advanced by `n` days */
function addDays(d: Date, n: number): Date {
	const r = new Date(d);
	r.setUTCDate(r.getUTCDate() + n);
	return r;
}

/** Return a new Date advanced by `n` months (preserving time) */
function addMonths(d: Date, n: number): Date {
	const r = new Date(d);
	r.setUTCMonth(r.getUTCMonth() + n);
	return r;
}

/** Return a new Date advanced by `n` years */
function addYears(d: Date, n: number): Date {
	const r = new Date(d);
	r.setUTCFullYear(r.getUTCFullYear() + n);
	return r;
}

/** ISO date string "YYYY-MM-DD" → end-of-day UTC Date (inclusive ceiling) */
function isoToDate(s: string): Date {
	return new Date(s + 'T23:59:59.999Z');
}

// ─── Core expander ────────────────────────────────────────────────────────────

/**
 * Generate all occurrence start times for a recurring event within the window.
 *
 * Algorithm:
 *   1. Start from the event anchor (starts_at).
 *   2. Advance by the recurrence rule's frequency × interval.
 *   3. Collect occurrences whose start falls inside [rangeStart, rangeEnd).
 *   4. Stop when we exceed the series ceiling or the count limit.
 *
 * For weekly + byday rules we enumerate days within each week-interval.
 */
export function expandOccurrences(
	event: DbEvent,
	rangeStart: Date,
	rangeEnd: Date,
): Date[] {
	if (!event.is_recurring || !event.recurrence_rule) return [];

	// postgres.js may return JSONB as a string in some query paths; parse defensively.
	const rawRule = event.recurrence_rule;
	const rule: RecurrenceRule = typeof rawRule === 'string' ? JSON.parse(rawRule) : rawRule as RecurrenceRule;
	const interval = rule.interval ?? 1;
	const duration = event.ends_at.getTime() - event.starts_at.getTime();

	// Series hard ceiling: either rule.until, series_ends_at, or a safety cap
	let seriesEnd: Date | null = null;
	if (rule.until) seriesEnd = isoToDate(rule.until);
	else if (event.series_ends_at) seriesEnd = new Date(event.series_ends_at);

	// Safety: never expand more than 2 years into the future without a ceiling
	const safetyCap = addYears(rangeEnd, 0); // rangeEnd is already our upper bound

	const effectiveEnd = seriesEnd
		? new Date(Math.min(seriesEnd.getTime(), safetyCap.getTime()))
		: safetyCap;

	const occurrences: Date[] = [];
	let count = 0;
	const maxCount = rule.count ?? Infinity;

	const anchor = new Date(event.starts_at);

	if (rule.frequency === 'weekly' && rule.byday && rule.byday.length > 0) {
		// Weekly with specific days: walk week by week (interval), within each
		// qualifying week emit each byday that falls in the window.
		const anchorDow = anchor.getUTCDay(); // 0=Sun

		// Find the Monday of the anchor week (ISO week start)
		const anchorMonday = new Date(anchor);
		const daysFromMonday = (anchorDow + 6) % 7; // Mon=0
		anchorMonday.setUTCDate(anchorMonday.getUTCDate() - daysFromMonday);
		anchorMonday.setUTCHours(anchor.getUTCHours(), anchor.getUTCMinutes(), 0, 0);

		let weekStart = new Date(anchorMonday);

		while (weekStart <= effectiveEnd && count < maxCount) {
			for (const day of rule.byday) {
				const dow = WEEKDAY_INDEX[day]; // 0=Sun
				// Monday of week is weekStart; Sun(0) = +6 days from Monday(1)
				const offset = dow === 0 ? 6 : dow - 1;
				const candidate = addDays(weekStart, offset);
				// Keep only the time from the anchor
				candidate.setUTCHours(anchor.getUTCHours(), anchor.getUTCMinutes(), 0, 0);

				// Must be on or after the anchor (don't emit before series start)
				if (candidate < anchor) continue;
				if (candidate > effectiveEnd) continue;
				if (count >= maxCount) break;

				if (candidate >= rangeStart && candidate < rangeEnd) {
					occurrences.push(candidate);
				}
				count++;
			}
			// Advance by interval weeks
			weekStart = addDays(weekStart, 7 * interval);
		}

		// Sort because byday enumeration order may not be chronological
		occurrences.sort((a, b) => a.getTime() - b.getTime());
		return occurrences;
	}

	// Generic single-advance loop for daily / weekly (no byday) / monthly / yearly
	let current = new Date(anchor);

	while (current <= effectiveEnd && count < maxCount) {
		if (current >= rangeStart && current < rangeEnd) {
			occurrences.push(new Date(current));
		}
		count++;

		switch (rule.frequency) {
			case 'daily':
				current = addDays(current, interval);
				break;
			case 'weekly':
				current = addDays(current, 7 * interval);
				break;
			case 'monthly':
				current = addMonths(current, interval);
				break;
			case 'yearly':
				current = addYears(current, interval);
				break;
			default:
				// Unknown frequency — bail out to avoid infinite loop.
				return occurrences;
		}

		// Break early once we're past the range (remaining won't be in range)
		if (current >= rangeEnd && current > effectiveEnd) break;
	}

	return occurrences;
}

// ─── Apply exceptions ─────────────────────────────────────────────────────────

/**
 * Build the final CalendarEvent list for a single recurring series within
 * the requested window:
 *  1. Expand raw occurrence times.
 *  2. Look up each occurrence's exception (if any).
 *  3. Skip cancelled ones.
 *  4. Merge override fields.
 */
export function applyExceptions(
	event: DbEvent,
	exceptions: DbEventException[],
	rangeStart: Date,
	rangeEnd: Date,
	calendarColor: string,
	calendarName: string,
): CalendarEvent[] {
	const duration = event.ends_at.getTime() - event.starts_at.getTime();
	const rawOccurrences = expandOccurrences(event, rangeStart, rangeEnd);

	// Index exceptions by their occurrence key (ms timestamp string)
	const exMap = new Map<number, DbEventException>();
	for (const ex of exceptions) {
		exMap.set(ex.occurrence_starts_at.getTime(), ex);
	}

	const results: CalendarEvent[] = [];

	for (const occStart of rawOccurrences) {
		const ex = exMap.get(occStart.getTime());

		if (ex?.is_cancelled) continue;

		const actualStart = ex?.starts_at ?? occStart;
		const actualEnd = ex?.ends_at ?? new Date(occStart.getTime() + duration);

		results.push({
			id: event.id,
			exception_id: ex?.id,
			calendar_id: event.calendar_id,
			calendar_color: calendarColor,
			calendar_name: calendarName,
			title: ex?.title ?? event.title,
			description: ex?.description ?? event.description,
			location: ex?.location ?? event.location,
			starts_at: actualStart.toISOString(),
			ends_at: actualEnd.toISOString(),
			all_day: event.all_day,
			is_recurring: true,
			occurrence_starts_at: occStart.toISOString(),
			recurrence_rule: event.recurrence_rule,
		});
	}

	return results;
}
