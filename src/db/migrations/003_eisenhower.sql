-- Eisenhower "Power Grid" redesign: quadrant + duration per task,
-- plus new adaptation biases the AI reads on next extraction.
-- Quadrant keys: 'do' (urgent+important) | 'plan' (important) | 'quick' (urgent) | 'later'.

ALTER TABLE tasks ADD COLUMN ai_eisenhower TEXT;
ALTER TABLE tasks ADD COLUMN user_eisenhower TEXT;
ALTER TABLE tasks ADD COLUMN ai_duration_minutes INTEGER;
ALTER TABLE tasks ADD COLUMN user_duration_minutes INTEGER;

-- duration_bias: log-ratio of user/AI estimates, clamped to [-0.5, +0.5].
-- Applied as a multiplier on AI duration predictions in getDashboard.
ALTER TABLE adaptation_weights ADD COLUMN duration_bias REAL NOT NULL DEFAULT 0.0;

-- quadrant biases: shift scoreEisenhower thresholds in [-0.25, +0.25].
-- Positive urgent_bias makes the user's "urgent" threshold easier to cross.
ALTER TABLE adaptation_weights ADD COLUMN quadrant_urgent_bias    REAL NOT NULL DEFAULT 0.0;
ALTER TABLE adaptation_weights ADD COLUMN quadrant_important_bias REAL NOT NULL DEFAULT 0.0;
