CREATE TABLE IF NOT EXISTS trades (
  trade_id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  session_id UUID NOT NULL,
  asset TEXT NOT NULL,
  asset_class TEXT NOT NULL CHECK (asset_class IN ('equity', 'crypto', 'forex')),
  direction TEXT NOT NULL CHECK (direction IN ('long', 'short')),
  entry_price NUMERIC(18, 8) NOT NULL,
  exit_price NUMERIC(18, 8),
  quantity NUMERIC(18, 8) NOT NULL,
  entry_at TIMESTAMPTZ NOT NULL,
  exit_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('open', 'closed', 'cancelled')),
  plan_adherence INTEGER CHECK (plan_adherence BETWEEN 1 AND 5),
  emotional_state TEXT CHECK (emotional_state IN ('calm', 'anxious', 'greedy', 'fearful', 'neutral')),
  entry_rationale TEXT,
  outcome TEXT CHECK (outcome IN ('win', 'loss')),
  pnl NUMERIC(18, 8),
  revenge_flag BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trades_user_id ON trades(user_id);
CREATE INDEX IF NOT EXISTS idx_trades_session_id ON trades(session_id);
CREATE INDEX IF NOT EXISTS idx_trades_entry_at ON trades(entry_at);

CREATE TABLE IF NOT EXISTS processed_events (
  event_id TEXT PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS plan_adherence_scores (
  user_id UUID NOT NULL,
  calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  score NUMERIC(8, 4) NOT NULL,
  PRIMARY KEY (user_id, calculated_at)
);

CREATE TABLE IF NOT EXISTS win_rate_by_emotion (
  user_id UUID NOT NULL,
  emotional_state TEXT NOT NULL,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, emotional_state)
);

CREATE TABLE IF NOT EXISTS session_tilt (
  user_id UUID NOT NULL,
  session_id UUID NOT NULL,
  tilt_index NUMERIC(8, 4) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, session_id)
);

CREATE TABLE IF NOT EXISTS overtrading_events (
  event_id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  session_id UUID,
  detected_at TIMESTAMPTZ NOT NULL,
  trade_count INTEGER NOT NULL,
  window_minutes INTEGER NOT NULL DEFAULT 30,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
