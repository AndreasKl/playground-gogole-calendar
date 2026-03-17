# Architecture

This document explains how the calendar data model works, with particular focus on recurring events and the exception pattern used to support per-occurrence edits.

---

## Table of contents

1. [Database schema](#database-schema)
2. [The recurring event problem](#the-recurring-event-problem)
3. [The exception table pattern](#the-exception-table-pattern)
4. [The occurrence key](#the-occurrence-key)
5. [Edit scopes in detail](#edit-scopes-in-detail)
6. [Recurrence expansion](#recurrence-expansion)
7. [Query flow for GET /api/events](#query-flow-for-get-apievents)
8. [Design trade-offs](#design-trade-offs)

---

## Database schema

Four tables, one foreign-key chain:

```
users
 └─ calendars  (user_id → users.id)
     └─ events  (calendar_id → calendars.id)
         └─ event_exceptions  (event_id → events.id)
```

### `users`

A stub. The table exists and the seeded demo user is used for all calendars, but authentication is not yet wired up. Adding auth means populating this table and passing a `user_id` through the session.

### `calendars`

Named, coloured groups of events per user. The seed migration creates two: *Personal* (`#1a73e8`) and *Work* (`#0f9d58`).

### `events`

The most important table. It serves a dual purpose:

| Use case | What the row represents |
|----------|-------------------------|
| Single event | The event itself — `is_recurring = false`, `recurrence_rule = null` |
| Recurring series | The **anchor definition** — `is_recurring = true`, `recurrence_rule` holds the JSONB pattern |

For a recurring series the row's `starts_at`/`ends_at` describe the **first occurrence only** (the anchor). All subsequent occurrences are derived by the expansion engine at query time — they are never stored as rows.

```sql
CREATE TABLE events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  calendar_id       UUID NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,

  title             TEXT NOT NULL,
  description       TEXT,
  location          TEXT,

  starts_at         TIMESTAMPTZ NOT NULL,   -- anchor / first occurrence
  ends_at           TIMESTAMPTZ NOT NULL,
  all_day           BOOLEAN NOT NULL DEFAULT FALSE,

  is_recurring      BOOLEAN NOT NULL DEFAULT FALSE,
  recurrence_rule   JSONB,                  -- null for single events
  series_ends_at    DATE,                   -- computed ceiling for expansion

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_recurring_has_rule CHECK (
    (is_recurring = FALSE AND recurrence_rule IS NULL)
    OR
    (is_recurring = TRUE  AND recurrence_rule IS NOT NULL)
  ),
  CONSTRAINT chk_ends_after_starts CHECK (ends_at > starts_at)
);
```

**`recurrence_rule` (JSONB)**

Follows iCalendar RRULE conventions:

```jsonc
{
  "frequency":   "daily" | "weekly" | "monthly" | "yearly",
  "interval":    1,            // every N periods; default 1
  "byday":       ["MO","WE"],  // days of week (weekly only)
  "bymonthday":  15,           // day of month (monthly only)
  "until":       "2026-12-31", // inclusive end date ─┐ at most
  "count":       10            // max occurrences     ─┘ one of these
}
```

**`series_ends_at` (DATE)**

A denormalised ceiling stored alongside the rule. It is set when the series is created and updated when the series is truncated. Its purpose is to make the recurring-series query cheap:

```sql
WHERE e.is_recurring = TRUE
  AND e.starts_at < :range_end
  AND (e.series_ends_at IS NULL OR e.series_ends_at > :range_start)
```

Without it, every recurring series ever created would have to be fetched and expanded to determine whether it overlaps the requested window.

### `event_exceptions`

Stores per-occurrence overrides and cancellations for recurring series.

```sql
CREATE TABLE event_exceptions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id              UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,

  occurrence_starts_at  TIMESTAMPTZ NOT NULL,  -- stable series key (see below)
  is_cancelled          BOOLEAN NOT NULL DEFAULT FALSE,

  -- Per-occurrence overrides; NULL means "inherit from the series"
  title                 TEXT,
  description           TEXT,
  location              TEXT,
  starts_at             TIMESTAMPTZ,           -- actual (possibly rescheduled) start
  ends_at               TIMESTAMPTZ,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(event_id, occurrence_starts_at)
);
```

---

## The recurring event problem

A naive approach to recurring events stores every occurrence as a separate row:

```
events
  id=1  title="Standup"  starts_at=Mon 09:00  (no recurrence)
  id=2  title="Standup"  starts_at=Tue 09:00
  id=3  title="Standup"  starts_at=Wed 09:00
  ...
```

This causes two problems:

1. **Storage blows up.** A daily standup for a year is 260 rows. An indefinite series is infinite rows.
2. **Editing is painful.** Renaming the series means updating every row. Cancelling one occurrence means deleting one row — but you have to know in advance which rows exist.

A slightly better approach stores one row per series and expands occurrences into a separate `occurrences` table only as far as needed. But that table still needs constant maintenance as the series boundary advances.

The production solution — used by Google Calendar, Outlook/Exchange, and the iCalendar RFC 5545 standard — is the **exception table pattern**.

---

## The exception table pattern

The core idea:

> Store the series **once**. Compute occurrences **on the fly**. Store only the **deviations** from the series.

```
events row (the series definition)
  id        = abc-123
  title     = "Weekly standup"
  starts_at = 2026-02-23 09:00  ← anchor: first Mon
  recurrence_rule = { frequency: "weekly", byday: ["MO","WE","FR"] }

                    Computed on every read
                    ┌──────────────────────────────┐
                    │ Mon 09:00  (no exception)     │ → title = "Weekly standup"
                    │ Wed 09:00  ← exception exists │ → title = "Special Wednesday"
                    │ Fri 09:00  (no exception)     │ → title = "Weekly standup"
                    └──────────────────────────────┘

event_exceptions row
  event_id             = abc-123
  occurrence_starts_at = 2026-02-25 09:00  ← the Wednesday slot
  title                = "Special Wednesday"
  starts_at            = null              ← time unchanged
```

Benefits:

- The `events` table has **one row per series**, regardless of how many occurrences there are.
- Editing all occurrences is an `UPDATE events SET title = ...` — one row.
- Cancelling one occurrence is an `INSERT INTO event_exceptions (is_cancelled = true)` — one row.
- Editing one occurrence is an `INSERT INTO event_exceptions (title = ...)` — one row.
- The cost of reading a window is bounded: one `SELECT` for the series + one `SELECT` for exceptions in the window, then in-memory expansion.

---

## The occurrence key

The most subtle design decision is the choice of key for `event_exceptions`.

The key is `(event_id, occurrence_starts_at)` where `occurrence_starts_at` is the **originally scheduled start time** of that occurrence — the slot the occurrence would have occupied according to the pure series rule, before any edits.

### Why not use a sequence number?

You could number occurrences: exception for occurrence #3 of series abc-123. The problem is that sequence numbers become unstable when the series is edited:

- Series: daily at 09:00, starting Mon Feb 23
- Exception on occurrence #3 = Wednesday Feb 25 at 09:00
- User edits the series: change start time to 10:00 for "this and all future" from Tuesday
- Now occurrence #3 of the truncated original series is Tuesday Feb 24, not Wednesday

The exception was supposed to be on Wednesday but now it's on Tuesday. The key was wrong.

### Why the original scheduled start is stable

The original scheduled start (`occurrence_starts_at`) identifies **which slot** in the series the exception belongs to, not **what time the occurrence actually runs**. When the occurrence is rescheduled to a new time, the actual time goes into `event_exceptions.starts_at`, but the key `occurrence_starts_at` stays unchanged.

```
Before edit:
  occurrence_starts_at = Wed 09:00   ← key, never changes
  starts_at            = null        ← actual time = key (inherited)
  title                = null        ← title = series title (inherited)

After "reschedule this one to 11:00":
  occurrence_starts_at = Wed 09:00   ← key, still unchanged
  starts_at            = Wed 11:00   ← actual time = 11:00
  title                = null        ← title still inherited
```

And if the user later edits the title of this rescheduled occurrence:

```
  occurrence_starts_at = Wed 09:00   ← key, still unchanged
  starts_at            = Wed 11:00   ← rescheduled time preserved
  title                = "Moved and renamed"
```

The key survives any number of edits to the occurrence itself.

### Stability across "this and future" splits

The "edit this and future" operation truncates the original series and creates a brand new series starting from the split point. Exceptions that belonged to the old series on or after the split point are deleted — they will be re-created if the user edits those new-series occurrences. Exceptions that belonged to the old series before the split point remain untouched, still keyed to their original slots.

```
Original series (abc-123): daily 09:00, starts Mon Feb 23
Exceptions: Wed Feb 25 → is_cancelled = true

User: "edit this and future" from Thu Feb 26, rename to "New standup"

After the operation:
  events abc-123: series truncated, series_ends_at = Feb 25
  events def-456: NEW series, starts Feb 26, title = "New standup"

  event_exceptions for abc-123:
    Wed Feb 25 → is_cancelled = true   ← untouched, still correct

  event_exceptions for def-456:
    (empty — fresh series)
```

---

## Edit scopes in detail

Every PUT and DELETE request carries a `scope` field.

### `scope = "all"`

Updates or deletes the base `events` row. All occurrences without exceptions will reflect the change immediately on the next expansion. Existing exception rows are **not** touched — they continue to override or cancel their specific slot.

```
PUT /api/events/abc-123
{ "scope": "all", "title": "Renamed standup" }

→ UPDATE events SET title = 'Renamed standup' WHERE id = 'abc-123'
```

### `scope = "this"`

Upserts a single row in `event_exceptions`. Only that occurrence is affected.

```
PUT /api/events/abc-123
{ "scope": "this", "occurrence_starts_at": "2026-02-25T09:00:00Z", "title": "Special" }

→ INSERT INTO event_exceptions (event_id, occurrence_starts_at, title)
  VALUES ('abc-123', '2026-02-25T09:00:00Z', 'Special')
  ON CONFLICT (event_id, occurrence_starts_at) DO UPDATE SET title = 'Special'
```

Cancellation uses the same mechanism:

```
DELETE /api/events/abc-123
{ "scope": "this", "occurrence_starts_at": "2026-02-25T09:00:00Z" }

→ INSERT INTO event_exceptions (event_id, occurrence_starts_at, is_cancelled)
  VALUES ('abc-123', '2026-02-25T09:00:00Z', TRUE)
  ON CONFLICT ... DO UPDATE SET is_cancelled = TRUE
```

### `scope = "this_and_future"`

This is the most complex operation. It performs a series split:

1. **Truncate the original series** by setting `series_ends_at` to the day before the split point and updating `rule.until` to match.
2. **Delete exceptions** from the original series that are on or after the split point (they no longer belong to any series).
3. **Create a new series** row starting at the split point with the updated fields.

```
PUT /api/events/abc-123
{
  "scope": "this_and_future",
  "occurrence_starts_at": "2026-02-26T09:00:00Z",
  "title": "Renamed from Thursday"
}

Step 1 — truncate abc-123:
  UPDATE events
  SET series_ends_at = '2026-02-25',
      recurrence_rule = { ...rule, until: '2026-02-25' }
  WHERE id = 'abc-123'

Step 2 — remove stale exceptions:
  DELETE FROM event_exceptions
  WHERE event_id = 'abc-123'
    AND occurrence_starts_at >= '2026-02-26T09:00:00Z'

Step 3 — create new series:
  INSERT INTO events (title, starts_at, recurrence_rule, ...)
  VALUES ('Renamed from Thursday', '2026-02-26T09:00:00Z', ..., ...)
  RETURNING *   → new id = def-456
```

The client receives the new series' id (`def-456`) and adds it to its cleanup list. The original series (`abc-123`) still exists, now ending on Feb 25.

---

## Recurrence expansion

`src/lib/server/recurrence.ts` is a pure, side-effect-free module. It never touches the database. It takes a series definition and a date window, and returns a list of resolved `CalendarEvent` objects.

### `expandOccurrences(event, rangeStart, rangeEnd)`

Walks the series from the anchor date, advancing by `frequency × interval` on each step:

```
anchor = 2026-02-23T09:00Z, frequency = daily, interval = 1

Step 0: current = Feb 23 09:00  → in range [Feb 23, Mar 2)? yes → emit
Step 1: current = Feb 24 09:00  → yes → emit
...
Step 6: current = Mar 01 09:00  → yes → emit
Step 7: current = Mar 02 09:00  → equal to rangeEnd → rangeEnd is exclusive → stop
```

For `weekly + byday` the algorithm is different: it walks **week by week** (advancing by `interval` weeks at a time), and within each qualifying week it emits one occurrence per day listed in `byday`. This correctly handles biweekly patterns and avoids emitting days before the anchor.

The series ceiling is enforced at each step:
- `rule.until` (inclusive date-based ceiling)
- `rule.count` (max occurrence count across all time, not just the window)
- `series_ends_at` (DB-stored ceiling used as a fallback)

### `applyExceptions(event, exceptions, rangeStart, rangeEnd, ...)`

Takes the raw occurrence list from `expandOccurrences` and the exception rows for this series (pre-fetched from the DB), then:

1. Builds an index of exceptions keyed by `occurrence_starts_at.getTime()`.
2. For each occurrence:
   - If there is an exception with `is_cancelled = true` → skip.
   - If there is an exception with overridden fields → merge them onto the occurrence.
   - Otherwise → use the series defaults.
3. Returns a `CalendarEvent[]` where each item has `occurrence_starts_at` set (the stable key) and `starts_at`/`ends_at` reflecting any reschedule.

**Null-means-inherit semantics**: every nullable field in `event_exceptions` (`title`, `description`, `location`, `starts_at`, `ends_at`) uses `null` to mean "inherit from the series". This means an exception row can override just the title while leaving the time unchanged, or just the time while leaving the title unchanged.

---

## Query flow for GET /api/events

```
GET /api/events?start=2026-02-23T00:00:00Z&end=2026-03-02T00:00:00Z
```

1. **Fetch single events** that overlap the window:
   ```sql
   SELECT e.*, c.color, c.name
   FROM events e JOIN calendars c ON c.id = e.calendar_id
   WHERE e.is_recurring = FALSE
     AND e.starts_at < :range_end
     AND e.ends_at   > :range_start
   ```

2. **Fetch recurring series** whose anchor is before the window end and whose ceiling (if any) is after the window start:
   ```sql
   SELECT e.*, c.color, c.name
   FROM events e JOIN calendars c ON c.id = e.calendar_id
   WHERE e.is_recurring = TRUE
     AND e.starts_at < :range_end
     AND (e.series_ends_at IS NULL OR e.series_ends_at > :range_start)
   ```

3. **Fetch exceptions** for all returned series in one round-trip:
   ```sql
   SELECT * FROM event_exceptions
   WHERE event_id::text = ANY(:series_ids)
     AND occurrence_starts_at >= :range_start
     AND occurrence_starts_at <  :range_end
   ```

4. **Expand and merge** (in-memory, no more DB round-trips):
   - For each series: call `applyExceptions(series, exceptionsForThisSeries, ...)`.
   - Collect all single events and all expanded occurrences.
   - Sort by `starts_at`.

Total: **3 SQL queries** regardless of how many series are active or how many occurrences each produces within the window.

---

## Design trade-offs

### What this design is good at

| Scenario | Cost |
|----------|------|
| Rename the whole series | 1 UPDATE |
| Cancel one occurrence | 1 INSERT |
| Edit one occurrence | 1 UPSERT |
| Edit this-and-future | 1 UPDATE + 1 DELETE + 1 INSERT |
| Query a week's worth of events | 3 SQL queries + in-memory expansion |
| Series with 10,000 future occurrences | Same 3 queries; no rows for those occurrences |

### Limitations and known constraints

**Exceptions are scoped to the window.** The exception query fetches only exceptions whose `occurrence_starts_at` falls within the requested window. Exceptions outside the window are not fetched — that's intentional (they're not needed). But it means you cannot tell from a single window query how many exceptions a series has in total.

**count semantics are approximate.** `rule.count` limits the total number of occurrences across all time. The expansion engine counts occurrences as it walks the series, even if they fall outside the requested window. This means for a `count`-bounded series with many past occurrences, the walk may traverse a long history before reaching the window. This is correct behaviour but can be slow for old long-running series — the intended mitigation is `series_ends_at`, which is computed at create time and narrows the walk.

**No timezone-aware recurrence.** All timestamps are stored as `TIMESTAMPTZ` (UTC). The expansion engine works entirely in UTC. This means a "daily at 9 AM" series created in Berlin (UTC+1) will drift by one hour when DST changes. Supporting wall-clock recurrence (9 AM in the user's timezone, always) requires storing the IANA timezone name and converting during expansion — a deliberate omission for now.

**"This and future" creates a new series id.** After a split the client holds two series ids for what the user perceives as one series. The UI tracks the new id and adds it to its cleanup list. There is no parent/child link between the two series rows.
