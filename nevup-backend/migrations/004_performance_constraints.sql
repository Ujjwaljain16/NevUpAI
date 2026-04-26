-- Composite index for metrics performance
CREATE INDEX IF NOT EXISTS idx_trades_user_entry_at ON trades (user_id, entry_at);

-- 500-char length constraint for entry_rationale as per spec
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE conname = 'entry_rationale_length_check'
	) THEN
		ALTER TABLE trades
			ADD CONSTRAINT entry_rationale_length_check
			CHECK (char_length(entry_rationale) <= 500);
	END IF;
END $$;
