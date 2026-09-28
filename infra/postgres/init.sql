CREATE TABLE payments (
  order_id TEXT PRIMARY KEY,
  amount_cents INT NOT NULL,
  status TEXT NOT NULL,
  provider_ref TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
