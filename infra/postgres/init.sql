CREATE TABLE payments (
  order_id TEXT PRIMARY KEY,
  amount_cents INT NOT NULL,
  status TEXT NOT NULL,
  provider_ref TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- deploy-registry gets its own database, separate from the payments ledger.
CREATE DATABASE registry;
\connect registry

CREATE SEQUENCE deploy_seq;

CREATE TABLE configs (
  service TEXT PRIMARY KEY,
  version INT NOT NULL,
  config JSONB NOT NULL,
  last_change_id TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE deploys (
  change_id TEXT PRIMARY KEY,
  service TEXT NOT NULL,
  version INT NOT NULL,
  diff JSONB NOT NULL,
  author TEXT,
  reason TEXT,
  ts TIMESTAMPTZ DEFAULT now()
);
