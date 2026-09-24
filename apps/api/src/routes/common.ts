/** Utilitários compartilhados pelos routers (erro HTTP tipado, lookups 404, mesclagem de PipelineConfig). */
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Db } from '../db/sqlite.ts';
import { getDocument, getWorkspace } from '../db/queries.ts';
import { EMBED_MODELS } from '../embed/registry.ts';
import { PipelineConfig, type DocumentSummary, type Workspace } from '@editais/shared';

/** Erro de API com status e código estáveis: `{ error: { code, message } }`. */
export class ApiError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: string;
  constructor(status: ContentfulStatusCode, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export function requireWorkspace(db: Db, id: string): Workspace {
  const ws = getWorkspace(db, id);
  if (!ws) throw new ApiError(404, 'not_found', `Workspace não encontrado: ${id}`);
  return ws;
}

export function requireDocument(db: Db, id: string): DocumentSummary {
  const doc = getDocument(db, id);
  if (!doc) throw new ApiError(404, 'not_found', `Documento não encontrado: ${id}`);
  return doc;
}

/** Corpo JSON do request; JSON malformado ou corpo vazio → 400. */
export async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ApiError(400, 'invalid_json', 'Corpo da requisição deve ser JSON válido');
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch === undefined ? base : patch;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    out[key] = deepMerge(base[key], value);
  }
  return out;
}

/** Mescla um PipelineConfig parcial (qualquer profundidade) sobre `base` e valida o resultado (ZodError → 400). */
export function mergePipelineConfig(base: PipelineConfig, patch: unknown): PipelineConfig {
  if (patch === undefined || patch === null) return base;
  if (!isPlainObject(patch)) throw new ApiError(400, 'validation', 'pipelineConfig deve ser um objeto');
  const config = PipelineConfig.parse(deepMerge(base, patch));
  if (!(config.embedModel in EMBED_MODELS)) {
    throw new ApiError(400, 'validation', `Modelo de embedding desconhecido: ${config.embedModel} (conhecidos: ${Object.keys(EMBED_MODELS).join(', ')})`);
  }
  return config;
}
