/** Boot do servidor: contexto → app → HTTP; reenfileira jobs de ingestão pendentes (crash recovery). */
import { serve } from '@hono/node-server';
import { createContext } from './context.ts';
import { createApp } from './app.ts';
import { resumePendingJobs } from './ingest/queue.ts';

const ctx = createContext();
const app = createApp(ctx);
const resumed = resumePendingJobs(ctx);
if (resumed) ctx.log.info({ resumed }, 'jobs de ingestão reenfileirados');

const server = serve({ fetch: app.fetch, port: ctx.config.port }, (info) => {
  ctx.log.info({ port: info.port, docling: ctx.config.doclingUrl, embedModel: ctx.config.embedModel }, 'API no ar');
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    ctx.log.info('encerrando…');
    server.close();
    await ctx.close();
    process.exit(0);
  });
}
