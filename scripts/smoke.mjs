#!/usr/bin/env node
/** Smoke test ponta a ponta contra a API no ar: workspace → upload → ingestão → busca → ask → chat → conversa. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const API = (args.includes('--api') ? args[args.indexOf('--api') + 1] : process.env.API_URL) ?? 'http://localhost:3000';
const KEEP = args.includes('--keep');
const WORKSPACE_NAME = 'Subvenção Regional (teste)';
const QUESTION = 'prazo final para envio de propostas';
const INGEST_TIMEOUT_MS = 6 * 60 * 1000;

const SAMPLES = path.join(ROOT, 'data', 'samples');
const EDITAL = { file: 'sbv_regional_edital.pdf', title: 'Edital MIB R2 — Subvenção Econômica Regional', docType: 'edital', docKind: 'edital_principal', versionLabel: 'original' };
const AVISO = { file: 'sbv_regional_aviso_rerrat.pdf', title: 'Aviso de Rerratificação — Subvenção Regional', docType: 'edital', docKind: 'aviso_rerratificacao', versionLabel: '1a_rerratificacao' };

const summary = { api: API, documents: {}, search: {}, ask: {}, chat: {} };
let failed = false;

function fail(msg) {
  console.error(`\n[FALHA] ${msg}`);
  failed = true;
}

function short(s, n = 80) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

async function api(method, route, { body, headers = {}, form } = {}) {
  const init = { method, headers: { ...headers } };
  if (form) init.body = form;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  const res = await fetch(`${API}${route}`, init);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${route} → HTTP ${res.status}: ${short(text, 300)}`);
  }
  return res;
}

const json = (method, route, opts) => api(method, route, opts).then((r) => r.json());

async function upload(workspaceId, spec, extra = {}) {
  const p = path.join(SAMPLES, spec.file);
  if (!fs.existsSync(p)) throw new Error(`PDF não encontrado: ${p}`);
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(p)], { type: 'application/pdf' }), spec.file);
  for (const [k, v] of Object.entries({ docType: spec.docType, docKind: spec.docKind, title: spec.title, versionLabel: spec.versionLabel, ...extra })) form.append(k, v);
  const { document, job } = await json('POST', `/api/workspaces/${workspaceId}/documents`, { form });
  console.log(`  upload ${spec.file} → documento ${document.id} (job ${job.status}/${job.stage})`);
  return document;
}

async function waitIngestion(documentId, label) {
  const started = Date.now();
  let lastLine = '';
  for (;;) {
    const job = await json('GET', `/api/documents/${documentId}/status`);
    const line = `${job.stage} ${job.status} ${(job.progress * 100).toFixed(0)}%${job.message ? ` — ${job.message}` : ''}`;
    if (line !== lastLine) {
      console.log(`  [${label}] ${line}`);
      lastLine = line;
    }
    if (job.status === 'done' || job.status === 'failed') return job;
    if (Date.now() - started > INGEST_TIMEOUT_MS) throw new Error(`timeout de ${INGEST_TIMEOUT_MS / 60000} min na ingestão de ${label}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function readSse(res) {
  const types = [];
  const parts = [];
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const event = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of event.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') continue;
        const part = JSON.parse(data);
        types.push(part.type);
        parts.push(part);
      }
    }
  }
  return { types, parts };
}

function countBy(items, key) {
  const out = {};
  for (const it of items) out[key(it)] = (out[key(it)] ?? 0) + 1;
  return out;
}

async function main() {
  console.log(`API: ${API}`);
  const health = await json('GET', '/api/health');
  console.log(`health: db=${health.db} docling=${health.docling} embedModel=${health.embedModel} version=${health.version}`);
  if (!health.docling) throw new Error('docling-serve fora do ar (npm run dev:docling)');

  // workspace limpo (apaga sobras de execuções anteriores)
  for (const ws of await json('GET', '/api/workspaces')) {
    if (ws.name === WORKSPACE_NAME) {
      await api('DELETE', `/api/workspaces/${ws.id}`);
      console.log(`workspace anterior apagado: ${ws.id}`);
    }
  }
  const workspace = await json('POST', '/api/workspaces', { body: { name: WORKSPACE_NAME, callCode: 'MIB-R2-SBV-REGIONAL' } });
  console.log(`\nworkspace criado: ${workspace.id} (${workspace.name})`);
  summary.workspaceId = workspace.id;

  // uploads (a ingestão roda em fila, concorrência 1)
  console.log('\n== upload ==');
  const edital = await upload(workspace.id, EDITAL);
  const aviso = await upload(workspace.id, AVISO, { amendsDocumentId: edital.id });

  console.log('\n== ingestão ==');
  for (const [label, doc] of [['edital', edital], ['aviso', aviso]]) {
    const job = await waitIngestion(doc.id, label);
    const detail = await json('GET', `/api/documents/${doc.id}`);
    const chunksRes = await json('GET', `/api/documents/${doc.id}/chunks`);
    const chunks = chunksRes.chunks ?? [];
    const byKind = countBy(chunks, (c) => c.kind);
    const parents = chunks.filter((c) => c.kind === 'section' && !c.parentLabel).length;
    summary.documents[label] = {
      id: doc.id, status: detail.status, error: detail.error, pages: detail.pageCount, parserVersion: detail.parserVersion, precedence: detail.precedence,
      stats: detail.stats, chunks: chunks.length, byKind, parents, embedFalse: chunks.filter((c) => !c.embed).length,
      stageTimingsMs: job.stageTimingsMs,
    };
    console.log(`  [${label}] status=${detail.status} páginas=${detail.pageCount} parser=${detail.parserVersion} precedence=${detail.precedence}`);
    console.log(`  [${label}] stats=${JSON.stringify(detail.stats)}`);
    console.log(`  [${label}] chunks=${chunks.length} porKind=${JSON.stringify(byKind)} pais=${parents} embed=false: ${summary.documents[label].embedFalse}`);
    console.log(`  [${label}] tempos (ms)=${JSON.stringify(job.stageTimingsMs)}`);
    if (job.status !== 'done' || detail.status !== 'ready') fail(`ingestão do ${label} terminou com status ${job.status} (${job.error ?? detail.error ?? 'sem mensagem'})`);
    if (chunks.length === 0) fail(`documento ${label} sem chunks`);
  }
  if (failed) return;

  // search (só retrieval)
  console.log(`\n== search: "${QUESTION}" ==`);
  const search = await json('POST', `/api/workspaces/${workspace.id}/search`, { body: { query: QUESTION } });
  const top = search.context.slice(0, 5);
  for (const c of top) {
    const doc = c.documentId === aviso.id ? 'AVISO' : 'EDITAL';
    console.log(`  [${c.label}] ${doc} p.${c.pageStart} ${c.kind}${c.itemNumber ? ` item ${c.itemNumber}` : ''} prec=${c.precedence} — ${short(c.text)}`);
  }
  const cronograma = search.context.find((c) => /CRONOGRAMA/i.test(c.sectionPath) || /CRONOGRAMA/i.test(c.heading ?? '') || (c.kind === 'table' && /\d{2}\/\d{2}\/\d{4}/.test(c.text)));
  const avisoInContext = search.context.some((c) => c.documentId === aviso.id);
  summary.search = {
    candidates: search.candidates.length, context: search.context.length, contextChars: search.contextChars, latencyMs: Math.round(search.latencyMs),
    top5: top.map((c) => ({ label: c.label, doc: c.documentId === aviso.id ? 'aviso' : 'edital', kind: c.kind, itemNumber: c.itemNumber ?? null, page: c.pageStart, precedence: c.precedence, text: short(c.text) })),
    cronogramaNoContexto: cronograma ? { label: cronograma.label, kind: cronograma.kind, page: cronograma.pageStart, sectionPath: cronograma.sectionPath } : null,
    avisoNoContexto: avisoInContext,
    avisoPrimeiro: search.context[0]?.documentId === aviso.id,
  };
  console.log(`  candidatos=${search.candidates.length} contexto=${search.context.length} chars=${search.contextChars} latência=${Math.round(search.latencyMs)}ms`);
  console.log(`  cronograma no contexto: ${cronograma ? `sim (${cronograma.label}, ${cronograma.kind}, p.${cronograma.pageStart})` : 'NÃO'}; aviso (precedence 2) no contexto: ${avisoInContext ? 'sim' : 'NÃO'}`);
  if (search.context.length === 0) fail('search sem contexto');

  // ask — rag (mock)
  console.log('\n== ask (rag, mock) ==');
  const rag = await json('POST', '/api/ask', { body: { workspaceId: workspace.id, question: QUESTION, mode: 'rag' } });
  console.log(`  provider=${rag.provider} prompt=${rag.promptVersion} repaired=${rag.repaired} latência=${rag.latencyMs}ms`);
  console.log(`  texto: ${short(rag.text, 300)}`);
  for (const c of rag.citations) console.log(`  [${c.ordinal}] ${c.label} ${c.documentTitle} › ${c.itemNumber ?? c.sectionPath ?? '—'} · p.${c.page} · "${short(c.quote, 100)}"`);
  console.log(`  rótulos inválidos: ${JSON.stringify(rag.invalidLabels)}`);
  summary.ask.rag = { provider: rag.provider, citations: rag.citations.map((c) => ({ ordinal: c.ordinal, label: c.label, itemNumber: c.itemNumber ?? null, page: c.page, hasSection: c.hasSection })), invalidLabels: rag.invalidLabels, repaired: rag.repaired, latencyMs: rag.latencyMs };
  if (rag.citations.length === 0) fail('ask (rag) sem citações válidas');

  // ask — full_context (baseline)
  console.log('\n== ask (full_context, mock) ==');
  const full = await json('POST', '/api/ask', { body: { workspaceId: workspace.id, question: QUESTION, mode: 'full_context' } });
  console.log(`  fitsInWindow=${full.fitsInWindow} prompt=${full.promptVersion} citações=${full.citations.length} inválidas=${JSON.stringify(full.invalidLabels)}`);
  for (const c of full.citations) console.log(`  [${c.ordinal}] ${c.label} ${c.documentTitle} · p.${c.page} · "${short(c.quote, 100)}"`);
  summary.ask.fullContext = { fitsInWindow: full.fitsInWindow, citations: full.citations.length, invalidLabels: full.invalidLabels, inputTokens: full.usage?.inputTokens ?? null };

  // chat — stream useChat
  console.log('\n== chat (stream) ==');
  const chatRes = await api('POST', '/api/chat', {
    body: { workspaceId: workspace.id, messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: `Qual é o ${QUESTION}?` }] }] },
  });
  const conversationId = chatRes.headers.get('x-conversation-id');
  console.log(`  X-Conversation-Id: ${conversationId}`);
  const { types, parts } = await readSse(chatRes);
  console.log(`  parts: ${JSON.stringify(countBy(types, (t) => t))}`);
  const streamedText = parts.filter((p) => p.type === 'text-delta').map((p) => p.delta).join('');
  console.log(`  texto: ${short(streamedText, 200)}`);
  const citationParts = parts.filter((p) => p.type === 'data-citation');
  summary.chat = { conversationId, partTypes: countBy(types, (t) => t), citations: citationParts.length };
  if (!conversationId) fail('chat sem header X-Conversation-Id');
  if (!types.includes('text-delta')) fail('chat sem text-delta');
  if (!types.includes('finish')) fail('chat sem finish');

  // conversa persistida (a gravação acontece logo após o fim do stream)
  await new Promise((r) => setTimeout(r, 500));
  const conv = await json('GET', `/api/conversations/${conversationId}`);
  console.log(`\n== conversa ${conv.id} ("${conv.title}") ==`);
  for (const m of conv.messages) console.log(`  ${m.role}: ${short(m.content, 120)} (${m.citations.length} citações${m.provider ? `, ${m.provider}` : ''})`);
  summary.chat.persistedMessages = conv.messages.length;
  summary.chat.persistedCitations = conv.messages.filter((m) => m.role === 'assistant').reduce((n, m) => n + m.citations.length, 0);
  if (conv.messages.length < 2) fail('conversa sem as duas mensagens (user + assistant)');
  if (summary.chat.persistedCitations === 0) fail('mensagem do assistente sem citações persistidas');

  if (!KEEP) {
    await api('DELETE', `/api/workspaces/${workspace.id}`);
    console.log(`\nworkspace de teste apagado (use --keep para manter)`);
  }
}

try {
  await main();
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
const out = path.join(ROOT, 'data', 'tmp', 'smoke-result.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ ok: !failed, ...summary }, null, 2));
console.log(`\nRESUMO ${JSON.stringify({ ok: !failed, ...summary })}`);
console.log(failed ? '\nSMOKE: FALHOU' : '\nSMOKE: OK');
process.exit(failed ? 1 : 0);
