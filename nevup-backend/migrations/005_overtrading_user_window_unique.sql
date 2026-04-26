-- Ensure user-level overtrading detection is idempotent per sliding-window anchor
CREATE UNIQUE INDEX IF NOT EXISTS idx_overtrading_user_window
  ON overtrading_events (user_id, detected_at);
