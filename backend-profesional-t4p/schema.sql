-- Tabla principal de noticias ya traducidas y clasificadas.
CREATE TABLE IF NOT EXISTS articles (
  id TEXT PRIMARY KEY,            -- hash del link original, evita duplicados
  source TEXT NOT NULL,           -- ej: "FXStreet"
  source_url TEXT NOT NULL,
  title_original TEXT NOT NULL,
  title_es TEXT NOT NULL,
  summary_es TEXT,
  published_at INTEGER NOT NULL,  -- timestamp unix de publicación real
  fetched_at INTEGER NOT NULL,    -- timestamp unix de cuando lo procesamos nosotros
  assets TEXT NOT NULL,           -- JSON array, ej: '["EURUSD","XAU"]'
  impact TEXT NOT NULL,           -- ALTO | MEDIO | BAJO
  sentiment TEXT NOT NULL,        -- ALCISTA | BAJISTA | NEUTRAL
  confidence REAL NOT NULL        -- 0.0 a 1.0
);

CREATE INDEX IF NOT EXISTS idx_published_at ON articles(published_at);
CREATE INDEX IF NOT EXISTS idx_assets ON articles(assets);
