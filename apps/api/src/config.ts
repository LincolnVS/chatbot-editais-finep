import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LlmConfig } from '@editais/shared';

function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

/** Raiz do monorepo (apps/api/src/config.ts → ../../..). */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
// DATA_DIR relativo é resolvido a partir da raiz do repo (não do cwd): `npm run dev -w apps/api` roda com cwd=apps/api.
const dataDir = path.resolve(REPO_ROOT, env('DATA_DIR', './data') ?? './data');

/** Configuração do processo (lida do .env na raiz do repo via `node --env-file-if-exists`). */
export const config = {
  port: Number(env('PORT', '3000')),
  dataDir,
  dbPath: path.join(dataDir, 'editais.db'),
  uploadsDir: path.join(dataDir, 'uploads'),
  parsedDir: path.join(dataDir, 'parsed'),
  modelsDir: path.join(dataDir, 'models'),
  /** Padrões-ouro (CSV versionados) e saídas do harness de avaliação. */
  evalDir: path.resolve(REPO_ROOT, env('EVAL_DIR', 'eval') ?? 'eval'),
  /** Padrão-ouro em edição na tela Dataset. */
  evalDataset: env('EVAL_DATASET', 'nucleo.csv') ?? 'nucleo.csv',
  evalRunsDir: path.join(dataDir, 'eval', 'runs'),
  doclingUrl: env('DOCLING_URL', 'http://localhost:5001') as string,
  embedModel: env('EMBED_MODEL', 'e5-base-q8') as string,
  logLevel: env('LOG_LEVEL', 'info') as string,
  /** Provedor usado quando o cliente não envia headers X-LLM-*. */
  llmDefault: LlmConfig.parse({
    kind: env('LLM_DEFAULT_KIND', 'mock'),
    baseURL: env('LLM_DEFAULT_BASE_URL'),
    model: env('LLM_DEFAULT_MODEL', env('LLM_DEFAULT_KIND', 'mock') === 'mock' ? 'mock-1' : undefined),
    apiKey: env('LLM_DEFAULT_API_KEY'),
  }),
  /** Provedor reserva (LLM_FALLBACK_*): usado quando o principal falha por limite de uso, indisponibilidade ou timeout. */
  llmFallback: env('LLM_FALLBACK_KIND')
    ? LlmConfig.parse({
        kind: env('LLM_FALLBACK_KIND'),
        baseURL: env('LLM_FALLBACK_BASE_URL'),
        model: env('LLM_FALLBACK_MODEL'),
        apiKey: env('LLM_FALLBACK_API_KEY'),
      })
    : undefined,
  maxUploadBytes: 100 * 1024 * 1024,
};

export type AppConfig = typeof config;
