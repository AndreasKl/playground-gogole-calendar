import type { LocaleConfig } from '$lib/config';

/**
 * Hour-gutter label (left column of the time grid).
 *   24h: "0", "1", …, "23"
 *   12h: "12 AM", "1 AM", …, "12 PM", "1 PM", …
 */
export function formatHour(h: number, config: LocaleConfig): string {
	if (!config.hour12) return String(h);
	if (h === 0)  return '12 AM';
	if (h < 12)   return `${h} AM`;
	if (h === 12) return '12 PM';
	return `${h - 12} PM`;
}

/**
 * Compact time range shown on event blocks and tooltips.
 *   24h: "10:00 – 11:30"
 *   12h: "10am – 11:30am"  (minutes omitted when :00)
 */
export function formatEventTime(startsAt: string, endsAt: string, config: LocaleConfig): string {
	const fmt = (d: Date): string => {
		const h = d.getHours(), m = d.getMinutes();
		if (!config.hour12) {
			return `${h}:${String(m).padStart(2, '0')}`;
		}
		const ampm = h < 12 ? 'am' : 'pm';
		return m === 0
			? `${h % 12 || 12}${ampm}`
			: `${h % 12 || 12}:${String(m).padStart(2, '0')}${ampm}`;
	};
	return `${fmt(new Date(startsAt))} – ${fmt(new Date(endsAt))}`;
}

/**
 * Week-range header label.
 *   de-DE: "23. Feb. – 1. März 2026"
 *   en-US: "Feb 23 – Mar 1, 2026"
 */
export function formatWeekRange(weekDays: Date[], config: LocaleConfig): string {
	const s = weekDays[0], e = weekDays[6];
	const dm  = new Intl.DateTimeFormat(config.locale, { day: 'numeric', month: 'short' });
	const dmy = new Intl.DateTimeFormat(config.locale, { day: 'numeric', month: 'short', year: 'numeric' });
	return `${dm.format(s)} – ${dmy.format(e)}`;
}

/**
 * Ordered Mon–Sun day-name abbreviations for the column headers,
 * derived from the locale.
 *   de-DE: ["Mo.", "Di.", "Mi.", "Do.", "Fr.", "Sa.", "So."]
 *   en-US: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
 */
export function getWeekDayNames(config: LocaleConfig): string[] {
	const fmt = new Intl.DateTimeFormat(config.locale, { weekday: 'short' });
	// 2025-01-06 is a Monday — use as anchor for a stable Mon-Sun sequence
	const anchor = new Date(2025, 0, 6);
	return Array.from({ length: 7 }, (_, i) => {
		const d = new Date(anchor);
		d.setDate(anchor.getDate() + i);
		return fmt.format(d);
	});
}
