/** GET /api/health — estado do banco, do sidecar Docling e do modelo de embedding. */
import fs from 'node:fs';
import { Hono } from 'hono';
import type { AppContext } from '../context.ts';
import { queueSize } from '../ingest/queue.ts';
import { EMBED_MODELS } from '../embed/registry.ts';

function apiVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function healthRoutes(ctx: AppContext): Hono {
  const version = apiVersion();
  const app = new Hono();

  app.get('/health', async (c) => {
    let db = false;
    try {
      ctx.db.prepare('select 1').get();
      db = true;
    } catch (err) {
      ctx.log.error({ err }, 'banco indisponível');
    }
    const docling = await ctx.docling.isUp();
    return c.json({ ok: db, db, docling, embedModel: ctx.config.embedModel, embedModels: Object.keys(EMBED_MODELS), version, queue: queueSize() }, db ? 200 : 503);
  });

  return app;
}
