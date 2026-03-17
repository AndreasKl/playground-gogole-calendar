/**
 * Locale and formatting configuration.
 *
 * The defaults are set for a European (German) audience:
 *   - 24-hour clock
 *   - de-DE locale for day/month names and date ordering
 *
 * This interface is the single source of truth for user preferences
 * that can later be persisted per-user in the database and loaded at
 * session start via the locale store.
 */
export interface LocaleConfig {
	/** BCP 47 locale tag, e.g. 'de-DE' or 'en-US' */
	locale: string;
	/** true = 12-hour AM/PM clock, false = 24-hour clock */
	hour12: boolean;
}

export const defaultLocaleConfig: LocaleConfig = {
	locale: 'de-DE',
	hour12: false,
};
