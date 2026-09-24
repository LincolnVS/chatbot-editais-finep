-- Recuperação: RRF k=1 e top-k 12 (varredura offline com expansão de consulta); a expansão entra pelo default do config.
UPDATE workspaces
SET settings_json = json_set(settings_json, '$.retrieval.rrfK', 1, '$.retrieval.topK', 12)
WHERE json_extract(settings_json, '$.retrieval.rrfK') = 60 AND json_extract(settings_json, '$.retrieval.topK') = 8;
