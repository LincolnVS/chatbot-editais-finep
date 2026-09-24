import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, FileText, Loader2, Lock, MessageSquare, MoreHorizontal, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { DocumentSummary, IngestionJob } from '@editais/shared';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { deleteConversation, deleteDocument, listConversations, reprocessDocument } from '@/lib/api';
import { DOC_KIND_LABELS, STAGE_LABELS, formatDate, truncate } from '@/lib/format';
import { UploadDocumentDialog } from './UploadDocumentDialog';

type Props = {
  workspaceId: string;
  documents: DocumentSummary[];
  jobs: Record<string, IngestionJob>;
  conversationId: string | null;
  onSelectConversation: (id: string | null) => void;
  /** Documentos de apoio incluídos no escopo das perguntas (vazio = todos); os do edital entram sempre. */
  scope: Set<string>;
  onToggleScope: (id: string) => void;
  /** Abre o PDF por cima do chat (sem sair da conversa). */
  onOpenDocument: (d: DocumentSummary) => void;
};

/** Painel esquerdo (T1): fontes do edital, documentos de apoio e conversas. */
export function DocumentsPanel({ workspaceId, documents, jobs, conversationId, onSelectConversation, scope, onToggleScope, onOpenDocument }: Props) {
  const qc = useQueryClient();
  const [upload, setUpload] = useState<{ open: boolean; type: 'edital' | 'apoio' }>({ open: false, type: 'edital' });
  const conversations = useQuery({ queryKey: ['conversations', workspaceId], queryFn: () => listConversations(workspaceId) });

  const removeDoc = useMutation({
    mutationFn: deleteDocument,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workspace', workspaceId] }),
    onError: (err) => toast.error(err.message),
  });
  const reprocess = useMutation({
    mutationFn: (id: string) => reprocessDocument(id, true),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workspace', workspaceId] }),
    onError: (err) => toast.error(err.message),
  });
  const removeConv = useMutation({
    mutationFn: deleteConversation,
    onSuccess: (_r, id) => {
      void qc.invalidateQueries({ queryKey: ['conversations', workspaceId] });
      if (id === conversationId) onSelectConversation(null);
    },
    onError: (err) => toast.error(err.message),
  });

  const editais = documents.filter((d) => d.docType === 'edital');
  const apoio = documents.filter((d) => d.docType === 'apoio');

  const renderDoc = (d: DocumentSummary) => {
    const job = jobs[d.id];
    const busy = d.status === 'uploaded' || d.status === 'processing';
    const edital = d.docType === 'edital';
    const inScope = edital || scope.size === 0 || scope.has(d.id);
    const detail = `/w/${workspaceId}/doc/${d.id}${conversationId ? `?c=${conversationId}` : ''}`;
    return (
      <li key={d.id} className={`group rounded-md border px-2 py-1.5 text-sm ${inScope ? '' : 'opacity-50'}`}>
        <div className="flex items-start gap-2">
          {edital ? (
            <Lock className="mt-1 size-3.5 shrink-0 text-muted-foreground" aria-label="sempre incluído nas perguntas" />
          ) : (
            <input
              type="checkbox"
              className="mt-1 size-3.5 shrink-0 accent-primary"
              checked={inScope}
              disabled={d.status !== 'ready'}
              title="Incluir nas perguntas"
              onChange={() => onToggleScope(d.id)}
            />
          )}
          <div className="min-w-0 flex-1">
            <button type="button" onClick={() => onOpenDocument(d)} className="line-clamp-2 text-left font-medium hover:underline" title={d.title}>
              {d.title}
            </button>
            <div className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
              <span>{DOC_KIND_LABELS[d.docKind]}</span>
              {d.precedence > 1 && <Badge variant="outline" className="h-4 px-1 text-[10px]">prevalece</Badge>}
              {d.pageCount != null && <span>· {d.pageCount} p.</span>}
              {d.chunkCount != null && d.status === 'ready' && <span>· {d.chunkCount} trechos</span>}
              {d.status === 'failed' && (
                <Tooltip>
                  <TooltipTrigger><AlertTriangle className="size-3.5 text-destructive" /></TooltipTrigger>
                  <TooltipContent className="max-w-xs">{d.error ?? 'falhou'}</TooltipContent>
                </Tooltip>
              )}
            </div>
            {busy && (
              <div className="mt-1">
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" />
                  <span>{job ? `${STAGE_LABELS[job.stage]}${job.message ? ` — ${truncate(job.message, 60)}` : ''}` : 'na fila…'}</span>
                </div>
                <Progress value={Math.round((job?.progress ?? 0) * 100)} className="mt-1 h-1" />
              </div>
            )}
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger className="rounded p-1 opacity-0 hover:bg-accent group-hover:opacity-100 data-[popup-open]:opacity-100" aria-label="Ações">
              <MoreHorizontal className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => onOpenDocument(d)}>Abrir PDF</DropdownMenuItem>
              <DropdownMenuItem render={<Link to={detail} />}>Trechos e processamento</DropdownMenuItem>
              <DropdownMenuItem onClick={() => reprocess.mutate(d.id)} disabled={busy}>Reprocessar</DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onClick={() => { if (confirm(`Apagar "${d.title}"?`)) removeDoc.mutate(d.id); }}>Apagar</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </li>
    );
  };

  return (
    <div className="flex h-full flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-5 p-3">
          <section>
            <header className="mb-2 flex items-center justify-between">
              <h2 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <FileText className="size-3.5" /> Edital
              </h2>
              <Button variant="ghost" size="icon-sm" aria-label="Enviar documento do edital" onClick={() => setUpload({ open: true, type: 'edital' })}>
                <Plus className="size-4" />
              </Button>
            </header>
            {editais.length === 0 ? (
              <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">Envie o PDF do edital, seus anexos e avisos de rerratificação.</p>
            ) : (
              <ul className="space-y-1.5">{editais.map(renderDoc)}</ul>
            )}
          </section>

          <section>
            <header className="mb-2 flex items-center justify-between">
              <h2 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <FileText className="size-3.5" /> Apoio
              </h2>
              <Button variant="ghost" size="icon-sm" aria-label="Enviar documento de apoio" onClick={() => setUpload({ open: true, type: 'apoio' })}>
                <Plus className="size-4" />
              </Button>
            </header>
            {apoio.length === 0 ? (
              <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">Sua proposta, plano de trabalho ou documentos da empresa — para perguntar sobre eles ou revisá-los à luz do edital.</p>
            ) : (
              <ul className="space-y-1.5">{apoio.map(renderDoc)}</ul>
            )}
          </section>

          <section>
            <header className="mb-2 flex items-center justify-between">
              <h2 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <MessageSquare className="size-3.5" /> Conversas
              </h2>
              <Button variant="ghost" size="icon-sm" aria-label="Nova conversa" onClick={() => onSelectConversation(null)}>
                <Plus className="size-4" />
              </Button>
            </header>
            <ul className="space-y-1">
              {conversations.data?.map((c) => (
                <li key={c.id} className={`group flex items-center gap-1 rounded-md px-2 py-1 text-sm ${c.id === conversationId ? 'bg-accent' : 'hover:bg-accent/50'}`}>
                  <button type="button" className="min-w-0 flex-1 truncate text-left" onClick={() => onSelectConversation(c.id)} title={c.title ?? ''}>
                    {c.title ?? 'Conversa'}
                    <span className="block text-[11px] text-muted-foreground">{c.mode === 'full_context' ? 'baseline · ' : ''}{formatDate(c.updatedAt)}</span>
                  </button>
                  <button type="button" className="rounded p-1 opacity-0 hover:bg-background group-hover:opacity-100" aria-label="Apagar conversa" onClick={() => removeConv.mutate(c.id)}>
                    <Trash2 className="size-3.5" />
                  </button>
                </li>
              ))}
              {conversations.data?.length === 0 && <li className="px-2 text-xs text-muted-foreground">Nenhuma conversa ainda.</li>}
            </ul>
          </section>
        </div>
      </ScrollArea>
      <UploadDocumentDialog workspaceId={workspaceId} documents={documents} open={upload.open} initialDocType={upload.type} onOpenChange={(open) => setUpload((u) => ({ ...u, open }))} />
    </div>
  );
}
