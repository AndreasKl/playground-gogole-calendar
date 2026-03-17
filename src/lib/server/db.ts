import postgres from 'postgres';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { env } from '$env/dynamic/private';

const DATABASE_URL = env.DATABASE_URL ?? 'postgres://calendar:calendar@localhost:5432/calendar';

// Singleton connection pool
let _sql: ReturnType<typeof postgres> | null = null;

export function getDb() {
	if (!_sql) {
		_sql = postgres(DATABASE_URL, {
			max: 10,
			idle_timeout: 20,
			connect_timeout: 10,
		});
	}
	return _sql;
}

// ─── Migration runner ─────────────────────────────────────────────────────────

let _migrated = false;

export async function runMigrations() {
	if (_migrated) return;
	const db = getDb();

	const __dirname = dirname(fileURLToPath(import.meta.url));
	const migrationsDir = join(__dirname, '../../../migrations');

	// Ensure migrations table exists
	await db`
		CREATE TABLE IF NOT EXISTS _migrations (
			filename   TEXT PRIMARY KEY,
			applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)
	`;

	const applied = await db<{ filename: string }[]>`
		SELECT filename FROM _migrations ORDER BY filename
	`;
	const appliedSet = new Set(applied.map((r) => r.filename));

	const files = readdirSync(migrationsDir)
		.filter((f: string) => f.endsWith('.sql'))
		.sort();

	for (const file of files) {
		if (appliedSet.has(file)) continue;
		const sqlText = readFileSync(join(migrationsDir, file), 'utf-8');
		// Run migration + record in one transaction
		await db.begin(async (tx) => {
			await tx.unsafe(sqlText);
			await tx.unsafe(`INSERT INTO _migrations (filename) VALUES ('${file.replace(/'/g, "''")}')`);
		});
		console.log(`[db] applied migration: ${file}`);
	}

	_migrated = true;
}
