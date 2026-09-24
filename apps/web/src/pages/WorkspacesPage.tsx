import { useState, type SubmitEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderPlus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { createWorkspace, deleteWorkspace, listWorkspaces } from '@/lib/api';
import { formatDate } from '@/lib/format';

/** T0 — lista de workspaces (um por edital/chamada). */
export function WorkspacesPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [callCode, setCallCode] = useState('');
  const workspaces = useQuery({ queryKey: ['workspaces'], queryFn: listWorkspaces });

  const create = useMutation({
    mutationFn: () => createWorkspace({ name: name.trim(), callCode: callCode.trim() || undefined }),
    onSuccess: (ws) => {
      void qc.invalidateQueries({ queryKey: ['workspaces'] });
      setOpen(false);
      setName('');
      setCallCode('');
      void navigate(`/w/${ws.id}`);
    },
    onError: (err) => toast.error(err.message),
  });

  const remove = useMutation({
    mutationFn: deleteWorkspace,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workspaces'] }),
    onError: (err) => toast.error(err.message),
  });

  function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    if (name.trim()) create.mutate();
  }

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Editais</h1>
          <p className="text-sm text-muted-foreground">Cada workspace reúne os documentos de uma chamada pública (edital, anexos, avisos) e seus documentos de apoio.</p>
        </div>
        <Button onClick={() => setOpen(true)}>
          <FolderPlus className="size-4" /> Novo edital
        </Button>
      </div>

      {workspaces.isLoading && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-32" />)}
        </div>
      )}
      {workspaces.error && <p className="text-sm text-destructive">Não foi possível carregar: {workspaces.error.message}. A API está rodando em :3000?</p>}

      {workspaces.data && workspaces.data.length === 0 && (
        <Card className="border-dashed">
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Nenhum edital ainda. Crie o primeiro e envie os PDFs da chamada.
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {workspaces.data?.map((ws) => (
          <Card key={ws.id} className="group relative transition-colors hover:bg-accent/40">
            <Link to={`/w/${ws.id}`} className="absolute inset-0" aria-label={ws.name} />
            <CardHeader>
              <CardTitle className="line-clamp-2 pr-8 text-base">{ws.name}</CardTitle>
              <CardDescription>
                {ws.agency}{ws.callCode ? ` · ${ws.callCode}` : ''}
              </CardDescription>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">
              {ws.documentCount ?? 0} documento(s) · atualizado {formatDate(ws.updatedAt)}
            </CardContent>
            <Button
              variant="ghost"
              size="icon-sm"
              className="absolute top-3 right-3 z-10 opacity-0 group-hover:opacity-100"
              aria-label="Apagar workspace"
              onClick={(e) => {
                e.preventDefault();
                if (confirm(`Apagar "${ws.name}" e todos os seus documentos e conversas?`)) remove.mutate(ws.id);
              }}
            >
              <Trash2 className="size-4" />
            </Button>
          </Card>
        ))}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <form onSubmit={submit} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Novo edital</DialogTitle>
              <DialogDescription>Dê um nome à chamada. Depois você envia o PDF do edital, anexos e avisos de rerratificação.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              <Label htmlFor="ws-name">Nome</Label>
              <Input id="ws-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="ex.: MIB R2 — Subvenção Econômica Regional" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ws-code">Código da chamada (opcional)</Label>
              <Input id="ws-code" value={callCode} onChange={(e) => setCallCode(e.target.value)} placeholder="ex.: 03/2025" />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancelar</Button>
              <Button type="submit" disabled={!name.trim() || create.isPending}>Criar</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
