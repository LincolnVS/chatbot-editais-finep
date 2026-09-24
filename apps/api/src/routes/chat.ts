/** POST /api/chat — protocolo useChat do AI SDK (stream), com persistência da conversa. */
import { Hono } from 'hono';
import { monotonicFactory } from 'ulid';
import { convertToModelMessages, createUIMessageStreamResponse, type ModelMessage, type UIMessage, type UIMessageChunk } from 'ai';
import type { AppContext } from '../context.ts';
import * as q from '../db/queries.ts';
import { answerStream, prepareAnswer, statusData } from '../llm/answer.ts';
import { providerLabel, resolveLlmConfig } from '../llm/providers.ts';
import { ChatRequest, type AnswerResult } from '@editais/shared';
import { ApiError, mergePipelineConfig, readJson, requireWorkspace } from './common.ts';

/** Texto de uma UIMessage (só as parts `text`). */
function textOf(message: UIMessage): string {
  return message.parts
    .filter((p): p is Extract<UIMessage['parts'][number], { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

function isUIMessage(value: unknown): value is UIMessage {
  const m = value as UIMessage | null;
  return !!m && typeof m === 'object' && typeof m.role === 'string' && Array.isArray(m.parts);
}

function toModelMessages(rows: q.MessageRow[]): ModelMessage[] {
  return rows
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
}

/** Parts persistidas com a resposta: texto, citações, avisos e status (o que a UI mostra ao reabrir a conversa). */
function assistantParts(result: AnswerResult): unknown[] {
  return [
    { type: 'text', text: result.text },
    ...result.citations.map((citation) => ({ type: 'data-citation', data: citation })),
    ...result.warnings.map((warning) => ({ type: 'data-warning', data: warning })),
    { type: 'data-status', data: statusData(result) },
  ];
}

/** Anexa ao chunk `start` o id da resposta (vira o id da mensagem no useChat, igual ao gravado) e `messageMetadata: { conversationId }`. */
function withConversationMetadata(stream: ReadableStream<UIMessageChunk>, conversationId: string, messageId: string): ReadableStream<UIMessageChunk> {
  return stream.pipeThrough(new TransformStream<UIMessageChunk, UIMessageChunk>({
    transform(chunk, controller) {
      controller.enqueue(chunk.type === 'start' ? { ...chunk, messageId, messageMetadata: { conversationId } } : chunk);
    },
  }));
}

const ulid = monotonicFactory();

export function chatRoutes(ctx: AppContext): Hono {
  const { db } = ctx;
  const app = new Hono();

  app.post('/chat', async (c) => {
    const body = ChatRequest.parse(await readJson(c));
    const workspace = requireWorkspace(db, body.workspaceId);
    const messages = body.messages.filter(isUIMessage);
    const last = messages.at(-1);
    if (!last || last.role !== 'user') throw new ApiError(400, 'validation', 'A última mensagem deve ser do usuário');
    const question = textOf(last).trim();
    if (!question) throw new ApiError(400, 'validation', 'A mensagem do usuário está vazia');
    const regenerate = body.trigger === 'regenerate-message';

    const llm = resolveLlmConfig(c.req.raw.headers, ctx.config.llmDefault);
    const config = mergePipelineConfig(workspace.settings, {
      ...body.pipelineConfig,
      generation: { ...body.pipelineConfig?.generation, mode: body.mode, ...(body.extraSearch !== undefined ? { extraSearch: body.extraSearch } : {}) },
    });

    let conversation = body.conversationId ? q.getConversation(db, body.conversationId) : null;
    if (body.conversationId && !conversation) throw new ApiError(404, 'not_found', `Conversa não encontrada: ${body.conversationId}`);
    if (conversation && conversation.workspaceId !== workspace.id) throw new ApiError(400, 'validation', 'A conversa pertence a outro workspace');
    const documentIds = body.documentIds ?? conversation?.scope.documentIds;
    if (!conversation) {
      conversation = q.createConversation(db, {
        workspaceId: workspace.id,
        scope: documentIds ? { documentIds } : {},
        mode: body.mode,
        providerLabel: providerLabel(llm),
        model: llm.model,
        pipelineConfig: config,
      });
    }
    const conversationId = conversation.id;

    // Mensagens já gravadas; ao regenerar, a última resposta sai e a pergunta (já gravada) não é repetida.
    let stored = q.listMessages(db, conversationId);
    if (regenerate && stored.at(-1)?.role === 'assistant') {
      q.deleteMessage(db, stored.at(-1)!.id);
      stored = stored.slice(0, -1);
    }
    const reuseQuestion = regenerate && stored.at(-1)?.role === 'user' && stored.at(-1)!.content === question;
    const previousStored = reuseQuestion ? stored.slice(0, -1) : stored;

    const previous = messages.slice(0, -1);
    let history: ModelMessage[];
    try {
      history = previous.length > 0 ? await convertToModelMessages(previous) : toModelMessages(previousStored);
    } catch (err) {
      throw new ApiError(400, 'validation', `messages inválidas: ${err instanceof Error ? err.message : String(err)}`);
    }

    const input = {
      db,
      workspaceId: workspace.id,
      question,
      documentIds,
      config,
      llm,
      llmFallback: ctx.config.llmFallback,
      history,
      embedQuery: (text: string) => ctx.embedder(config.embedModel).embedQuery(text),
    };
    const prepared = await prepareAnswer(input);
    if (!reuseQuestion) q.insertUserMessage(db, conversationId, question, last.parts);

    const assistantId = ulid();
    const { stream, result } = answerStream({ ...input, prepared });
    result
      .then((r) => {
        q.insertAssistantMessage(db, conversationId, r, assistantParts(r), assistantId);
        ctx.log.info({ conversationId, mode: r.mode, status: r.status, provider: r.provider, citations: r.citations.length, removed: r.grounding.removed, repaired: r.repaired, latencyMs: r.latencyMs }, 'chat respondido');
        if (r.repairIssues?.length) ctx.log.debug({ conversationId, repairIssues: r.repairIssues }, 'reparo solicitado ao modelo');
      })
      .catch((err: unknown) => ctx.log.warn({ err, conversationId }, 'resposta do chat não concluída'));

    return createUIMessageStreamResponse({ stream: withConversationMetadata(stream, conversationId, assistantId), headers: { 'X-Conversation-Id': conversationId } });
  });

  return app;
}
