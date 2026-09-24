-- Roteamento por documento na recuperação (documento nomeado ganha bônus; cota por edital principal em perguntas comparativas).
UPDATE workspaces
SET settings_json = json_set(settings_json, '$.retrieval.documentRouting', json('true'))
WHERE json_extract(settings_json, '$.retrieval.documentRouting') IS NULL;
