ALTER TABLE contacts ADD COLUMN ownerEmail TEXT;
ALTER TABLE contacts ADD COLUMN teamId TEXT;
ALTER TABLE contacts ADD COLUMN createdByEmail TEXT;
ALTER TABLE contacts ADD COLUMN createdAt TEXT;
ALTER TABLE contacts ADD COLUMN updatedAt TEXT;
ALTER TABLE contacts ADD COLUMN lastContactedAt TEXT;
ALTER TABLE contacts ADD COLUMN nextFollowUpAt TEXT;
ALTER TABLE contacts ADD COLUMN dealExpectedAt TEXT;
ALTER TABLE contacts ADD COLUMN leadScore INTEGER NOT NULL DEFAULT 0;

UPDATE contacts SET createdAt = COALESCE(createdAt, CURRENT_TIMESTAMP), updatedAt = COALESCE(updatedAt, CURRENT_TIMESTAMP);

CREATE INDEX IF NOT EXISTS idx_contacts_owner ON contacts(ownerEmail);
CREATE INDEX IF NOT EXISTS idx_contacts_team ON contacts(teamId);
CREATE INDEX IF NOT EXISTS idx_contacts_created_at ON contacts(createdAt);
