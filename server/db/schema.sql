-- Schema gestionale Bottega
-- Eseguito automaticamente all'avvio (idempotente).

CREATE TABLE IF NOT EXISTS products (
  id          SERIAL PRIMARY KEY,
  code        TEXT,                       -- codice / barcode Danea
  descr       TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT 'Senza categoria',
  cost        NUMERIC(12,2) NOT NULL DEFAULT 0,   -- prezzo di acquisto
  price       NUMERIC(12,2) NOT NULL DEFAULT 0,   -- prezzo di vendita
  stock       NUMERIC(12,2) NOT NULL DEFAULT 0,   -- giacenza
  archived    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Un codice non vuoto è univoco (permette upsert dagli import Danea).
CREATE UNIQUE INDEX IF NOT EXISTS products_code_uniq
  ON products (code) WHERE code IS NOT NULL AND code <> '';

CREATE INDEX IF NOT EXISTS products_category_idx ON products (category);

-- Movimenti = storico completo di magazzino.
-- kind: 'carico' | 'scarico' | 'rettifica' | 'vendita' | 'import'
CREATE TABLE IF NOT EXISTS movements (
  id          SERIAL PRIMARY KEY,
  product_id  INTEGER REFERENCES products(id) ON DELETE SET NULL,
  code        TEXT,             -- copia del codice per storico anche se il prodotto cambia
  descr       TEXT,
  kind        TEXT NOT NULL,
  qty         NUMERIC(12,2) NOT NULL,   -- + carico, - scarico
  stock_after NUMERIC(12,2),
  unit_cost   NUMERIC(12,2),
  unit_price  NUMERIC(12,2),
  note        TEXT,
  batch_id    INTEGER,          -- raggruppa un import Danea o uno scontrino
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS movements_created_idx ON movements (created_at);
CREATE INDEX IF NOT EXISTS movements_kind_idx    ON movements (kind);
CREATE INDEX IF NOT EXISTS movements_batch_idx   ON movements (batch_id);

-- Vendite (scontrini non fiscali)
CREATE TABLE IF NOT EXISTS sales (
  id         SERIAL PRIMARY KEY,
  subtotal   NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount   NUMERIC(12,2) NOT NULL DEFAULT 0,
  total      NUMERIC(12,2) NOT NULL DEFAULT 0,
  cash       NUMERIC(12,2),
  change     NUMERIC(12,2),
  voided       BOOLEAN NOT NULL DEFAULT FALSE,   -- scontrino stornato del tutto
  void_reason  TEXT,
  voided_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sales_created_idx ON sales (created_at);

CREATE TABLE IF NOT EXISTS sale_items (
  id         SERIAL PRIMARY KEY,
  sale_id    INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  descr      TEXT,
  qty        NUMERIC(12,2) NOT NULL,             -- quantità venduta originale
  qty_returned NUMERIC(12,2) NOT NULL DEFAULT 0, -- quantità già resa (storno parziale)
  unit_price NUMERIC(12,2) NOT NULL,
  line_total NUMERIC(12,2) NOT NULL
);

-- Sequenza per batch_id (usata per raggruppare import/scontrini)
CREATE SEQUENCE IF NOT EXISTS batch_seq START 1;

-- Migrazioni idempotenti (per database già esistenti: aggiungono le colonne se mancano)
ALTER TABLE sales      ADD COLUMN IF NOT EXISTS voided      BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE sales      ADD COLUMN IF NOT EXISTS void_reason TEXT;
ALTER TABLE sales      ADD COLUMN IF NOT EXISTS voided_at   TIMESTAMPTZ;
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS qty_returned NUMERIC(12,2) NOT NULL DEFAULT 0;
