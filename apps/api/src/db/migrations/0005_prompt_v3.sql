-- Prompts v3: regra de ambiguidade passa a responder todas as leituras (em vez de perguntar).
UPDATE workspaces
SET settings_json = json_set(settings_json, '$.generation.promptVersion', 'qa.v3')
WHERE json_extract(settings_json, '$.generation.promptVersion') = 'qa.v2';
