/** Cliente HTTP da API (Hono, /api). */
import type { AnswerStatus, DocumentSummary, EvalArm, EvalQuestion, EvalQuestionInput, EvalRun, EvalRunRequestInput, EvalRunSummary, GroundingReport, IngestionJob, LlmConfig, PipelineConfig, RetrievalResult, StoredChunk, Workspace, Citation, MessageFeedback } from '@editais/shared';
import { llmHeaders } from './llm-settings';

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(method: string, route: string, init: { body?: unknown; form?: FormData; headers?: Record<string, string> } = {}): Promise<T> {
  const headers: Record<string, string> = { ...init.headers };
  let body: BodyInit | undefined;
  if (init.form) body = init.form;
  else if (init.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.body);
  }
  const res = await fetch(route, { method, headers, body });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* corpo não-JSON: tratado abaixo */
  }
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? 'http_error', err?.message ?? `HTTP ${res.status}`);
  }
  return json as T;
}

/* ---------- tipos de resposta ---------- */

export type Health = { ok: boolean; db: boolean; docling: boolean; embedModel: string; embedModels: string[]; version: string; queue: { pending: number; size: number } };
export type WorkspaceDetail = Workspace & { documents: DocumentSummary[] };
export type DocumentDetail = DocumentSummary & { job: IngestionJob | null; stats: Record<string, number> | null; chunkSetId: string | null; pipelineHash: string | null; sha256: string };
export type ConversationSummary = {
  id: string; workspaceId: string; title: string | null; scope: { documentIds?: string[] }; mode: string;
  providerLabel: string | null; model: string | null; createdAt: string; updatedAt: string;
};
export type StoredMessage = {
  id: string; conversationId: string; role: 'user' | 'assistant' | 'system'; content: string; parts: unknown[] | null;
  provider: string | null; model: string | null; mode: string | null; latencyMs: number | null; repaired: boolean;
  invalidLabels: string[]; status: AnswerStatus | null; grounding: GroundingReport | null; rawContent: string | null;
  feedback: MessageFeedback; citations: Citation[]; createdAt: string;
};
export type ConversationDetail = ConversationSummary & { messages: StoredMessage[] };
export type LlmDefaults = {
  kind: LlmConfig['kind'];
  model: string;
  baseURL?: string | null;
  hasServerKey: boolean;
  fallback: { kind: LlmConfig['kind']; model: string } | null;
  /** O CLI do Claude Code existe no servidor (origem "claude -p" da sessão). */
  claudeCli: { available: boolean; command?: string; reason?: string };
};
export type LlmTestResult = { ok: boolean; latencyMs?: number; model?: string; kind?: string; error?: string };

/* ---------- health / llm ---------- */

export const getHealth = () => request<Health>('GET', '/api/health');
export const getLlmDefaults = () => request<LlmDefaults>('GET', '/api/llm/defaults');
export const getPrompt = (name: string) => request<{ name: string; text: string }>('GET', `/api/llm/prompts/${name}`);
export const testLlm = (config: LlmConfig) => request<LlmTestResult>('POST', '/api/llm/test', { body: { config } });

/* ---------- workspaces ---------- */

export const listWorkspaces = () => request<Workspace[]>('GET', '/api/workspaces');
export const getWorkspace = (id: string) => request<WorkspaceDetail>('GET', `/api/workspaces/${id}`);
export const createWorkspace = (body: { name: string; agency?: string; callCode?: string }) => request<Workspace>('POST', '/api/workspaces', { body });
export const deleteWorkspace = (id: string) => request<void>('DELETE', `/api/workspaces/${id}`);
export const patchWorkspaceSettings = (id: string, patch: Partial<PipelineConfig>) =>
  request<Workspace & { reindexing: number }>('PATCH', `/api/workspaces/${id}/settings`, { body: patch });

/* ---------- documentos ---------- */

export type UploadFields = { docType: 'edital' | 'apoio'; docKind: string; title?: string; versionLabel?: string; amendsDocumentId?: string; publishedAt?: string };

export function uploadDocument(workspaceId: string, file: File, fields: UploadFields) {
  const form = new FormData();
  form.append('file', file, file.name);
  for (const [k, v] of Object.entries(fields)) if (v) form.append(k, v);
  return request<{ document: DocumentSummary; job: IngestionJob }>('POST', `/api/workspaces/${workspaceId}/documents`, { form });
}
export const getDocument = (id: string) => request<DocumentDetail>('GET', `/api/documents/${id}`);
export const getDocumentStatus = (id: string) => request<IngestionJob>('GET', `/api/documents/${id}/status`);
export const getDocumentChunks = (id: string) => request<{ documentId: string; chunkSetId: string; count: number; chunks: StoredChunk[] }>('GET', `/api/documents/${id}/chunks`);
export const reprocessDocument = (id: string, force = false) => request<{ document: DocumentSummary; job: IngestionJob }>('POST', `/api/documents/${id}/reprocess`, { body: { force } });
export const deleteDocument = (id: string) => request<void>('DELETE', `/api/documents/${id}`);
export const documentFileUrl = (id: string) => `/api/documents/${id}/file`;

/* ---------- busca / conversas ---------- */

export const search = (workspaceId: string, query: string, documentIds?: string[]) =>
  request<RetrievalResult>('POST', `/api/workspaces/${workspaceId}/search`, { body: { workspaceId, query, documentIds } });
export const listConversations = (workspaceId: string) => request<ConversationSummary[]>('GET', `/api/workspaces/${workspaceId}/conversations`);
export const getConversation = (id: string) => request<ConversationDetail>('GET', `/api/conversations/${id}`);
export const deleteConversation = (id: string) => request<void>('DELETE', `/api/conversations/${id}`);
/** Guarda a avaliação (👍/👎) de uma resposta junto da conversa; ainda não é usada para nada. */
export const setMessageFeedback = (conversationId: string, messageId: string, feedback: MessageFeedback) =>
  request<{ ok: true; feedback: MessageFeedback }>('PUT', `/api/conversations/${conversationId}/messages/${messageId}/feedback`, { body: { feedback } });

/** Headers X-LLM-* da configuração BYOK atual (vazio = usar o provedor default do servidor). */
export { llmHeaders };

/* ---------- avaliação (harness) ---------- */

export const listEvalQuestionFiles = () => request<Array<{ file: string; count: number }>>('GET', '/api/eval/questions');
export const listEvalArms = () => request<EvalArm[]>('GET', '/api/eval/arms');
export type EvalDataset = { file: string; questions: EvalQuestion[] };
export const getEvalDataset = (file?: string) => request<EvalDataset>('GET', `/api/eval/dataset${file ? `?file=${encodeURIComponent(file)}` : ''}`);
export const saveEvalDataset = (body: { file?: string; questions: EvalQuestionInput[] }) => request<EvalDataset>('PUT', '/api/eval/dataset', { body });
export const listEvalRuns = () => request<EvalRunSummary[]>('GET', '/api/eval/runs');
export const getEvalRun = (id: string) => request<EvalRun>('GET', `/api/eval/runs/${id}`);
/** Inicia uma execução em segundo plano (202) com o provedor BYOK atual; acompanhe pelo GET. */
export const startEvalRun = (body: EvalRunRequestInput) => request<EvalRun>('POST', '/api/eval/runs', { body, headers: llmHeaders() });
export const resumeEvalRun = (id: string) => request<EvalRun>('POST', `/api/eval/runs/${id}/resume`, { headers: llmHeaders() });
export const deleteEvalRun = (id: string) => request<void>('DELETE', `/api/eval/runs/${id}`);
