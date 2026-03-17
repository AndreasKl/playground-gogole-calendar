import { defaultLocaleConfig, type LocaleConfig } from '$lib/config';

/**
 * Application-wide locale store.
 *
 * Holds the active LocaleConfig as Svelte 5 reactive state so all
 * components re-render automatically when the locale changes.
 *
 * Later, load user preferences from the API and call locale.set(...)
 * or locale.update(...) after authentication to apply per-user settings.
 *
 * Example (future user preference loading):
 *   const prefs = await fetch('/api/me/preferences').then(r => r.json());
 *   locale.set({ locale: prefs.locale, hour12: prefs.hour12 });
 */
class LocaleStore {
	config = $state<LocaleConfig>(defaultLocaleConfig);

	set(config: LocaleConfig) {
		this.config = config;
	}

	update(partial: Partial<LocaleConfig>) {
		this.config = { ...this.config, ...partial };
	}
}

export const locale = new LocaleStore();
