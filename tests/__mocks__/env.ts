// Stub for $env/dynamic/private — keeps unit tests from crashing on the import.
// Integration tests override DATABASE_URL via process.env before importing db.ts.
export const env = {
	DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://calendar:calendar@localhost:5432/calendar',
};
