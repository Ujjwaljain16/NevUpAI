-- Add unique constraint for idempotent overtrading detection
CREATE UNIQUE INDEX IF NOT EXISTS idx_overtrading_user_session_window
  ON overtrading_events (user_id, session_id, detected_at);
