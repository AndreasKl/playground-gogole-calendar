-- Calendar application schema
-- Designed for recurring events with per-occurrence overrides

-- Users stub: ready for auth, not yet wired up
CREATE TABLE IF NOT EXISTS users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Each user can have multiple named calendars (e.g. "Work", "Personal")
CREATE TABLE IF NOT EXISTS calendars (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT '#1a73e8',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Events: covers both single events and recurring series.
--
-- For a recurring series, this row is the authoritative definition.
-- starts_at / ends_at describe the FIRST occurrence (anchor).
--
-- recurrence_rule (JSONB) stores the repeat pattern:
-- {
--   "frequency": "daily" | "weekly" | "monthly" | "yearly",
--   "interval": 1,              -- every N periods (default 1)
--   "byday": ["MO","WE","FR"],  -- days of week (weekly only)
--   "bymonthday": 15,           -- day of month (monthly only)
--   "until": "2026-12-31",      -- ISO date, series end (exclusive of until)
--   "count": 10                 -- OR max number of occurrences
-- }
-- Only one of "until" or "count" should be set.
CREATE TABLE IF NOT EXISTS events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  calendar_id       UUID NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,

  title             TEXT NOT NULL,
  description       TEXT,
  location          TEXT,

  -- Anchor time: first occurrence (or the sole occurrence for non-recurring)
  starts_at         TIMESTAMPTZ NOT NULL,
  ends_at           TIMESTAMPTZ NOT NULL,
  all_day           BOOLEAN NOT NULL DEFAULT FALSE,

  -- Recurrence
  is_recurring      BOOLEAN NOT NULL DEFAULT FALSE,
  recurrence_rule   JSONB,
  -- Computed ceiling to avoid generating occurrences forever;
  -- set to "until" from the rule or derived from "count".
  -- NULL means the series runs indefinitely (guard against abuse in app layer).
  series_ends_at    DATE,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_recurring_has_rule CHECK (
    (is_recurring = FALSE AND recurrence_rule IS NULL)
    OR
    (is_recurring = TRUE AND recurrence_rule IS NOT NULL)
  ),
  CONSTRAINT chk_ends_after_starts CHECK (ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS idx_events_calendar_id ON events(calendar_id);
CREATE INDEX IF NOT EXISTS idx_events_starts_at   ON events(starts_at);
-- GIN index on recurrence_rule for potential future filtering
CREATE INDEX IF NOT EXISTS idx_events_recurrence  ON events USING GIN(recurrence_rule)
  WHERE is_recurring = TRUE;

-- Event exceptions: override or cancel a single occurrence of a recurring series.
--
-- occurrence_starts_at identifies WHICH occurrence is being changed — it is the
-- originally scheduled start time of that occurrence (before any edit).
-- This is the stable key: even if the user moves the event to another time, the
-- key remains the original slot so we can always find the exception.
--
-- If is_cancelled = TRUE the occurrence is deleted from the series.
-- Otherwise, any non-NULL column overrides the corresponding series default.
CREATE TABLE IF NOT EXISTS event_exceptions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id              UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,

  -- The original scheduled start of this occurrence (series key)
  occurrence_starts_at  TIMESTAMPTZ NOT NULL,

  -- Soft-delete: occurrence is hidden
  is_cancelled          BOOLEAN NOT NULL DEFAULT FALSE,

  -- Per-occurrence overrides (NULL = inherit from series)
  title                 TEXT,
  description           TEXT,
  location              TEXT,
  starts_at             TIMESTAMPTZ,  -- actual start (may differ from occurrence_starts_at)
  ends_at               TIMESTAMPTZ,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(event_id, occurrence_starts_at)
);

CREATE INDEX IF NOT EXISTS idx_exceptions_event_id ON event_exceptions(event_id);

-- Seed: a demo user and calendar so the app works without auth
INSERT INTO users (id, email, name)
VALUES ('00000000-0000-0000-0000-000000000001', 'demo@example.com', 'Demo User')
ON CONFLICT DO NOTHING;

INSERT INTO calendars (id, user_id, name, color)
VALUES
  ('00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000001', 'Personal', '#1a73e8'),
  ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000001', 'Work',     '#0f9d58')
ON CONFLICT DO NOTHING;
