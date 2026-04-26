-- Persistent storage for post-session debriefs
CREATE TABLE IF NOT EXISTS session_debriefs (
  debrief_id UUID PRIMARY KEY,
  session_id UUID NOT NULL,
  user_id UUID NOT NULL,
  overall_mood TEXT NOT NULL CHECK (overall_mood IN ('calm', 'anxious', 'greedy', 'fearful', 'neutral')),
  key_mistake TEXT,
  key_lesson TEXT,
  plan_adherence_rating INTEGER NOT NULL CHECK (plan_adherence_rating BETWEEN 1 AND 5),
  will_review_tomorrow BOOLEAN NOT NULL DEFAULT FALSE,
  saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_session_debriefs_session_id ON session_debriefs(session_id);
CREATE INDEX IF NOT EXISTS idx_session_debriefs_user_id ON session_debriefs(user_id);
