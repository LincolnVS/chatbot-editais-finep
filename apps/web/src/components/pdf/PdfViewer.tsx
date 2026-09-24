import { useEffect, useRef, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import type { BBox } from '@editais/shared';
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();

type Props = {
  url: string;
  page: number;
  onPageChange: (page: number) => void;
  /** Caixas (normalizadas 0..1, origem superior-esquerda) a destacar na página atual. */
  highlights: BBox[];
};

/** Visor de uma página do PDF com destaque dos bboxes do trecho citado. */
export function PdfViewer({ url, page, onPageChange, highlights }: Props) {
  const [numPages, setNumPages] = useState(0);
  const [scale, setScale] = useState(1);
  const [pageInput, setPageInput] = useState(String(page));
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  // página mudou por fora (nova citação): sincroniza o campo durante o render, sem efeito
  const [prevPage, setPrevPage] = useState(page);
  if (prevPage !== page) {
    setPrevPage(page);
    setPageInput(String(page));
  }

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0) setContainerWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const go = (p: number) => {
    if (numPages === 0) return;
    onPageChange(Math.min(Math.max(1, p), numPages));
  };

  const width = containerWidth > 0 ? Math.min(containerWidth - 24, 1000) * scale : undefined;
  const pageHighlights = highlights.filter((b) => b.page === page);

  const pager = (
    <>
      <Button variant="ghost" size="icon-sm" onClick={() => go(page - 1)} disabled={page <= 1} aria-label="Página anterior"><ChevronLeft className="size-4" /></Button>
      <form
        className="flex items-center gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          go(Number(pageInput) || page);
        }}
      >
        <Input className="h-7 w-14 text-center" value={pageInput} onChange={(e) => setPageInput(e.target.value)} aria-label="Página" />
        <span className="text-muted-foreground">/ {numPages || '…'}</span>
      </form>
      <Button variant="ghost" size="icon-sm" onClick={() => go(page + 1)} disabled={numPages === 0 || page >= numPages} aria-label="Próxima página"><ChevronRight className="size-4" /></Button>
    </>
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b px-2 py-1.5 text-sm">
        {pager}
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" onClick={() => setScale((s) => Math.max(0.5, s - 0.2))} aria-label="Diminuir"><ZoomOut className="size-4" /></Button>
          <span className="w-10 text-center text-xs tabular-nums">{Math.round(scale * 100)}%</span>
          <Button variant="ghost" size="icon-sm" onClick={() => setScale((s) => Math.min(3, s + 0.2))} aria-label="Aumentar"><ZoomIn className="size-4" /></Button>
        </div>
      </div>
      <div ref={containerRef} className="min-h-0 flex-1 overflow-auto bg-muted/40 p-3">
        <Document
          file={url}
          onLoadSuccess={(doc) => setNumPages(doc.numPages)}
          loading={<p className="text-sm text-muted-foreground">Carregando PDF…</p>}
          error={<p className="text-sm text-destructive">Não foi possível abrir o PDF.</p>}
        >
          <div className="relative mx-auto w-fit shadow">
            <Page
              pageNumber={page}
              width={width}
              renderAnnotationLayer={false}
              renderTextLayer
              onRenderSuccess={(p) => setSize({ w: p.width, h: p.height })}
            />
            {size && pageHighlights.map((b, i) => (
              <div
                key={i}
                className="pointer-events-none absolute rounded-sm bg-yellow-400/35 ring-1 ring-yellow-500/70"
                style={{ left: b.x0 * size.w, top: b.y0 * size.h, width: (b.x1 - b.x0) * size.w, height: (b.y1 - b.y0) * size.h }}
              />
            ))}
          </div>
        </Document>
      </div>
      <div className="flex items-center justify-center gap-1 border-t px-2 py-1.5 text-sm">{pager}</div>
    </div>
  );
}
