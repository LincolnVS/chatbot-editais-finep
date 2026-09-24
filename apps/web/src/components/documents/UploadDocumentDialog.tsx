import { useState, type SubmitEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { DocKind, DocumentSummary } from '@editais/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { ApiError, uploadDocument } from '@/lib/api';
import { AMENDING_KINDS, APOIO_KINDS, DOC_KIND_LABELS, EDITAL_KINDS } from '@/lib/format';

type Props = {
  workspaceId: string;
  documents: DocumentSummary[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Tipo inicial (aba de onde o usuário clicou). */
  initialDocType?: 'edital' | 'apoio';
};

/** Envio de um PDF: tipo (edital/apoio), espécie, título, e — para retificações — qual documento ele altera. */
export function UploadDocumentDialog({ open, onOpenChange, ...rest }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {/* remontado a cada abertura: o formulário sempre começa limpo */}
        {open && <UploadForm key={rest.initialDocType ?? 'edital'} {...rest} onOpenChange={onOpenChange} />}
      </DialogContent>
    </Dialog>
  );
}

function UploadForm({ workspaceId, documents, onOpenChange, initialDocType = 'edital' }: Omit<Props, 'open'>) {
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [docType, setDocType] = useState<'edital' | 'apoio'>(initialDocType);
  const [docKind, setDocKind] = useState<DocKind>(initialDocType === 'edital' ? 'edital_principal' : 'apoio_proposta');
  const [title, setTitle] = useState('');
  const [versionLabel, setVersionLabel] = useState('');
  const [amends, setAmends] = useState('');

  const kinds = docType === 'edital' ? EDITAL_KINDS : APOIO_KINDS;
  const amending = AMENDING_KINDS.includes(docKind);
  const editalDocs = documents.filter((d) => d.docType === 'edital' && d.docKind !== 'aviso_rerratificacao');

  const upload = useMutation({
    mutationFn: () => uploadDocument(workspaceId, file!, {
      docType,
      docKind,
      title: title.trim() || undefined,
      versionLabel: versionLabel.trim() || undefined,
      amendsDocumentId: amending && amends ? amends : undefined,
    }),
    onSuccess: ({ document }) => {
      void qc.invalidateQueries({ queryKey: ['workspace', workspaceId] });
      toast.success(`"${document.title}" enviado; processando…`);
      onOpenChange(false);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) toast.error('Este PDF já existe neste workspace.');
      else toast.error(err.message);
    },
  });

  function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    if (file) upload.mutate();
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Enviar PDF</DialogTitle>
            <DialogDescription>
              Documentos do edital são a fonte das respostas. Documentos de apoio (sua proposta, seus documentos) servem para perguntas sobre eles e para revisar textos.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-2">
            <Label htmlFor="up-file">Arquivo PDF</Label>
            <Input id="up-file" type="file" accept="application/pdf,.pdf" onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              setFile(f);
              if (f && !title) setTitle(f.name.replace(/\.pdf$/i, ''));
            }} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="up-type">Tipo</Label>
              <NativeSelect id="up-type" value={docType} onChange={(e) => {
                const t = e.target.value as 'edital' | 'apoio';
                setDocType(t);
                setDocKind(t === 'edital' ? 'edital_principal' : 'apoio_proposta');
              }}>
                <NativeSelectOption value="edital">Documento do edital</NativeSelectOption>
                <NativeSelectOption value="apoio">Documento de apoio</NativeSelectOption>
              </NativeSelect>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="up-kind">Espécie</Label>
              <NativeSelect id="up-kind" value={docKind} onChange={(e) => setDocKind(e.target.value as DocKind)}>
                {kinds.map((k) => <NativeSelectOption key={k} value={k}>{DOC_KIND_LABELS[k]}</NativeSelectOption>)}
              </NativeSelect>
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="up-title">Título</Label>
            <Input id="up-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="ex.: Edital MIB R2 — Subvenção Regional" />
          </div>

          {amending && (
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label htmlFor="up-amends">Altera qual documento?</Label>
                <NativeSelect id="up-amends" value={amends} onChange={(e) => setAmends(e.target.value)}>
                  <NativeSelectOption value="">— (nenhum)</NativeSelectOption>
                  {editalDocs.map((d) => <NativeSelectOption key={d.id} value={d.id}>{d.title}</NativeSelectOption>)}
                </NativeSelect>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="up-version">Versão / data</Label>
                <Input id="up-version" value={versionLabel} onChange={(e) => setVersionLabel(e.target.value)} placeholder="ex.: rerratificação 1" />
              </div>
            </div>
          )}
          {amending && (
            <p className="text-xs text-muted-foreground">
              Retificações têm precedência sobre o documento original: nas respostas, o trecho retificado aparece primeiro e o modelo é instruído a preferi-lo.
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
            <Button type="submit" disabled={!file || upload.isPending}>{upload.isPending ? 'Enviando…' : 'Enviar'}</Button>
          </DialogFooter>
    </form>
  );
}
