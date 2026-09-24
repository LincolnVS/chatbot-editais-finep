import { z } from 'zod';
import { PipelineConfig, PipelineConfigPatch } from './pipeline-config.ts';

/* ---------- Domínio ---------- */

export const DocType = z.enum(['edital', 'apoio']);
export const DocKind = z.enum([
  'edital_principal', 'regulamento', 'anexo', 'faq', 'aviso_rerratificacao', 'edital_rerratificado',
  'cronograma_atualizado', 'comunicado', 'resultado', 'guia',
  'apoio_proposta', 'apoio_empresa', 'outro',
]);
export const DocumentStatus = z.enum(['uploaded', 'processing', 'ready', 'failed']);
export const IngestionStage = z.enum(['parse', 'normalize', 'chunk', 'embed', 'index', 'done']);

export type DocType = z.infer<typeof DocType>;
export type DocKind = z.infer<typeof DocKind>;
export type DocumentStatus = z.infer<typeof DocumentStatus>;
export type IngestionStage = z.infer<typeof IngestionStage>;

export const Workspace = z.object({
  id: z.string(),
  name: z.string(),
  agency: z.string().default('FINEP'),
  callCode: z.string().nullable().default(null),
  settings: PipelineConfig,
  createdAt: z.string(),
  updatedAt: z.string(),
  documentCount: z.number().optional(),
});
export type Workspace = z.infer<typeof Workspace>;

export const DocumentSummary = z.object({
  id: z.string(),
  workspaceId: z.string(),
  docType: DocType,
  docKind: DocKind,
  title: z.string(),
  filename: z.string(),
  sizeBytes: z.number(),
  pageCount: z.number().nullable(),
  publishedAt: z.string().nullable(),
  versionLabel: z.string().nullable(),
  amendsDocumentId: z.string().nullable(),
  precedence: z.number(),
  isCurrent: z.boolean(),
  status: DocumentStatus,
  error: z.string().nullable(),
  parserVersion: z.string().nullable(),
  chunkCount: z.number().optional(),
  createdAt: z.string(),
  indexedAt: z.string().nullable(),
});
export type DocumentSummary = z.infer<typeof DocumentSummary>;

export const IngestionJob = z.object({
  documentId: z.string(),
  stage: IngestionStage,
  status: z.enum(['queued', 'processing', 'done', 'failed']),
  progress: z.number().min(0).max(1),
  message: z.string().nullable(),
  error: z.string().nullable(),
  stageTimingsMs: z.record(z.string(), z.number()),
  updatedAt: z.string(),
});
export type IngestionJob = z.infer<typeof IngestionJob>;

/* ---------- Requests ---------- */

export const CreateWorkspaceRequest = z.object({
  name: z.string().min(1).max(200),
  agency: z.string().default('FINEP'),
  callCode: z.string().optional(),
  settings: PipelineConfig.optional(),
});

/** Campos do multipart de upload (além do arquivo em `file`). */
export const UploadDocumentFields = z.object({
  docType: DocType.default('edital'),
  docKind: DocKind.default('edital_principal'),
  title: z.string().min(1).max(300).optional(),
  publishedAt: z.string().optional(),
  versionLabel: z.string().optional(),
  amendsDocumentId: z.string().optional(),
});

/** Configuração do provedor de LLM — vem nos headers `X-LLM-*` (BYOK) ou do env (default/demo). Nunca persistida. */
export const LlmConfig = z.object({
  // `claude-code` = CLI do Claude Code local (`claude -p`, login/assinatura da máquina; sem chave). Só desenvolvimento e pesquisa.
  kind: z.enum(['mock', 'anthropic', 'openai', 'google', 'openai-compatible', 'claude-code']),
  baseURL: z.url().optional(),
  model: z.string().min(1),
  apiKey: z.string().optional(),
});
export type LlmConfig = z.infer<typeof LlmConfig>;

export const LLM_HEADERS = {
  kind: 'x-llm-provider',
  baseURL: 'x-llm-base-url',
  model: 'x-llm-model',
  apiKey: 'x-llm-key',
} as const;

export const AskRequest = z.object({
  workspaceId: z.string(),
  question: z.string().min(1),
  /** Documentos considerados; vazio/ausente = todos os documentos `ready` e vigentes do workspace. */
  documentIds: z.array(z.string()).optional(),
  mode: z.enum(['rag', 'full_context', 'closed_book']).default('rag'),
  /** Sobrescreve parcialmente as settings do workspace (experimentos) — só os campos enviados. */
  pipelineConfig: PipelineConfigPatch.optional(),
});
export type AskRequest = z.infer<typeof AskRequest>;

export const SearchRequest = z.object({
  workspaceId: z.string(),
  query: z.string().min(1),
  documentIds: z.array(z.string()).optional(),
  pipelineConfig: PipelineConfigPatch.optional(),
});

/** Corpo de `POST /api/chat` (protocolo useChat do AI SDK: `messages` são UIMessages). */
export const ChatRequest = z.object({
  workspaceId: z.string(),
  conversationId: z.string().optional(),
  messages: z.array(z.any()),
  documentIds: z.array(z.string()).optional(),
  mode: z.enum(['rag', 'full_context']).default('rag'),
  /** Só no modo rag: o modelo pode pedir buscas adicionais antes de responder (`generation.extraSearch`). */
  extraSearch: z.boolean().optional(),
  pipelineConfig: PipelineConfigPatch.optional(),
  /** Enviado pelo `DefaultChatTransport`: `regenerate-message` = refazer a última resposta (não repete a pergunta). */
  trigger: z.enum(['submit-message', 'regenerate-message']).optional(),
});

export const TestLlmRequest = z.object({ config: LlmConfig });

/** Avaliação de uma resposta pelo usuário (guardada com a mensagem; ainda não é usada para nada). */
export const MessageFeedbackRequest = z.object({ feedback: z.enum(['up', 'down']).nullable() });
export type MessageFeedback = z.infer<typeof MessageFeedbackRequest>['feedback'];
