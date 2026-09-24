-- Desfecho da resposta (answered/partial/clarification/not_found/unsupported) e relatório do gate de fundamentação.
ALTER TABLE messages ADD COLUMN status TEXT;
ALTER TABLE messages ADD COLUMN grounding_json TEXT;
ALTER TABLE messages ADD COLUMN raw_content TEXT;
