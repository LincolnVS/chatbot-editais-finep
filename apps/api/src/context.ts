import { EventEmitter } from 'node:events';
import pino from 'pino';
import type { Db } from './db/sqlite.ts';
import { openDatabase } from './db/sqlite.ts';
import { config, type AppConfig } from './config.ts';
import { storage } from './storage.ts';
import { createDoclingClient, type DoclingClient } from './ingest/docling.ts';
import { getEmbedder, closeAllEmbedders, type Embedder } from './embed/client.ts';
import type { IngestionJob } from '@editais/shared';

/** Dependências compartilhadas por rotas, pipeline e harness. */
export type AppContext = {
  db: Db;
  config: AppConfig;
  log: pino.Logger;
  docling: DoclingClient;
  embedder(modelId?: string): Embedder;
  /** Emite `job:<documentId>` com IngestionJob a cada atualização (SSE assina aqui). */
  jobEvents: EventEmitter;
  close(): Promise<void>;
};

export function createContext(overrides: Partial<{ dbPath: string }> = {}): AppContext {
  storage.ensureDirs();
  const log = pino({
    level: config.logLevel,
    // Nunca logar chaves BYOK.
    redact: { paths: ['req.headers["x-llm-key"]', 'headers["x-llm-key"]', 'apiKey', '*.apiKey'], censor: '[redacted]' },
  });
  const db = openDatabase(overrides.dbPath ?? config.dbPath);
  const docling = createDoclingClient(config.doclingUrl);
  const jobEvents = new EventEmitter();
  jobEvents.setMaxListeners(1000);
  return {
    db,
    config,
    log,
    docling,
    embedder: (modelId) => getEmbedder(modelId ?? config.embedModel),
    jobEvents,
    async close() {
      await closeAllEmbedders();
      db.close();
    },
  };
}

export type JobEvent = IngestionJob;
