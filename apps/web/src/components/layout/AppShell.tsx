import { useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { BarChart3, FileSearch, KeyRound, Settings2, Table2, Workflow, FlaskConical } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { getHealth } from '@/lib/api';
import { describeLlm, useLlmSettings, useLlmSettingsRequests } from '@/lib/llm-settings';
import { LlmSettingsDialog } from '@/components/settings/LlmSettingsDialog';
import { cn } from '@/lib/utils';

export function AppShell() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const llm = useLlmSettings();
  // o chat pede para abrir o diálogo do provedor ("Configurar provedor…"): pedidos ainda não atendidos abrem o diálogo
  const openRequests = useLlmSettingsRequests();
  const [handledRequests, setHandledRequests] = useState(0);
  const dialogOpen = settingsOpen || openRequests > handledRequests;
  const health = useQuery({ queryKey: ['health'], queryFn: getHealth, refetchInterval: 15_000 });

  const doclingUp = health.data?.docling ?? false;

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b px-4">
        <Link to="/" className="flex items-center gap-2 font-semibold">
          <FileSearch className="size-5" />
          <span>Editais RAG</span>
        </Link>
        <span className="text-xs text-muted-foreground">análise de editais FINEP com RAG + LLM</span>
        <nav className="ml-4 flex items-center gap-1 text-sm">
          <NavLink to="/arquitetura" className={({ isActive }) => cn('flex items-center gap-1 rounded-md px-2 py-1 text-muted-foreground hover:bg-accent hover:text-foreground', isActive && 'bg-accent text-foreground')}>
            <Workflow className="size-4" /> Arquitetura
          </NavLink>
          <NavLink to="/dataset" className={({ isActive }) => cn('flex items-center gap-1 rounded-md px-2 py-1 text-muted-foreground hover:bg-accent hover:text-foreground', isActive && 'bg-accent text-foreground')}>
            <Table2 className="size-4" /> Dataset
          </NavLink>
          <NavLink to="/resultados" className={({ isActive }) => cn('flex items-center gap-1 rounded-md px-2 py-1 text-muted-foreground hover:bg-accent hover:text-foreground', isActive && 'bg-accent text-foreground')}>
            <BarChart3 className="size-4" /> Resultados
          </NavLink>
          <NavLink to="/exploracao" className={({ isActive }) => cn('flex items-center gap-1 rounded-md px-2 py-1 text-muted-foreground hover:bg-accent hover:text-foreground', isActive && 'bg-accent text-foreground')}>
            <FlaskConical className="size-4" /> Exploração
          </NavLink>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          {health.data && (
            <Tooltip>
              <TooltipTrigger>
                <Badge variant={doclingUp ? 'secondary' : 'destructive'} className="font-normal">
                  {doclingUp ? 'Docling ok' : 'Docling fora do ar'}
                </Badge>
              </TooltipTrigger>
              <TooltipContent>
                {doclingUp
                  ? `Extração de PDF disponível · embeddings ${health.data.embedModel} · fila: ${health.data.queue.size}`
                  : 'Suba o sidecar: npm run dev:docling (porta 5001). Uploads ficam na fila até ele voltar.'}
              </TooltipContent>
            </Tooltip>
          )}
          <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)}>
            {llm.source === 'byok' ? <KeyRound className="size-4" /> : <Settings2 className="size-4" />}
            <span className="max-w-64 truncate">{describeLlm(llm)}</span>
          </Button>
        </div>
      </header>
      <main className="min-h-0 flex-1">
        <Outlet />
      </main>
      <LlmSettingsDialog open={dialogOpen} onOpenChange={(open) => { setSettingsOpen(open); if (!open) setHandledRequests(openRequests); }} />
    </div>
  );
}
