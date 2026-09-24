-- Prompt qa.v4: v3 + regra de revisão final das referências (rótulos, valores copiados literalmente) antes de responder.
UPDATE workspaces
SET settings_json = json_set(settings_json, '$.generation.promptVersion', 'qa.v4')
WHERE json_extract(settings_json, '$.generation.promptVersion') = 'qa.v3';
