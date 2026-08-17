ALTER TABLE users ADD COLUMN teamId TEXT NOT NULL DEFAULT 'sales';

CREATE TABLE IF NOT EXISTS conversation_assignments (
  conversationId TEXT PRIMARY KEY,
  assignedUserEmail TEXT,
  assignedTeamId TEXT,
  assignedByEmail TEXT NOT NULL,
  assignedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (assignedUserEmail) REFERENCES users(email) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_conversation_assignment_user
  ON conversation_assignments(assignedUserEmail);
CREATE INDEX IF NOT EXISTS idx_conversation_assignment_team
  ON conversation_assignments(assignedTeamId);
