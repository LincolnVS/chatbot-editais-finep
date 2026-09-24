-- Embedding padrão passa a e5-base (medição offline: item esperado no contexto 81% → 88% no híbrido sem expansão).
UPDATE workspaces
SET settings_json = json_set(settings_json, '$.embedModel', 'e5-base-q8')
WHERE json_extract(settings_json, '$.embedModel') = 'e5-small-q8';
