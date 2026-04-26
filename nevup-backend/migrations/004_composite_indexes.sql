-- Phase 4: Composite indexes for bounded metric queries
CREATE INDEX IF NOT EXISTS idx_trades_user_status_entry
  ON trades (user_id, status, entry_at);

CREATE INDEX IF NOT EXISTS idx_overtrading_user_session
  ON overtrading_events (user_id, session_id);
