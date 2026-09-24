-- Glossário do domínio na recuperação: variantes determinísticas da consulta (ligado por padrão); bônus de seção e reranker ficam desligados.
UPDATE workspaces
SET settings_json = json_set(settings_json, '$.retrieval.glossary', json('true'), '$.retrieval.sectionBoost', json('false'), '$.retrieval.rerank', 'off', '$.retrieval.rerankCandidates', 40)
WHERE json_extract(settings_json, '$.retrieval.glossary') IS NULL;
