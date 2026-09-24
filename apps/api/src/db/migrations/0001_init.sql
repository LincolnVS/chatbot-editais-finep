-- Schema v1: relacional + FTS5 (BM25) + vec0 (KNN) num único arquivo SQLite.

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  agency        TEXT NOT NULL DEFAULT 'FINEP',
  call_code     TEXT,
  settings_json TEXT NOT NULL,             -- PipelineConfig default do workspace
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  doc_type              TEXT NOT NULL CHECK (doc_type IN ('edital','apoio')),
  doc_kind              TEXT NOT NULL,
  title                 TEXT NOT NULL,
  filename              TEXT NOT NULL,
  mime                  TEXT NOT NULL DEFAULT 'application/pdf',
  sha256                TEXT NOT NULL,
  size_bytes            INTEGER NOT NULL,
  page_count            INTEGER,
  published_at          TEXT,
  version_label         TEXT,
  amends_document_id    TEXT REFERENCES documents(id),
  precedence            INTEGER NOT NULL DEFAULT 1,   -- retificação = 2 (prevalece no contexto)
  is_current            INTEGER NOT NULL DEFAULT 1,
  status                TEXT NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded','processing','ready','failed')),
  error                 TEXT,
  parser                TEXT,
  parser_version        TEXT,
  parse_hash            TEXT,                          -- sha256 do JSON do Docling congelado
  canonical_sha256      TEXT,
  chunk_set_id          TEXT,                          -- conjunto de chunks vigente (chunkSetId)
  pipeline_hash         TEXT,
  stats_json            TEXT,                          -- ParsedDocument.stats
  created_at            TEXT NOT NULL,
  indexed_at            TEXT
);
CREATE INDEX IF NOT EXISTS idx_documents_ws ON documents(workspace_id, status, is_current);

CREATE TABLE IF NOT EXISTS doc_pages (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_number INTEGER NOT NULL,
  width       REAL NOT NULL,
  height      REAL NOT NULL,
  char_count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (document_id, page_number)
);

CREATE TABLE IF NOT EXISTS chunks (
  rowid          INTEGER PRIMARY KEY,
  label          TEXT NOT NULL,                        -- c_xxxxxx (único por chunk_set)
  document_id    TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  workspace_id   TEXT NOT NULL,
  chunk_set_id   TEXT NOT NULL,
  parent_label   TEXT,
  kind           TEXT NOT NULL,
  level          INTEGER NOT NULL DEFAULT 0,
  order_index    INTEGER NOT NULL,
  item_number    TEXT,
  section_path   TEXT NOT NULL DEFAULT '',
  heading        TEXT,
  text           TEXT NOT NULL,
  context_prefix TEXT NOT NULL DEFAULT '',
  char_count     INTEGER NOT NULL,
  page_start     INTEGER NOT NULL,
  page_end       INTEGER NOT NULL,
  bboxes_json    TEXT NOT NULL DEFAULT '[]',
  char_start     INTEGER NOT NULL DEFAULT 0,
  char_end       INTEGER NOT NULL DEFAULT 0,
  content_hash   TEXT NOT NULL,
  embed          INTEGER NOT NULL DEFAULT 1,
  UNIQUE (document_id, chunk_set_id, label)
);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(document_id, chunk_set_id);
CREATE INDEX IF NOT EXISTS idx_chunks_ws ON chunks(workspace_id, chunk_set_id);
CREATE INDEX IF NOT EXISTS idx_chunks_item ON chunks(document_id, item_number);
CREATE INDEX IF NOT EXISTS idx_chunks_parent ON chunks(document_id, chunk_set_id, parent_label);

-- Índice léxico (BM25). Conteúdo externo = tabela chunks; sincronizado por triggers.
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text, context_prefix,
  content='chunks', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text, context_prefix) VALUES (new.rowid, new.text, new.context_prefix);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text, context_prefix) VALUES ('delete', old.rowid, old.text, old.context_prefix);
END;
CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text, context_prefix) VALUES ('delete', old.rowid, old.text, old.context_prefix);
  INSERT INTO chunks_fts(rowid, text, context_prefix) VALUES (new.rowid, new.text, new.context_prefix);
END;

-- Cache de embeddings: reindexar por variante de chunking sem re-embedar texto idêntico.
CREATE TABLE IF NOT EXISTS embedding_cache (
  content_hash TEXT NOT NULL,
  model_id     TEXT NOT NULL,
  dims         INTEGER NOT NULL,
  vector       BLOB NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (content_hash, model_id)
);

-- Catálogo das tabelas vec0 (uma por modelo/dims): chunks_vec_<modelId sem símbolos>
CREATE TABLE IF NOT EXISTS embedding_indexes (
  model_id   TEXT PRIMARY KEY,
  table_name TEXT NOT NULL,
  dims       INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ingestion_jobs (
  document_id        TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  stage              TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('queued','processing','done','failed')),
  progress           REAL NOT NULL DEFAULT 0,
  message            TEXT,
  error              TEXT,
  attempts           INTEGER NOT NULL DEFAULT 0,
  pipeline_hash      TEXT,
  stage_timings_json TEXT NOT NULL DEFAULT '{}',
  started_at         TEXT,
  finished_at        TEXT,
  updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id                   TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title                TEXT,
  scope_json           TEXT NOT NULL DEFAULT '{}',
  mode                 TEXT NOT NULL DEFAULT 'rag',
  provider_label       TEXT,                           -- só rótulo (kind/model). NUNCA a chave.
  model                TEXT,
  pipeline_config_json TEXT,
  config_hash          TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS retrieval_runs (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  query           TEXT NOT NULL,
  scope_json      TEXT NOT NULL,
  config_hash     TEXT NOT NULL,
  candidates_json TEXT NOT NULL,
  context_chars   INTEGER NOT NULL,
  latency_ms      INTEGER NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id                  TEXT PRIMARY KEY,
  conversation_id     TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role                TEXT NOT NULL,
  content             TEXT NOT NULL,
  parts_json          TEXT,
  provider            TEXT,
  model               TEXT,
  mode                TEXT,
  usage_json          TEXT,
  latency_ms          INTEGER,
  retrieval_run_id    TEXT REFERENCES retrieval_runs(id),
  fits_in_window      INTEGER,
  repaired            INTEGER NOT NULL DEFAULT 0,
  invalid_labels_json TEXT NOT NULL DEFAULT '[]',
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS citations (
  id            TEXT PRIMARY KEY,
  message_id    TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  ordinal       INTEGER NOT NULL,
  label         TEXT NOT NULL,
  chunk_rowid   INTEGER NOT NULL,
  document_id   TEXT NOT NULL,
  page          INTEGER NOT NULL,
  section_path  TEXT NOT NULL DEFAULT '',
  item_number   TEXT,
  quote         TEXT NOT NULL,
  bboxes_json   TEXT NOT NULL DEFAULT '[]',
  has_section   INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);
