-- Workspaces criados com a família de prompts v1 passam para a v2 (regras de esclarecimento, abstenção e valores literais).
UPDATE workspaces
SET settings_json = json_set(settings_json, '$.generation.promptVersion', 'qa.v2')
WHERE json_extract(settings_json, '$.generation.promptVersion') = 'qa.v1';
