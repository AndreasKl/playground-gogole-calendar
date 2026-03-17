// ─── Recurrence Rule ──────────────────────────────────────────────────────────

export type Frequency = 'daily' | 'weekly' | 'monthly' | 'yearly';

/** Day-of-week codes aligned with iCalendar RRULE BYDAY */
export type WeekDay = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU';

export interface RecurrenceRule {
	frequency: Frequency;
	/** Repeat every N periods. Default 1. */
	interval?: number;
	/** Days of week (weekly frequency only). */
	byday?: WeekDay[];
	/** Day of month 1–31 (monthly frequency only). */
	bymonthday?: number;
	/** Inclusive end date (ISO date string, e.g. "2026-12-31"). */
	until?: string;
	/** Max number of occurrences (alternative to until). */
	count?: number;
}

// ─── Database row types ───────────────────────────────────────────────────────

export interface DbEvent {
	id: string;
	calendar_id: string;
	title: string;
	description: string | null;
	location: string | null;
	starts_at: Date;
	ends_at: Date;
	all_day: boolean;
	is_recurring: boolean;
	recurrence_rule: RecurrenceRule | null;
	series_ends_at: Date | null;
	created_at: Date;
	updated_at: Date;
}

export interface DbEventException {
	id: string;
	event_id: string;
	occurrence_starts_at: Date;
	is_cancelled: boolean;
	title: string | null;
	description: string | null;
	location: string | null;
	starts_at: Date | null;
	ends_at: Date | null;
	created_at: Date;
	updated_at: Date;
}

export interface DbCalendar {
	id: string;
	user_id: string;
	name: string;
	color: string;
	created_at: Date;
}

// ─── API / frontend types ─────────────────────────────────────────────────────

/**
 * A fully-resolved event occurrence as returned by the API.
 * For recurring series this is one expanded slot; for single events it is the event itself.
 */
export interface CalendarEvent {
	/** The event/series UUID */
	id: string;
	/** For recurring events: the UUID of the exception row (if one exists) */
	exception_id?: string;
	calendar_id: string;
	calendar_color: string;
	calendar_name: string;
	title: string;
	description: string | null;
	location: string | null;
	starts_at: string; // ISO string
	ends_at: string;   // ISO string
	all_day: boolean;
	is_recurring: boolean;
	/** The original scheduled start of this occurrence (series key for exceptions) */
	occurrence_starts_at?: string;
	recurrence_rule: RecurrenceRule | null;
}

/** Payload for creating an event */
export interface CreateEventPayload {
	calendar_id: string;
	title: string;
	description?: string;
	location?: string;
	starts_at: string;
	ends_at: string;
	all_day?: boolean;
	recurrence_rule?: RecurrenceRule;
}

/**
 * Payload for updating an event or occurrence.
 * scope controls what gets changed for recurring series.
 */
export interface UpdateEventPayload {
	/** Which occurrence key (for recurring events: the original scheduled start) */
	occurrence_starts_at?: string;
	/** What to update */
	title?: string;
	description?: string;
	location?: string;
	starts_at?: string;
	ends_at?: string;
	recurrence_rule?: RecurrenceRule;
	/**
	 * - "this"            → only this occurrence (creates/updates an exception)
	 * - "this_and_future" → this and all following (splits the series)
	 * - "all"             → the whole series (updates the base event)
	 */
	scope: 'this' | 'this_and_future' | 'all';
}

export interface DeleteEventPayload {
	/** For recurring events: the original scheduled start of the occurrence to delete */
	occurrence_starts_at?: string;
	/** Same semantics as UpdateEventPayload.scope */
	scope: 'this' | 'this_and_future' | 'all';
}
