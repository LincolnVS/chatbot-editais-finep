/** Conversas: lista por workspace, detalhe com mensagens (e citações) e exclusão. */
import { Hono } from 'hono';
import type { AppContext } from '../context.ts';
import { MessageFeedbackRequest } from '@editais/shared';
import * as q from '../db/queries.ts';
import { ApiError, requireWorkspace } from './common.ts';

export function conversationRoutes(ctx: AppContext): Hono {
  const { db } = ctx;
  const app = new Hono();

  app.get('/workspaces/:id/conversations', (c) => {
    const workspace = requireWorkspace(db, c.req.param('id'));
    return c.json(q.listConversations(db, workspace.id));
  });

  app.get('/conversations/:id', (c) => {
    const id = c.req.param('id');
    const conversation = q.getConversation(db, id);
    if (!conversation) throw new ApiError(404, 'not_found', `Conversa não encontrada: ${id}`);
    return c.json({ ...conversation, messages: q.listMessages(db, id) });
  });

  app.put('/conversations/:id/messages/:messageId/feedback', async (c) => {
    const id = c.req.param('id');
    const parsed = MessageFeedbackRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ApiError(400, 'validation', 'feedback deve ser "up", "down" ou null');
    if (!q.setMessageFeedback(db, id, c.req.param('messageId'), parsed.data.feedback)) throw new ApiError(404, 'not_found', 'Mensagem não encontrada nesta conversa');
    return c.json({ ok: true, feedback: parsed.data.feedback });
  });

  app.delete('/conversations/:id', (c) => {
    const id = c.req.param('id');
    if (!q.getConversation(db, id)) throw new ApiError(404, 'not_found', `Conversa não encontrada: ${id}`);
    q.deleteConversation(db, id);
    return c.body(null, 204);
  });

  return app;
}
