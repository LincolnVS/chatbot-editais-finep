import { useMemo, useState, type ComponentProps } from 'react';
import { useMutation } from '@tanstack/react-query';
import { AlertTriangle, CircleHelp, Info, RefreshCw, SearchX, ShieldCheck, ThumbsDown, ThumbsUp, Timer } from 'lucide-react';
import { toast } from 'sonner';
import type { AnswerTimings, Citation, MessageFeedback } from '@editais/shared';
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message';
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning';
import { Button } from '@/components/ui/button';
import { setMessageFeedback } from '@/lib/api';
import { assistantView, describeStatus, linkifyCitations, type ChatMessage, type ChatStatus } from '@/lib/chat';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useCitationContext } from './citation-context';
import { Thinking, thinkingStep } from './Thinking';

type Props = {
  message: ChatMessage;
  streaming: boolean;
  isLast: boolean;
  onRegenerate?: () => void;
};

const CITE_PREFIX = '#cite-';

/** Pílula de citação: o renderer de markdown entrega `[n](#cite-<label>)` como link; aqui vira botão. */
function CitationAnchor({ href, children, messageId, citations }: ComponentProps<'a'> & { messageId: string; citations: Citation[] }) {
  const { selected, select } = useCitationContext();
  if (!href?.startsWith(CITE_PREFIX)) {
    return <a href={href} target="_blank" rel="noreferrer" className="underline">{children}</a>;
  }
  const label = href.slice(CITE_PREFIX.length);
  const citation = citations.find((c) => c.label === label);
  if (!citation) return <span className="text-muted-foreground">[{children}]</span>;
  const active = selected?.messageId === messageId && selected.citation.label === label;
  const where = citation.itemNumber ? `item ${citation.itemNumber}` : citation.sectionPath || `p. ${citation.page}`;
  return (
    <button
      type="button"
      onClick={() => select({ messageId, citation })}
      title={`${citation.documentTitle} › ${where} · p. ${citation.page}`}
      className={cn(
        'mx-0.5 inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-full border px-1 align-text-top text-[10px] font-semibold leading-none',
        active ? 'border-primary bg-primary text-primary-foreground' : 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/20',
      )}
    >
      {children}
    </button>
  );
}

const fmtSeconds = (ms: number) => `${(ms / 1000).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`;

/** Tempo total da resposta; no hover, o tempo de cada etapa e quanto dele foi só subida do CLI do Claude Code. */
function TimingLine({ timings }: { timings: AnswerTimings }) {
  const stages: Array<[string, number | undefined]> = [
    ['expansão da pergunta', timings.expansionMs],
    ['busca dos trechos', timings.retrievalMs],
    ['geração da resposta', timings.generationMs],
    ['busca extra pedida pelo modelo', timings.searchMs],
    ['revisão (2ª chamada)', timings.repairMs],
  ];
  const known = stages.reduce((sum, [, v]) => sum + (v ?? 0), 0);
  const other = Math.max(0, timings.totalMs - known);
  return (
    <Tooltip>
      <TooltipTrigger>
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Timer className="size-3.5" /> {fmtSeconds(timings.totalMs)}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">
        <ul className="space-y-0.5 tabular-nums">
          {stages.filter((s): s is [string, number] => s[1] !== undefined).map(([label, ms]) => (
            <li key={label} className="flex justify-between gap-4"><span>{label}</span><span>{fmtSeconds(ms)}</span></li>
          ))}
          {other >= 100 && <li className="flex justify-between gap-4"><span>validação e gate</span><span>{fmtSeconds(other)}</span></li>}
          <li className="flex justify-between gap-4 border-t pt-0.5 font-medium"><span>total</span><span>{fmtSeconds(timings.totalMs)}</span></li>
          {timings.overheadMs !== undefined && timings.overheadMs >= 100 && (
            <li className="mt-1 border-t pt-1 text-[11px] leading-snug opacity-80">
              <span className="flex justify-between gap-4"><span>só subida do CLI do Claude Code</span><span>{fmtSeconds(timings.overheadMs)}</span></span>
              <span className="block">já contado nas etapas acima (um processo por chamada); some com chave própria (BYOK) ou modelo local.</span>
            </li>
          )}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}

/** Avaliação da resposta: fica guardada com a mensagem (e volta ao recarregar); por enquanto não alimenta nada. */
function Feedback({ conversationId, messageId, initial }: { conversationId: string; messageId: string; initial: MessageFeedback }) {
  const [vote, setVote] = useState<MessageFeedback>(initial);
  const save = useMutation({
    mutationFn: (feedback: MessageFeedback) => setMessageFeedback(conversationId, messageId, feedback),
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Não foi possível guardar a avaliação.'),
  });
  const choose = (next: Exclude<MessageFeedback, null>) => {
    const feedback = vote === next ? null : next;
    const previous = vote;
    setVote(feedback);
    save.mutate(feedback, { onError: () => setVote(previous) });
  };
  return (
    <>
      <Button variant="ghost" size="icon-xs" aria-label="Resposta boa" aria-pressed={vote === 'up'} className={cn(vote === 'up' && 'text-emerald-700')} onClick={() => choose('up')}>
        <ThumbsUp className="size-3.5" />
      </Button>
      <Button variant="ghost" size="icon-xs" aria-label="Resposta ruim" aria-pressed={vote === 'down'} className={cn(vote === 'down' && 'text-destructive')} onClick={() => choose('down')}>
        <ThumbsDown className="size-3.5" />
      </Button>
    </>
  );
}

/** Desfecho da resposta: com referência (gate ok), parcial, esclarecimento, não consta ou sem referência. */
function StatusLine({ status }: { status: ChatStatus }) {
  const d = describeStatus(status.status);
  const g = status.grounding;
  const Icon = status.status === 'answered' ? ShieldCheck : status.status === 'clarification' ? CircleHelp : status.status === 'not_found' ? SearchX : AlertTriangle;
  const detail =
    status.status === 'answered' && g.blocks > 0
      ? ` · ${g.blocks} ${g.blocks === 1 ? 'afirmação conferida' : 'afirmações conferidas'}${g.policy === 'strict' ? ' (valores e datas verificados nos trechos)' : ''}`
      : status.status === 'partial'
        ? ` · ${g.cited} de ${g.blocks} afirmações com referência`
        : '';
  return (
    <Tooltip>
      <TooltipTrigger>
        <span className={cn('inline-flex items-center gap-1 text-xs', d.tone === 'ok' ? 'text-emerald-700 dark:text-emerald-400' : d.tone === 'warn' ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground')}>
          <Icon className="size-3.5" /> {d.label}{detail}{status.repaired ? ' · revisada' : ''}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">{d.hint}{status.repaired ? ' A primeira versão tinha problemas de referência e foi reescrita pelo modelo.' : ''}</TooltipContent>
    </Tooltip>
  );
}

export function AssistantMessage({ message, streaming, isLast, onRegenerate }: Props) {
  const view = useMemo(() => assistantView(message), [message]);
  const { selected, select } = useCitationContext();
  const markdown = useMemo(() => linkifyCitations(view.text, view.citations, streaming), [view.text, view.citations, streaming]);

  const components = useMemo(
    () => ({ a: (props: ComponentProps<'a'>) => <CitationAnchor {...props} messageId={message.id} citations={view.citations} /> }),
    [message.id, view.citations],
  );

  // Enquanto o modelo só pediu buscas (`<buscar>…`), o texto não é resposta: fica a linha de espera no lugar.
  const searchOnly = streaming && /^\s*<buscar>/i.test(view.text);
  const waiting = streaming && (searchOnly || (!view.text && !view.reasoning));
  const step = thinkingStep(view.stage, { searched: view.searched });
  const conversationId = message.metadata?.conversationId;

  return (
    <Message from="assistant">
      <MessageContent className="w-full max-w-none">
        {view.reasoning && (
          <Reasoning isStreaming={streaming && !view.text} defaultOpen={false}>
            <ReasoningTrigger />
            <ReasoningContent>{view.reasoning}</ReasoningContent>
          </Reasoning>
        )}
        {waiting ? (
          <Thinking step={step} />
        ) : (
          <MessageResponse components={components} isAnimating={streaming}>{markdown}</MessageResponse>
        )}
        {streaming && !waiting && view.stage?.stage === 'repair' && <Thinking step={step} className="flex items-center gap-2 text-xs text-muted-foreground" />}

        {!streaming && view.citations.length > 0 && (
          <ol className="mt-1 space-y-0.5 border-t pt-2 text-xs text-muted-foreground">
            {view.citations.map((c) => {
              const active = selected?.messageId === message.id && selected.citation.label === c.label;
              return (
                <li key={c.label}>
                  <button
                    type="button"
                    onClick={() => select({ messageId: message.id, citation: c })}
                    className={cn('flex w-full items-baseline gap-1.5 rounded px-1 py-0.5 text-left hover:bg-accent', active && 'bg-accent text-foreground')}
                  >
                    <span className="font-semibold">[{c.ordinal}]</span>
                    <span className="min-w-0 truncate">
                      {c.documentTitle}{c.versionLabel ? ` (${c.versionLabel})` : ''} › {c.itemNumber ? `item ${c.itemNumber}` : c.sectionPath || '—'} · p. {c.page}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}

        {!streaming && view.status && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <StatusLine status={view.status} />
            {view.status.timings && <TimingLine timings={view.status.timings} />}
            {view.retrieval && <span className="text-xs text-muted-foreground">{view.retrieval.candidates.filter((c) => c.selected).length} trechos usados</span>}
            <span className="ml-auto flex items-center gap-0.5">
              {isLast && onRegenerate && <Button variant="ghost" size="xs" onClick={onRegenerate}><RefreshCw className="size-3" /> Regenerar</Button>}
              {conversationId && <Feedback key={message.id} conversationId={conversationId} messageId={message.id} initial={message.metadata?.feedback ?? null} />}
            </span>
          </div>
        )}
        {!streaming && view.status?.extraSearches && view.status.extraSearches.length > 0 && (
          <p className="text-xs text-muted-foreground">📚 busca extra pedida pelo modelo: {view.status.extraSearches.map((s) => `“${s}”`).join(', ')}</p>
        )}

        {!streaming && view.warnings.map((w, i) => (
          <p key={i} className={cn('flex items-center gap-1 text-xs', w.code === 'fallback_provider' ? 'text-muted-foreground' : 'text-amber-700 dark:text-amber-400')}>
            {w.code === 'fallback_provider' ? <Info className="size-3.5" /> : <AlertTriangle className="size-3.5" />} {w.message}{w.labels?.length ? ` (${w.labels.join(', ')})` : ''}
          </p>
        ))}

      </MessageContent>
    </Message>
  );
}
