CREATE TABLE payments (
  order_id TEXT PRIMARY KEY,
  amount_cents INT NOT NULL,
  status TEXT NOT NULL,
  provider_ref TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- INC-09's compliance audit trail. Only written when ledger.auditWrites is
-- on - the incident's causal step.
CREATE TABLE audit_log (
  order_id TEXT PRIMARY KEY,
  amount_cents INT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- order-service's product catalog. IDs 1-3 are the "hot" products loadgen
-- points 80% of traffic at, for INC-03's cache stampede - nothing in the
-- schema marks them hot, that's purely a loadgen traffic-shape decision.
CREATE TABLE products (
  id INT PRIMARY KEY,
  name TEXT NOT NULL,
  price_cents INT NOT NULL
);

INSERT INTO products (id, name, price_cents) VALUES
  (1, 'Hot Product A', 1999),
  (2, 'Hot Product B', 2999),
  (3, 'Hot Product C', 4999),
  (4, 'Widget', 799),
  (5, 'Gadget', 1299),
  (6, 'Gizmo', 599),
  (7, 'Doohickey', 1599),
  (8, 'Thingamajig', 2199),
  (9, 'Contraption', 3499),
  (10, 'Apparatus', 899),
  (11, 'Device', 1099),
  (12, 'Instrument', 2799),
  (13, 'Tool', 649),
  (14, 'Accessory', 1799),
  (15, 'Component', 2399),
  (16, 'Module', 1499),
  (17, 'Assembly', 3199),
  (18, 'Fixture', 999),
  (19, 'Bracket', 1199),
  (20, 'Fastener', 399);

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
