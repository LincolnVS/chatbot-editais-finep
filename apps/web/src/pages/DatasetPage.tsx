/** Tela Dataset: o padrão-ouro como matriz — uma linha por pergunta, uma coluna por edital, célula = gabarito daquele edital. */
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import type { EvalQuestion, Workspace } from '@editais/shared';
import { FileText, Loader2, Plus, RotateCcw, Save, SquarePen } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { getEvalDataset, getWorkspace, listWorkspaces, saveEvalDataset } from '@/lib/api';
import { cn } from '@/lib/utils';

/** Prefixo antes do "-" no id (q03-reg → q03) agrupa a mesma pergunta em todos os editais. */
function groupKey(id: string): string {
  return id.split('-')[0] ?? id;
}

/** Sufixo curto do edital para compor ids novos (MIB-R2-TECDIG → mibr). */
function suffixOf(ws: Workspace, taken: Set<string>): string {
  const base = (ws.callCode ?? ws.name).toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '').slice(0, 4) || 'ed';
  let suffix = base;
  let n = 2;
  while (taken.has(suffix)) {
    suffix = `${base}${n}`;
    n++;
  }
  return suffix;
}

type Row = { key: string; question: string; topic?: string; nivel: EvalQuestion['nivel']; byWorkspace: Map<string, EvalQuestion> };
type Editing = { id: string } | { row: string } | 'nova' | null;

export function DatasetPage() {
  const qc = useQueryClient();
  const dataset = useQuery({ queryKey: ['eval-dataset'], queryFn: () => getEvalDataset() });
  const workspaces = useQuery({ queryKey: ['workspaces'], queryFn: listWorkspaces });
  const [edits, setEdits] = useState<EvalQuestion[] | null>(null);
  const [base, setBase] = useState<EvalQuestion[] | null>(null);
  const [topic, setTopic] = useState('');
  const [nivel, setNivel] = useState('');
  const [editing, setEditing] = useState<Editing>(null);

  // Chegou (ou recarregou) o arquivo: o rascunho passa a ser o conteúdo dele.
  if (dataset.data && dataset.data.questions !== base) {
    setBase(dataset.data.questions);
    setEdits(dataset.data.questions);
  }

  const save = useMutation({
    mutationFn: (questions: EvalQuestion[]) => saveEvalDataset({ file: dataset.data?.file, questions }),
    onSuccess: (data) => {
      qc.setQueryData(['eval-dataset'], data);
      toast.success(`Padrão-ouro salvo em eval/${data.file}`);
    },
    onError: (err) => toast.error(err.message),
  });

  const questions = useMemo(() => edits ?? [], [edits]);
  const dirty = edits !== null && dataset.data !== undefined && JSON.stringify(edits) !== JSON.stringify(dataset.data.questions);
  const all = useMemo(() => workspaces.data ?? [], [workspaces.data]);

  /** Colunas: os editais presentes no dataset, na ordem em que aparecem. */
  const columns = useMemo(() => {
    const keys: string[] = [];
    for (const q of questions) if (q.workspace && !keys.includes(q.workspace)) keys.push(q.workspace);
    return keys.map((key) => ({ key, ws: all.find((w) => [w.id, w.name, w.callCode ?? ''].includes(key)) }));
  }, [questions, all]);

  const details = useQueries({
    queries: columns.map((c) => ({ queryKey: ['workspace', c.ws?.id ?? ''], queryFn: () => getWorkspace(c.ws?.id ?? ''), enabled: !!c.ws })),
  });

  const rows = useMemo(() => {
    const map = new Map<string, Row>();
    for (const q of questions) {
      const key = groupKey(q.id);
      const row = map.get(key) ?? { key, question: q.question, topic: q.topic, nivel: q.nivel, byWorkspace: new Map<string, EvalQuestion>() };
      row.byWorkspace.set(q.workspace ?? '', q);
      map.set(key, row);
    }
    return [...map.values()];
  }, [questions]);

  const topics = [...new Set(questions.map((q) => q.topic).filter(Boolean))] as string[];
  const visible = rows.filter((r) => (!topic || r.topic === topic) && (!nivel || r.nivel === nivel));
  const semResposta = questions.filter((q) => !q.answerable).length;

  function updateCell(id: string, patch: Partial<EvalQuestion>): void {
    setEdits((prev) => (prev ?? []).map((q) => (q.id === id ? { ...q, ...patch } : q)));
  }

  function updateRow(key: string, patch: Partial<EvalQuestion>): void {
    setEdits((prev) => (prev ?? []).map((q) => (groupKey(q.id) === key ? { ...q, ...patch } : q)));
  }

  /** Nova coluna: replica todas as perguntas para o edital escolhido, sem gabarito (a anotar). */
  function addWorkspace(id: string): void {
    const ws = all.find((w) => w.id === id);
    if (!ws) return;
    const key = ws.callCode ?? ws.name;
    if (columns.some((c) => c.key === key)) return;
    const suffix = suffixOf(ws, new Set(questions.map((q) => q.id.split('-')[1] ?? '')));
    const novas: EvalQuestion[] = rows.map((r) => ({
      id: `${r.key}-${suffix}`,
      workspace: key,
      question: r.question,
      ...(r.topic ? { topic: r.topic } : {}),
      ...(r.nivel ? { nivel: r.nivel } : {}),
      expectedValues: [],
      answerable: true,
    }));
    setEdits([...questions, ...novas]);
    toast.info(`${novas.length} linhas criadas para ${ws.name} — falta anotar o gabarito de cada uma.`);
  }

  /** Nova pergunta: uma linha em cada edital do dataset. */
  function addQuestion(nova: { key: string; question: string; topic: string; nivel: EvalQuestion['nivel'] }): void {
    const key = groupKey(nova.key);
    if (rows.some((r) => r.key === key)) {
      toast.error(`Já existe uma pergunta ${key}.`);
      return;
    }
    if (key !== nova.key) {
      toast.error('O id não pode conter "-": o sufixo identifica o edital (ex.: q16 vira q16-reg, q16-tec…).');
      return;
    }
    const novas: EvalQuestion[] = columns.map((c) => ({
      id: `${nova.key}-${questions.find((q) => q.workspace === c.key)?.id.split('-')[1] ?? 'ed'}`,
      workspace: c.key,
      question: nova.question,
      ...(nova.topic ? { topic: nova.topic } : {}),
      ...(nova.nivel ? { nivel: nova.nivel } : {}),
      expectedValues: [],
      answerable: true,
    }));
    setEdits([...questions, ...novas]);
    setEditing(null);
  }

  const cellEditing = editing && typeof editing === 'object' && 'id' in editing ? questions.find((q) => q.id === editing.id) : undefined;
  const rowEditing = editing && typeof editing === 'object' && 'row' in editing ? rows.find((r) => r.key === editing.row) : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b px-6 py-3">
        <div className="mr-auto">
          <h1 className="text-lg font-semibold">Dataset</h1>
          <p className="text-xs text-muted-foreground">
            Padrão-ouro da avaliação: a mesma pergunta em cada edital. A célula é o gabarito — item, valores obrigatórios e resposta de referência.
          </p>
        </div>
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Badge variant="secondary" className="font-normal">{rows.length} perguntas</Badge>
          <Badge variant="secondary" className="font-normal">{columns.length} editais</Badge>
          <Badge variant="secondary" className="font-normal">{questions.length} casos</Badge>
          <Badge variant="secondary" className="font-normal">{semResposta} de abstenção</Badge>
        </div>
        <NativeSelect aria-label="tema" size="sm" value={topic} onChange={(e) => setTopic(e.target.value)} className="w-auto">
          <NativeSelectOption value="">Todos os temas</NativeSelectOption>
          {topics.map((t) => (
            <NativeSelectOption key={t} value={t}>{t}</NativeSelectOption>
          ))}
        </NativeSelect>
        <NativeSelect aria-label="nível" size="sm" value={nivel} onChange={(e) => setNivel(e.target.value)} className="w-auto">
          <NativeSelectOption value="">Diretas e compostas</NativeSelectOption>
          <NativeSelectOption value="direta">Só diretas</NativeSelectOption>
          <NativeSelectOption value="composta">Só compostas</NativeSelectOption>
        </NativeSelect>
        <Button variant="outline" size="sm" onClick={() => setEditing('nova')}>
          <Plus className="size-4" /> Pergunta
        </Button>
        <Button variant="outline" size="sm" disabled={!dirty} onClick={() => setEdits(dataset.data?.questions ?? [])}>
          <RotateCcw className="size-4" /> Descartar
        </Button>
        <Button size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate(questions)}>
          {save.isPending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Salvar
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        {dataset.isLoading && <p className="p-6 text-sm text-muted-foreground">Carregando…</p>}
        {dataset.isError && <p className="p-6 text-sm text-destructive">{dataset.error.message}</p>}
        {dataset.isSuccess && (
          <table className="w-full border-separate border-spacing-0 text-xs">
            <thead className="sticky top-0 z-20">
              <tr>
                <th className="sticky left-0 z-30 w-72 border-b border-r bg-muted p-2 text-left align-bottom font-medium">pergunta</th>
                {columns.map((c, i) => {
                  const docs = details[i]?.data?.documents ?? [];
                  const edital = docs.find((d) => d.docType === 'edital');
                  return (
                    <th key={c.key} className="min-w-80 border-b border-r bg-muted p-2 text-left align-bottom font-medium">
                      <span className="block">{c.ws?.name ?? c.key}</span>
                      <span className="block font-normal text-muted-foreground">
                        {docs.length > 0 ? `${docs.length} documento(s) · ` : ''}
                        {c.ws && edital && (
                          <Link to={`/w/${c.ws.id}/doc/${edital.id}`} className="text-primary hover:underline">
                            <FileText className="mr-0.5 inline size-3" />abrir
                          </Link>
                        )}
                      </span>
                    </th>
                  );
                })}
                <th className="border-b bg-muted p-2 align-bottom">
                  <AddWorkspace workspaces={all.filter((w) => !columns.some((c) => [w.id, w.name, w.callCode ?? ''].includes(c.key)))} onAdd={addWorkspace} />
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr key={row.key} className="align-top">
                  <th className="sticky left-0 z-10 border-b border-r bg-background p-2 text-left font-normal">
                    <span className="flex items-center gap-1">
                      <span className="font-mono text-muted-foreground">{row.key}</span>
                      {row.topic && <Badge variant="secondary" className="font-normal">{row.topic}</Badge>}
                      {row.nivel && <Badge variant={row.nivel === 'composta' ? 'default' : 'outline'} className="font-normal">{row.nivel}</Badge>}
                      <Button variant="ghost" size="icon-xs" aria-label={`editar pergunta ${row.key}`} onClick={() => setEditing({ row: row.key })}>
                        <SquarePen className="size-3.5" />
                      </Button>
                    </span>
                    <span className="mt-1 block font-medium">{row.question}</span>
                  </th>
                  {columns.map((c) => {
                    const q = row.byWorkspace.get(c.key);
                    return (
                      <td key={c.key} className="border-b border-r p-0">
                        {q ? <Cell q={q} onEdit={() => setEditing({ id: q.id })} /> : <span className="block p-2 text-muted-foreground">—</span>}
                      </td>
                    );
                  })}
                  <td className="border-b" />
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {dataset.isSuccess && visible.length === 0 && <p className="p-6 text-sm text-muted-foreground">Nenhuma pergunta com esse filtro.</p>}
      </div>

      {cellEditing && (
        <CellDialog
          q={cellEditing}
          workspace={columns.find((c) => c.key === cellEditing.workspace)?.ws}
          onChange={(patch) => updateCell(cellEditing.id, patch)}
          onClose={() => setEditing(null)}
        />
      )}
      {rowEditing && <RowDialog row={rowEditing} onChange={(patch) => updateRow(rowEditing.key, patch)} onClose={() => setEditing(null)} />}
      {editing === 'nova' && (
        <NewQuestionDialog topics={topics} nextKey={`q${String(rows.length + 1).padStart(2, '0')}`} onCreate={addQuestion} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

/**
 * Campo dos valores obrigatórios. O texto fica cru enquanto se digita (o separador "|" e os espaços
 * sobrevivem) e só vira lista ao sair do campo.
 */
function ValuesInput({ values, onCommit }: { values: string[]; onCommit: (values: string[]) => void }): React.ReactElement {
  const [draft, setDraft] = useState(values.join('|'));
  // O rascunho guarda o texto cru (o "|" e os espaços que ainda estão sendo digitados) e a lista é gravada
  // a cada tecla, para nada se perder ao fechar o diálogo. Só ressincroniza quando o valor muda por fora.
  if (parseValues(draft).join('|') !== values.join('|')) setDraft(values.join('|'));
  return (
    <Input
      id="valores"
      value={draft}
      placeholder="ex.: R$ 5.000.000,00|09/04/2026"
      className="h-8 font-mono text-xs"
      onChange={(e) => {
        setDraft(e.target.value);
        onCommit(parseValues(e.target.value));
      }}
    />
  );
}

/** Texto do campo → lista de valores obrigatórios. */
function parseValues(text: string): string[] {
  return text.split('|').map((v) => v.trim()).filter(Boolean);
}

function Cell({ q, onEdit }: { q: EvalQuestion; onEdit: () => void }) {
  const vazio = q.answerable && q.expectedValues.length === 0;
  return (
    <button type="button" onClick={onEdit} className="group flex w-full flex-col gap-1 p-2 text-left hover:bg-accent/50" aria-label={`editar gabarito ${q.id}`}>
      <span className="flex items-center gap-1">
        {q.answerable ? (
          <Badge variant="outline" className="font-mono font-normal">{q.expectedItem || 'sem item'}</Badge>
        ) : (
          <Badge variant="destructive" className="font-normal">deve abster-se</Badge>
        )}
        <span className={cn('truncate font-mono', vazio ? 'text-amber-600' : 'text-muted-foreground')}>
          {q.expectedValues.join(' · ') || (q.answerable ? 'sem valores obrigatórios' : '')}
        </span>
        <SquarePen className="ml-auto size-3.5 shrink-0 opacity-0 group-hover:opacity-100" />
      </span>
      <span className="line-clamp-3 text-muted-foreground">{q.expectedAnswer || 'sem resposta de referência'}</span>
    </button>
  );
}

function CellDialog({ q, workspace, onChange, onClose }: { q: EvalQuestion; workspace?: Workspace; onChange: (patch: Partial<EvalQuestion>) => void; onClose: () => void }) {
  const detail = useQuery({ queryKey: ['workspace', workspace?.id ?? ''], queryFn: () => getWorkspace(workspace?.id ?? ''), enabled: !!workspace });
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{workspace?.name ?? q.workspace} · {q.id}</DialogTitle>
          <DialogDescription>{q.question}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={q.answerable} onChange={(e) => onChange({ answerable: e.target.checked })} />
            {q.answerable ? 'tem resposta neste edital' : 'não tem resposta neste edital (o certo é abster-se)'}
          </label>
          <div className="grid gap-3 sm:grid-cols-[140px_minmax(0,1fr)]">
            <div className="grid gap-1">
              <Label htmlFor="item" className="text-xs">Item esperado</Label>
              <Input id="item" value={q.expectedItem ?? ''} placeholder="ex.: 8.1" className="h-8" onChange={(e) => onChange({ expectedItem: e.target.value || undefined })} />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="valores" className="text-xs">Valores obrigatórios <span className="text-muted-foreground">(separados por | )</span></Label>
              <ValuesInput values={q.expectedValues} onCommit={(expectedValues) => onChange({ expectedValues })} />
            </div>
          </div>
          <div className="grid gap-1">
            <Label htmlFor="resposta" className="text-xs">Resposta de referência</Label>
            <Textarea id="resposta" value={q.expectedAnswer ?? ''} rows={10} className="text-xs" onChange={(e) => onChange({ expectedAnswer: e.target.value || undefined })} />
          </div>
          {detail.data && (
            <p className="flex flex-wrap gap-2 text-xs text-muted-foreground">
              documentos:
              {detail.data.documents.map((d) => (
                <Link key={d.id} to={`/w/${detail.data.id}/doc/${d.id}`} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                  <FileText className="mr-0.5 inline size-3" />{d.title}
                </Link>
              ))}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button onClick={onClose}>Fechar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RowDialog({ row, onChange, onClose }: { row: Row; onChange: (patch: Partial<EvalQuestion>) => void; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pergunta {row.key}</DialogTitle>
          <DialogDescription>Vale para todos os editais do dataset.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1">
            <Label htmlFor="pergunta" className="text-xs">Texto da pergunta</Label>
            <Textarea id="pergunta" value={row.question} rows={3} onChange={(e) => onChange({ question: e.target.value })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1">
              <Label htmlFor="tema" className="text-xs">Tema</Label>
              <Input id="tema" value={row.topic ?? ''} className="h-8" onChange={(e) => onChange({ topic: e.target.value || undefined })} />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="nivel" className="text-xs">Nível</Label>
              <NativeSelect id="nivel" value={row.nivel ?? ''} onChange={(e) => onChange({ nivel: (e.target.value || undefined) as EvalQuestion['nivel'] })}>
                <NativeSelectOption value="">—</NativeSelectOption>
                <NativeSelectOption value="direta">direta (resposta num item só)</NativeSelectOption>
                <NativeSelectOption value="composta">composta (espalhada em vários itens)</NativeSelectOption>
              </NativeSelect>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>Fechar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NewQuestionDialog({
  topics,
  nextKey,
  onCreate,
  onClose,
}: {
  topics: string[];
  nextKey: string;
  onCreate: (q: { key: string; question: string; topic: string; nivel: EvalQuestion['nivel'] }) => void;
  onClose: () => void;
}) {
  const [key, setKey] = useState(nextKey);
  const [question, setQuestion] = useState('');
  const [topic, setTopic] = useState(topics[0] ?? '');
  const [nivel, setNivel] = useState<EvalQuestion['nivel']>('direta');
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nova pergunta</DialogTitle>
          <DialogDescription>Cria uma linha em cada edital do dataset; o gabarito de cada célula fica em branco.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid grid-cols-[100px_minmax(0,1fr)] gap-3">
            <div className="grid gap-1">
              <Label htmlFor="nova-id" className="text-xs">Id</Label>
              <Input id="nova-id" value={key} className="h-8 font-mono" onChange={(e) => setKey(e.target.value.trim())} />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="nova-tema" className="text-xs">Tema</Label>
              <Input id="nova-tema" value={topic} className="h-8" list="temas" onChange={(e) => setTopic(e.target.value)} />
              <datalist id="temas">{topics.map((t) => <option key={t} value={t} />)}</datalist>
            </div>
          </div>
          <div className="grid gap-1">
            <Label htmlFor="nova-pergunta" className="text-xs">Pergunta</Label>
            <Textarea id="nova-pergunta" value={question} rows={3} onChange={(e) => setQuestion(e.target.value)} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="nova-nivel" className="text-xs">Nível</Label>
            <NativeSelect id="nova-nivel" value={nivel} onChange={(e) => setNivel(e.target.value as EvalQuestion['nivel'])}>
              <NativeSelectOption value="direta">direta (resposta num item só)</NativeSelectOption>
              <NativeSelectOption value="composta">composta (espalhada em vários itens)</NativeSelectOption>
            </NativeSelect>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button disabled={!key || !question.trim()} onClick={() => onCreate({ key, question: question.trim(), topic, nivel })}>Criar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddWorkspace({ workspaces, onAdd }: { workspaces: Workspace[]; onAdd: (id: string) => void }) {
  if (workspaces.length === 0) return <span className="text-xs font-normal text-muted-foreground">todos os editais já estão no dataset</span>;
  return (
    <NativeSelect aria-label="adicionar edital" size="sm" value="" onChange={(e) => e.target.value && onAdd(e.target.value)} className="w-auto">
      <NativeSelectOption value="">+ edital…</NativeSelectOption>
      {workspaces.map((w) => (
        <NativeSelectOption key={w.id} value={w.id}>{w.name}</NativeSelectOption>
      ))}
    </NativeSelect>
  );
}
