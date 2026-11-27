CREATE TABLE accounts (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password TEXT NOT NULL
) STRICT;
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY, name TEXT NOT NULL
) STRICT;
CREATE TABLE members (
  workspace_id TEXT NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES accounts ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('owner','member')),
  PRIMARY KEY(workspace_id,user_id)
) STRICT;
CREATE TABLE sessions (
  digest TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES accounts ON DELETE CASCADE,
  workspace_id TEXT NOT NULL, expires INTEGER NOT NULL,
  FOREIGN KEY(workspace_id,user_id) REFERENCES members ON DELETE CASCADE
) STRICT;
CREATE TABLE invites (
  id TEXT PRIMARY KEY, digest TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  email TEXT NOT NULL, expires INTEGER NOT NULL, revoked INTEGER, consumed INTEGER
) STRICT;
CREATE INDEX invites_workspace ON invites(workspace_id);
CREATE TABLE auth_attempts (
  bucket TEXT PRIMARY KEY, window INTEGER NOT NULL, attempts INTEGER NOT NULL
) STRICT;
CREATE TABLE workflows (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  creator_id TEXT NOT NULL REFERENCES accounts, name TEXT NOT NULL, published INTEGER NOT NULL,
  fictional INTEGER NOT NULL DEFAULT 0, UNIQUE(workspace_id,id)
) STRICT;
CREATE TABLE versions (
  workflow_id TEXT NOT NULL REFERENCES workflows ON DELETE CASCADE,
  number INTEGER NOT NULL, instructions TEXT NOT NULL,
  created INTEGER NOT NULL, PRIMARY KEY(workflow_id,number)
) STRICT;
CREATE TABLE examples (
  id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflows ON DELETE CASCADE,
  body TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES accounts
) STRICT;
CREATE TABLE runs (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, workflow_id TEXT NOT NULL,
  version INTEGER NOT NULL, user_id TEXT NOT NULL REFERENCES accounts,
  input_json TEXT NOT NULL, original TEXT NOT NULL, current_output TEXT NOT NULL, approved_output TEXT,
  status TEXT NOT NULL CHECK(status IN ('draft','changes requested','approved')),
  origin TEXT NOT NULL, created INTEGER NOT NULL, approved_at INTEGER,
  active_minutes REAL CHECK(active_minutes>=0), revisions INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '', reviewed INTEGER NOT NULL DEFAULT 0, edit_sequence INTEGER NOT NULL DEFAULT 0,
  comparison_of TEXT REFERENCES runs ON DELETE CASCADE, fictional INTEGER NOT NULL DEFAULT 0,
  UNIQUE(workspace_id,id),
  FOREIGN KEY(workspace_id,workflow_id) REFERENCES workflows(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workflow_id,version) REFERENCES versions(workflow_id,number),
  FOREIGN KEY(workspace_id,user_id) REFERENCES members
) STRICT;
CREATE INDEX runs_workspace ON runs(workspace_id,created);
CREATE INDEX runs_comparison ON runs(comparison_of);
CREATE TABLE baselines (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, workflow_id TEXT NOT NULL,
  label TEXT NOT NULL, minutes REAL CHECK(minutes>=0), revisions INTEGER CHECK(revisions>=0),
  approved INTEGER NOT NULL CHECK(approved IN (0,1)),
  elapsed_minutes REAL CHECK(elapsed_minutes>=0), fictional INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(workspace_id,workflow_id) REFERENCES workflows(workspace_id,id) ON DELETE CASCADE
) STRICT;
CREATE TABLE rates (
  workspace_id TEXT NOT NULL REFERENCES workspaces ON DELETE CASCADE, model TEXT NOT NULL,
  input_usd REAL NOT NULL CHECK(input_usd>=0), output_usd REAL NOT NULL CHECK(output_usd>=0),
  PRIMARY KEY(workspace_id,model)
) STRICT;
CREATE TABLE usage (
  workspace_id TEXT NOT NULL, run_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
  agent TEXT NOT NULL, category TEXT NOT NULL, model TEXT NOT NULL,
  input_tokens INTEGER CHECK(input_tokens>=0), output_tokens INTEGER CHECK(output_tokens>=0),
  latency_ms INTEGER CHECK(latency_ms>=0), cost_usd REAL CHECK(cost_usd>=0),
  cost_type TEXT CHECK(cost_type IN ('imported','estimated')),
  source TEXT NOT NULL CHECK(source IN ('in-app','csv')),
  PRIMARY KEY(workspace_id,run_id,fingerprint),
  FOREIGN KEY(workspace_id,run_id) REFERENCES runs(workspace_id,id) ON DELETE CASCADE
) STRICT;
CREATE TABLE ai_quota (
  scope TEXT NOT NULL, day TEXT NOT NULL, calls INTEGER NOT NULL,
  PRIMARY KEY(scope,day)
) STRICT;
