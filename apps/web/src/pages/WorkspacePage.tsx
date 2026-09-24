import { useCallback, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft } from 'lucide-react';
import type { DocumentSummary } from '@editais/shared';
import { Skeleton } from '@/components/ui/skeleton';
import { ChatPanel, type ChatMode } from '@/components/chat/ChatPanel';
import { CitationContext, type CitationSelection } from '@/components/chat/citation-context';
import { DocumentsPanel } from '@/components/documents/DocumentsPanel';
import { PdfDialog, type PdfTarget } from '@/components/pdf/PdfDialog';
import { useDocumentJobs } from '@/hooks/use-document-jobs';
import { getWorkspace } from '@/lib/api';

let sessionCounter = 0;
const newSessionKey = () => `new-${Date.now()}-${++sessionCounter}`;

/** Uma sessão de chat aberta nesta visita; a conversa nova ganha id no primeiro chunk da resposta. */
type Session = { key: string; conversationId: string | null };
type Sessions = { list: Session[]; activeKey: string };

/**
 * T1 — workspace: Fontes | Chat. A conversa atual vai na URL (?c=).
 * Cada conversa aberta vira uma sessão que fica montada (escondida) ao trocar de conversa: a resposta em andamento
 * continua chegando e está lá quando o usuário volta. Citações e "abrir PDF" abrem o visor por cima do chat.
 */
export function WorkspacePage() {
  const { workspaceId = '' } = useParams();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const conversationId = params.get('c');
  const [sessions, setSessions] = useState<Sessions>(() => {
    const first: Session = { key: conversationId ?? newSessionKey(), conversationId };
    return { list: [first], activeKey: first.key };
  });
  const [mode, setMode] = useState<ChatMode>('rag');
  const [scope, setScope] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<CitationSelection | null>(null);
  const [pdf, setPdf] = useState<PdfTarget | null>(null);

  const workspace = useQuery({
    queryKey: ['workspace', workspaceId],
    queryFn: () => getWorkspace(workspaceId),
    // enquanto algum documento processa, o SSE invalida; o polling é só rede de segurança
    refetchInterval: (q) => (q.state.data?.documents.some((d) => d.status === 'uploaded' || d.status === 'processing') ? 5_000 : false),
  });
  const documents = workspace.data?.documents;
  const jobs = useDocumentJobs(workspaceId, documents);

  const readyIds = useMemo(() => (documents ?? []).filter((d) => d.status === 'ready').map((d) => d.id), [documents]);
  // documentos do edital entram sempre; só os de apoio podem sair do escopo
  const editalIds = useMemo(() => new Set((documents ?? []).filter((d) => d.docType === 'edital').map((d) => d.id)), [documents]);
  const scopeIds = useMemo(() => readyIds.filter((id) => editalIds.has(id) || scope.size === 0 || scope.has(id)), [readyIds, editalIds, scope]);
  const filtered = scopeIds.length !== readyIds.length;

  const selectConversation = useCallback((id: string | null) => {
    setSelected(null);
    setSessions((prev) => {
      const existing = id ? prev.list.find((s) => s.conversationId === id) : undefined;
      if (existing) return { ...prev, activeKey: existing.key };
      const session: Session = { key: id ?? newSessionKey(), conversationId: id };
      return { list: [...prev.list, session], activeKey: session.key };
    });
    setParams(id ? { c: id } : {}, { replace: true });
  }, [setParams]);

  // A conversa nova ganhou id: a sessão continua a mesma (sem remontar o chat), a URL e a lista lateral atualizam já.
  const onConversationCreated = useCallback((key: string, id: string) => {
    setSessions((prev) => {
      if (prev.activeKey === key) setParams({ c: id }, { replace: true });
      return { ...prev, list: prev.list.map((s) => (s.key === key ? { ...s, conversationId: id } : s)) };
    });
    void qc.invalidateQueries({ queryKey: ['conversations', workspaceId] });
  }, [qc, setParams, workspaceId]);

  const toggleScope = useCallback((id: string) => {
    if (editalIds.has(id)) return;
    setScope((prev) => {
      const next = new Set(prev.size === 0 ? readyIds : prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      // todos marcados = sem filtro
      return next.size === readyIds.length ? new Set() : next;
    });
  }, [readyIds, editalIds]);

  // clique numa citação: marca a pílula e abre o PDF na página citada com o trecho destacado
  const citationCtx = useMemo(() => ({
    selected,
    select: (sel: CitationSelection) => {
      setSelected(sel);
      const c = sel.citation;
      const where = `${c.itemNumber ? `item ${c.itemNumber}` : c.sectionPath || ''} · p. ${c.page}`.replace(/^ · /, '');
      setPdf({ documentId: c.documentId, title: c.documentTitle, page: c.page, highlights: c.bboxes, where, quote: c.quote, label: c.label });
    },
  }), [selected]);

  const openDocument = useCallback((d: DocumentSummary) => setPdf({ documentId: d.id, title: d.title, page: 1, highlights: [] }), []);

  if (workspace.isLoading) return <div className="p-6"><Skeleton className="h-8 w-64" /></div>;
  if (workspace.error || !workspace.data) return <p className="p-6 text-sm text-destructive">Workspace não encontrado.</p>;

  return (
    <CitationContext.Provider value={citationCtx}>
      <div className="grid h-full grid-cols-[300px_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col border-r">
          <div className="flex items-center gap-1 border-b px-2 py-2">
            <Link to="/" className="rounded p-1 hover:bg-accent" aria-label="Voltar"><ChevronLeft className="size-4" /></Link>
            <h1 className="truncate text-sm font-semibold" title={workspace.data.name}>{workspace.data.name}</h1>
          </div>
          <DocumentsPanel
            workspaceId={workspaceId}
            documents={documents ?? []}
            jobs={jobs}
            conversationId={conversationId}
            onSelectConversation={selectConversation}
            scope={scope}
            onToggleScope={toggleScope}
            onOpenDocument={openDocument}
          />
        </aside>
        <section className="min-h-0 min-w-0">
          {sessions.list.map((s) => (
            <div key={s.key} hidden={s.key !== sessions.activeKey} className="h-full">
              <ChatPanel
                workspaceId={workspaceId}
                sessionKey={s.key}
                conversationId={s.conversationId}
                onConversationCreated={(id) => onConversationCreated(s.key, id)}
                mode={mode}
                onModeChange={setMode}
                documentIds={filtered ? scopeIds : []}
                readyCount={scopeIds.length}
              />
            </div>
          ))}
        </section>
      </div>
      <PdfDialog target={pdf} workspaceId={workspaceId} conversationId={conversationId} onClose={() => setPdf(null)} />
    </CitationContext.Provider>
  );
}
