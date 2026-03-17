# Calendar

A Google/Outlook-style calendar application with a 7-day week view, recurring events, and per-occurrence overrides. Built with SvelteKit, PostgreSQL, and Tailwind CSS v4.

---

## Abstract

This project explores the data modelling challenges behind a production-grade calendar application — specifically how to handle recurring event series in a relational database without duplicating rows, while still allowing individual occurrences to be edited or cancelled independently.

The core insight is the **exception table pattern**: a recurring event is stored once as a series definition. Individual occurrences are computed on the fly from a recurrence rule (JSONB). When a single occurrence needs to deviate from the series — different title, different time, or cancelled — an exception row is inserted, keyed by the occurrence's *original* scheduled start time. This key is stable even if the occurrence is rescheduled, because it identifies the slot rather than the actual time.

This mirrors the approach used by iCalendar (RFC 5545), Google Calendar, and Exchange, and is the standard solution to the "edit one / edit all / edit this and future" problem.

---

## Tech Stack

| Layer      | Technology                  |
|------------|-----------------------------|
| Frontend   | SvelteKit 2 + Svelte 5 runes |
| Styling    | Tailwind CSS v4             |
| Backend    | SvelteKit server routes     |
| Database   | PostgreSQL 17               |
| DB driver  | postgres.js (no ORM)        |
| Container  | Docker Compose              |
| Language   | TypeScript throughout       |

---

## Architecture

```
src/
├── hooks.server.ts          # Runs DB migrations on server start
├── routes/
│   ├── +page.svelte         # Entry point → renders WeekView
│   └── api/
│       ├── calendars/
│       │   └── +server.ts   # GET  /api/calendars
│       └── events/
│           ├── +server.ts   # GET  /api/events?start=&end=
│           │                # POST /api/events
│           └── [id]/
│               └── +server.ts  # GET / PUT / DELETE /api/events/:id
└── lib/
    ├── types.ts             # Shared TypeScript types
    ├── components/
    │   ├── WeekView.svelte  # 7-day grid, event positioning, navigation
    │   └── EventModal.svelte # Create / edit form with recurrence UI
    └── server/
        ├── db.ts            # postgres.js connection pool + migration runner
        └── recurrence.ts    # Occurrence expansion engine + exception merging
```

### Database schema

```
users              ← stub; multi-user ready, auth not yet wired
  └── calendars    ← named + coloured calendar per user
        └── events ← single events OR recurring series definition
              └── event_exceptions ← per-occurrence overrides / cancellations
```

#### `events`

Stores both one-off events and the **anchor definition** of a recurring series.

| Column           | Type        | Notes |
|------------------|-------------|-------|
| `id`             | UUID PK     | |
| `calendar_id`    | UUID FK     | |
| `title`          | TEXT        | |
| `description`    | TEXT        | nullable |
| `location`       | TEXT        | nullable |
| `starts_at`      | TIMESTAMPTZ | First occurrence (anchor) |
| `ends_at`        | TIMESTAMPTZ | End of first occurrence |
| `all_day`        | BOOLEAN     | |
| `is_recurring`   | BOOLEAN     | |
| `recurrence_rule`| JSONB       | null for single events |
| `series_ends_at` | DATE        | Ceiling for expansion queries |

#### `recurrence_rule` shape

```jsonc
{
  "frequency": "daily" | "weekly" | "monthly" | "yearly",
  "interval":  1,               // every N periods
  "byday":     ["MO", "WE"],    // days of week (weekly only)
  "bymonthday": 15,             // day of month (monthly only)
  "until":     "2026-12-31",    // inclusive end date   ─┐ one of
  "count":     10               // max occurrences      ─┘ these
}
```

#### `event_exceptions`

Each row overrides or cancels one occurrence of a series.

| Column                 | Type        | Notes |
|------------------------|-------------|-------|
| `event_id`             | UUID FK     | References `events.id` |
| `occurrence_starts_at` | TIMESTAMPTZ | **Stable key** — the original scheduled slot |
| `is_cancelled`         | BOOLEAN     | TRUE = this occurrence is hidden |
| `title`                | TEXT        | nullable = inherit from series |
| `description`          | TEXT        | nullable = inherit |
| `location`             | TEXT        | nullable = inherit |
| `starts_at`            | TIMESTAMPTZ | nullable = inherit (actual rescheduled time) |
| `ends_at`              | TIMESTAMPTZ | nullable = inherit |

The `(event_id, occurrence_starts_at)` pair has a UNIQUE constraint.

### Recurrence expansion

`src/lib/server/recurrence.ts` implements a server-side expansion engine:

1. For a given `[rangeStart, rangeEnd)` window, walk the series from its anchor.
2. Advance by `frequency × interval` on each step.
3. For `weekly + byday`, enumerate qualifying days within each week-interval.
4. Stop at `series_ends_at`, `rule.until`, or `rule.count`.
5. Look up any exception rows for this series in the window.
6. Skip cancelled occurrences; merge override fields onto the rest.

This approach never stores expanded occurrences — the database only holds the series definition and the exceptions. Expansion is purely in-memory and scoped to the requested date window.

### Edit scope semantics

When editing or deleting a recurring event the client sends a `scope`:

| Scope              | What happens |
|--------------------|--------------|
| `"this"`           | Upsert an `event_exceptions` row for this occurrence |
| `"this_and_future"`| Truncate the original series (set `series_ends_at`/`rule.until`) and create a new series from this point with the updated fields |
| `"all"`            | Update the base `events` row; all occurrences without exceptions follow the new definition |

---

## Getting Started

### Prerequisites

- Node.js 25+ (project uses 25.4.0 via asdf — see `.tool-versions`)
- Docker and Docker Compose

### Install

```bash
git clone <repo>
cd calendar
npm install
cp .env.example .env   # already done if you cloned fresh
```

### Run

```bash
# 1. Start PostgreSQL
docker compose up -d

# 2. Start the dev server (migrations run automatically on first request)
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

**Click any time slot** to create an event. The event form includes:
- Title, start/end times, calendar, location, description
- Repeat toggle with frequency, interval, days-of-week picker, and end condition
- For existing recurring events: scope selector (this / this and future / all)

### Environment variables

| Variable       | Default                                            |
|----------------|----------------------------------------------------|
| `DATABASE_URL` | `postgres://calendar:calendar@localhost:5432/calendar` |

### Production build

```bash
npm run build
node build          # requires DATABASE_URL to be set
```

Migrations still run automatically on startup via `src/hooks.server.ts`.

---

## Testing

The project has **55 automated tests** (32 unit + 23 integration) powered by [Vitest](https://vitest.dev/).

```
tests/
├── __mocks__/
│   └── env.ts               # Stubs $env/dynamic/private for unit tests
├── unit/
│   └── recurrence.test.ts   # Pure function tests for expandOccurrences()
│                             # and applyExceptions() — no DB needed
└── integration/
    └── api.test.ts           # HTTP tests against a running dev server + DB
                              # covering all endpoints and all three edit scopes
```

### Run the tests

**Unit tests only** (no server or database required):

```bash
npm test
```

**Integration tests** require PostgreSQL and the dev server:

```bash
# Terminal 1 — start the database
docker compose up -d

# Terminal 2 — start the dev server
npm run dev

# Terminal 3 — run the full suite
npm test
```

The integration tests create and clean up their own data via `afterEach`, so they can be run repeatedly against the shared development database without side effects.

### Watch mode / UI

```bash
npm run test:watch   # re-runs on file change
npm run test:ui      # browser-based Vitest UI
```

### Manual smoke tests

**Single event**
1. Click a time slot → create an event → confirm it appears on the grid.
2. Click the event → edit the title → save with scope "All events" → confirm title updates.
3. Click the event → delete → confirm it disappears.

**Recurring event**
1. Create a weekly event repeating every Wednesday and Friday for 4 weeks.
2. Verify occurrences appear on the correct columns for the current and next weeks (navigate with `›`).
3. Click one Wednesday occurrence → change the title → save with **"This event only"** → verify only that occurrence has the new title, others unchanged.
4. Click one Friday occurrence → save with **"This and following events"** (new time) → verify earlier Fridays keep the original time, later ones use the new time.
5. Click one occurrence → Delete → scope "This event only" → verify it disappears but surrounding occurrences remain.
6. Delete with scope "This and following" → verify the series is truncated.
7. Delete with scope "All events" → verify all occurrences disappear.

**Week navigation**
1. Click `‹` / `›` and verify the header range and day columns update correctly.
2. Click **Today** and verify it returns to the current week with today highlighted.

---

## API Reference

### `GET /api/calendars`

Returns all calendars.

```jsonc
[{ "id": "...", "name": "Work", "color": "#0f9d58", ... }]
```

### `GET /api/events?start=<ISO>&end=<ISO>`

Returns all events (expanded recurring + single) that overlap the window. Recurring events are returned as individual occurrence objects with `occurrence_starts_at` set.

### `POST /api/events`

Create an event or recurring series.

```jsonc
{
  "calendar_id": "...",
  "title": "Team standup",
  "starts_at": "2026-02-23T09:00:00Z",
  "ends_at":   "2026-02-23T09:30:00Z",
  "recurrence_rule": {
    "frequency": "weekly",
    "interval": 1,
    "byday": ["MO", "WE", "FR"]
  }
}
```

### `PUT /api/events/:id`

Update an event. Requires `scope` field.

```jsonc
{
  "scope": "this",
  "occurrence_starts_at": "2026-02-25T09:00:00Z",
  "title": "Updated title"
}
```

### `DELETE /api/events/:id`

Delete an event or occurrence. Requires `scope` field (and `occurrence_starts_at` for recurring).

```jsonc
{ "scope": "this_and_future", "occurrence_starts_at": "2026-02-25T09:00:00Z" }
```

---

## Contributing

### Code style

- TypeScript strict mode throughout — no `any` unless unavoidable.
- SvelteKit server routes for all data access; no direct DB calls from `.svelte` files.
- Tailwind utility classes for styling; minimal `<style>` blocks only for CSS-variable arithmetic (e.g. the time grid height calculation).
- Raw SQL via postgres.js — no ORM. Keep queries legible; use tagged template literals.

### Branching

```
main          production-ready
feat/<name>   new features
fix/<name>    bug fixes
```

Open a pull request against `main`. Squash commits before merging.

### Adding a migration

1. Create `migrations/NNN_description.sql` (next sequential number).
2. The migration runner applies files in alphabetical order and records each in `_migrations`. Re-running is idempotent.
3. Migrations run automatically in dev (via `hooks.server.ts`) and on production startup.

### Extending the recurrence engine

The expansion logic lives entirely in `src/lib/server/recurrence.ts`. It is a set of pure functions that take plain objects and return arrays — easy to unit-test without a database. When adding a new frequency or rule type:

1. Extend the `RecurrenceRule` type in `src/lib/types.ts`.
2. Add a branch in `expandOccurrences()`.
3. Add unit tests in `tests/unit/recurrence.test.ts`.
4. Update the modal UI in `EventModal.svelte` to expose the new option.

### What's intentionally missing (and how to add it)

| Feature        | Where to add |
|----------------|--------------|
| Auth / login   | `src/hooks.server.ts` (session check), `users` table already exists |
| Month view     | New route `/month` + a new grid component; reuse the same API |
| Drag-to-reschedule | `WeekView.svelte` — use pointer events to compute new `starts_at` |
| Notifications  | Separate worker process querying upcoming events |
| iCal export    | New route `/api/events.ics` using the expansion engine |

---

## License

MIT
