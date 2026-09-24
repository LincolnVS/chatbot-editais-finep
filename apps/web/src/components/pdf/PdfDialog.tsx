import { useState } from 'react';
import { Link } from 'react-router';
import { ExternalLink } from 'lucide-react';
import type { BBox } from '@editais/shared';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { PdfViewer } from '@/components/pdf/PdfViewer';
import { documentFileUrl } from '@/lib/api';

/** O que abrir no visor: o documento na página pedida, com os trechos destacados (citação) ou sem destaque (abrir arquivo). */
export type PdfTarget = {
  documentId: string;
  title: string;
  page: number;
  highlights: BBox[];
  /** Onde a citação aponta ("item 4.5 · p. 4") e a sentença citada, quando veio de uma citação. */
  where?: string;
  quote?: string;
  /** Rótulo do trecho, para o link "trechos e processamento" abrir já nele. */
  label?: string;
};

type Props = { target: PdfTarget | null; workspaceId: string; conversationId: string | null; onClose: () => void };

/** PDF por cima do chat: citações abrem na página citada com o trecho marcado; "abrir arquivo" abre na primeira página. */
export function PdfDialog({ target, workspaceId, conversationId, onClose }: Props) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="flex h-[92vh] flex-col gap-2 p-3 sm:max-w-[min(1100px,calc(100%-2rem))]">
        {target && <PdfDialogBody key={`${target.documentId}:${target.page}:${target.label ?? ''}`} target={target} workspaceId={workspaceId} conversationId={conversationId} />}
      </DialogContent>
    </Dialog>
  );
}

function PdfDialogBody({ target, workspaceId, conversationId }: { target: PdfTarget; workspaceId: string; conversationId: string | null }) {
  const [page, setPage] = useState(target.page);
  const detail = new URLSearchParams({ page: String(target.page), ...(target.label ? { label: target.label } : {}), ...(conversationId ? { c: conversationId } : {}) });
  return (
    <>
      <DialogHeader className="pr-8 text-left">
        <DialogTitle className="truncate text-sm">{target.title}</DialogTitle>
        <DialogDescription className="flex flex-wrap items-center gap-x-2 text-xs">
          {target.where ? <span>{target.where}</span> : <span>p. {page}</span>}
          <Link to={`/w/${workspaceId}/doc/${target.documentId}?${detail.toString()}`} className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-foreground">
            <ExternalLink className="size-3" /> trechos e processamento
          </Link>
        </DialogDescription>
        {target.quote && <p className="line-clamp-2 rounded bg-yellow-400/20 px-2 py-1 text-xs text-foreground">“{target.quote}”</p>}
      </DialogHeader>
      <div className="min-h-0 flex-1 rounded-md border">
        <PdfViewer url={documentFileUrl(target.documentId)} page={page} onPageChange={setPage} highlights={target.highlights} />
      </div>
    </>
  );
}
