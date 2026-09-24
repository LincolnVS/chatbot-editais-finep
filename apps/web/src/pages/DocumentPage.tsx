import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft } from 'lucide-react';
import type { StoredChunk } from '@editais/shared';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PdfViewer } from '@/components/pdf/PdfViewer';
import { documentFileUrl, getDocument, getDocumentChunks } from '@/lib/api';
import { DOC_KIND_LABELS, formatBytes, formatDate, formatMs } from '@/lib/format';
import { cn } from '@/lib/utils';

/** T2 — PDF na página citada (?page=N&label=c_xxxxxx) com o trecho destacado; lista de trechos ao lado. */
export function DocumentPage() {
  const { workspaceId = '', documentId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get('page')) || 1);
  const label = params.get('label');
  const conversation = params.get('c');
  const [filter, setFilter] = useState('');

  const doc = useQuery({ queryKey: ['document', documentId], queryFn: () => getDocument(documentId) });
  const chunks = useQuery({ queryKey: ['chunks', documentId, doc.data?.indexedAt], queryFn: () => getDocumentChunks(documentId), enabled: doc.data?.status === 'ready' });

  const selected = useMemo(() => chunks.data?.chunks.find((c) => c.label === label) ?? null, [chunks.data, label]);

  // rola a lista até o trecho selecionado
  useEffect(() => {
    if (label) document.getElementById(`chunk-${label}`)?.scrollIntoView({ block: 'center' });
  }, [label, chunks.data]);

  const setPage = (p: number) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    next.set('page', String(p));
    return next;
  }, { replace: true });

  const selectChunk = (c: StoredChunk) => setParams({ page: String(c.pageStart), label: c.label, ...(conversation ? { c: conversation } : {}) }, { replace: true });

  const visible = useMemo(() => {
    const all = chunks.data?.chunks ?? [];
    const q = filter.trim().toLowerCase();
    return q ? all.filter((c) => `${c.itemNumber ?? ''} ${c.heading ?? ''} ${c.sectionPath} ${c.text}`.toLowerCase().includes(q)) : all;
  }, [chunks.data, filter]);

  if (doc.isLoading) return <div className="p-6"><Skeleton className="h-8 w-64" /></div>;
  if (doc.error || !doc.data) return <p className="p-6 text-sm text-destructive">Documento não encontrado.</p>;
  const d = doc.data;

  return (
    <div className="grid h-full grid-cols-[minmax(0,1fr)_400px]">
      <section className="flex min-h-0 flex-col">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Link to={`/w/${workspaceId}${conversation ? `?c=${conversation}` : ''}`} className="rounded p-1 hover:bg-accent" aria-label="Voltar à conversa"><ChevronLeft className="size-4" /></Link>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold">{d.title}</h1>
            <p className="truncate text-xs text-muted-foreground">
              {DOC_KIND_LABELS[d.docKind]} · {d.filename} · {formatBytes(d.sizeBytes)}{d.pageCount ? ` · ${d.pageCount} páginas` : ''}
            </p>
          </div>
        </div>
        <div className="min-h-0 flex-1">
          <PdfViewer url={documentFileUrl(d.id)} page={page} onPageChange={setPage} highlights={selected?.bboxes ?? []} />
        </div>
      </section>

      <aside className="min-h-0 border-l">
        <Tabs defaultValue="chunks" className="flex h-full flex-col gap-0">
          <TabsList className="m-2 grid grid-cols-2">
            <TabsTrigger value="chunks">Trechos {chunks.data ? `(${chunks.data.count})` : ''}</TabsTrigger>
            <TabsTrigger value="info">Processamento</TabsTrigger>
          </TabsList>

          <TabsContent value="chunks" className="flex min-h-0 flex-1 flex-col">
            <div className="px-2 pb-2">
              <Input placeholder="filtrar por item, título ou texto…" value={filter} onChange={(e) => setFilter(e.target.value)} className="h-8" />
            </div>
            <ScrollArea className="min-h-0 flex-1">
              <ul className="space-y-1 px-2 pb-4">
                {d.status !== 'ready' && <li className="text-xs text-muted-foreground">Documento ainda não indexado ({d.status}).</li>}
                {visible.map((c) => (
                  <li key={c.label} id={`chunk-${c.label}`}>
                    <button
                      type="button"
                      onClick={() => selectChunk(c)}
                      className={cn('w-full rounded-md border px-2 py-1.5 text-left text-xs hover:bg-accent/50', c.label === label && 'border-primary bg-primary/5')}
                    >
                      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                        <span className="font-mono">{c.label}</span>
                        <Badge variant="outline" className="h-4 px-1 text-[10px]">{c.kind}</Badge>
                        <span>p. {c.pageStart}{c.pageEnd !== c.pageStart ? `–${c.pageEnd}` : ''}</span>
                        {!c.embed && <span title="não embedado (pai grande); disponível via BM25 e expansão">só BM25</span>}
                      </div>
                      <div className="mt-0.5 line-clamp-1 font-medium">{c.itemNumber ? `${c.itemNumber} ` : ''}{c.heading ?? c.sectionPath}</div>
                      <div className="line-clamp-3 text-muted-foreground">{c.text}</div>
                    </button>
                  </li>
                ))}
              </ul>
            </ScrollArea>
          </TabsContent>

          <TabsContent value="info" className="min-h-0 flex-1">
            <ScrollArea className="h-full">
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 p-3 text-xs">
                <dt className="text-muted-foreground">Status</dt><dd>{d.status}{d.error ? ` — ${d.error}` : ''}</dd>
                <dt className="text-muted-foreground">Parser</dt><dd>{d.parserVersion ?? '—'}</dd>
                <dt className="text-muted-foreground">Precedência</dt><dd>{d.precedence}{d.amendsDocumentId ? ' (retifica outro documento)' : ''}</dd>
                <dt className="text-muted-foreground">Enviado</dt><dd>{formatDate(d.createdAt)}</dd>
                <dt className="text-muted-foreground">Indexado</dt><dd>{formatDate(d.indexedAt)}</dd>
                <dt className="text-muted-foreground">SHA-256</dt><dd className="font-mono break-all">{d.sha256}</dd>
                <dt className="text-muted-foreground">Chunk set</dt><dd className="font-mono break-all">{d.chunkSetId ?? '—'}</dd>
                {d.stats && Object.entries(d.stats).map(([k, v]) => (
                  <ObjectRow key={k} k={k} v={v} />
                ))}
                {d.job?.stageTimingsMs && Object.entries(d.job.stageTimingsMs).map(([k, v]) => (
                  <ObjectRow key={`t-${k}`} k={`tempo ${k}`} v={formatMs(v)} />
                ))}
              </dl>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </aside>
    </div>
  );
}

function ObjectRow({ k, v }: { k: string; v: string | number }) {
  return (
    <>
      <dt className="text-muted-foreground">{k}</dt>
      <dd>{String(v)}</dd>
    </>
  );
}
