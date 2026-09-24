-- Glossário derivado do documento: montado na ingestão a partir das definições, siglas e expressões do próprio edital.
CREATE TABLE IF NOT EXISTS glossary_entries (
  document_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  chunk_set_id TEXT NOT NULL,
  term         TEXT NOT NULL,
  aliases_json TEXT NOT NULL,
  kind         TEXT NOT NULL,
  label        TEXT
);
CREATE INDEX IF NOT EXISTS idx_glossary_workspace ON glossary_entries(workspace_id, chunk_set_id);
CREATE INDEX IF NOT EXISTS idx_glossary_document ON glossary_entries(document_id);

-- O glossário escrito à mão sai de cena: ele foi montado olhando as perguntas de avaliação. No lugar entram o glossário
-- derivado do documento (ligado) e a realimentação por pseudo-relevância (desligada até ser medida).
UPDATE workspaces
SET settings_json = json_set(settings_json, '$.retrieval.docGlossary', json('true'), '$.retrieval.prf', json('false'), '$.retrieval.glossary', json('false'))
WHERE json_extract(settings_json, '$.retrieval.docGlossary') IS NULL;
