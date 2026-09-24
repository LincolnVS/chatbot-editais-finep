-- Dedupe de upload garantido pelo banco: dois uploads simultâneos do mesmo PDF passam pela verificação da rota
-- (check-then-insert); o índice único decide e a rota responde 409.
CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_ws_sha ON documents(workspace_id, sha256);
