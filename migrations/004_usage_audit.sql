CREATE TABLE audit_snapshots (
  user_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK(source IN ('api','chat','logs')),
  imported INTEGER NOT NULL,
  report TEXT NOT NULL CHECK(json_valid(report)),
  PRIMARY KEY (user_id, source)
) STRICT;

CREATE TABLE audit_billing (
  user_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  customer TEXT UNIQUE,
  subscription TEXT UNIQUE,
  checkout TEXT,
  entitled INTEGER NOT NULL DEFAULT 0 CHECK(entitled IN (0,1)),
  entitlement_until INTEGER NOT NULL DEFAULT 0,
  checkout_until INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE audit_testers (
  user_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE
) STRICT;
