-- Phase 2: Add event_emitted guard column to trades
ALTER TABLE trades ADD COLUMN IF NOT EXISTS event_emitted BOOLEAN NOT NULL DEFAULT FALSE;
