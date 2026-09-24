import { useEffect, useMemo, useRef } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from '@/components/ai-elements/conversation';
import { Message, MessageContent } from '@/components/ai-elements/message';
import { PromptInput, PromptInputBody, PromptInputFooter, PromptInputSubmit, PromptInputTextarea, PromptInputTools } from '@/components/ai-elements/prompt-input';
import { Suggestion } from '@/components/ai-elements/suggestion';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import { getConversation } from '@/lib/api';
import { toUIMessages, userText, type ChatMessage } from '@/lib/chat';
import { currentChoiceId, llmChoices, llmHeaders, requestLlmSettings, setLlmSettings, useLlmSettings } from '@/lib/llm-settings';
import { AssistantMessage } from './AssistantMessage';
import { Thinking, thinkingStep } from './Thinking';

/** `rag_search` ("think") = algoritmo próprio em que o modelo pode pedir buscas extras antes de responder (mais lento). */
export type ChatMode = 'rag' | 'rag_search' | 'full_context';

type Props = {
  workspaceId: string;
  /** Chave da sessão de chat (muda ao trocar de conversa; NÃO muda quando a conversa nova ganha id). */
  sessionKey: string;
  conversationId: string | null;
  onConversationCreated: (id: string) => void;
  mode: ChatMode;
  onModeChange: (mode: ChatMode) => void;
  /** Ids dos documentos no escopo (vazio = todos os prontos). */
  documentIds: string[];
  readyCount: number;
};

const SUGGESTIONS = [
  'Qual é o prazo final para envio de propostas?',
  'Quem pode participar desta chamada?',
  'Qual é o valor mínimo e máximo por proposta?',
  'Há exigência de contrapartida? De quanto?',
  'Quais documentos devem ser enviados com a proposta?',
  'Quais são os critérios de avaliação e seus pesos?',
];

/** Coluna central (T1): conversa com o edital via /api/chat (stream useChat). */
export function ChatPanel(props: Props) {
  const { conversationId, sessionKey } = props;
  // Só carrega do banco quando a sessão foi aberta a partir de uma conversa existente (sessionKey === id).
  // Uma conversa criada nesta sessão ganha id no meio do stream e NÃO pode remontar o chat.
  const loadExisting = !!conversationId && sessionKey === conversationId;
  const existing = useQuery({
    queryKey: ['conversation', conversationId],
    queryFn: () => getConversation(conversationId!),
    enabled: loadExisting,
    staleTime: 0,
  });

  if (loadExisting && existing.isLoading) {
    return (
      <div className="space-y-3 p-6">
        <Skeleton className="ml-auto h-10 w-2/3" />
        <Skeleton className="h-24 w-5/6" />
      </div>
    );
  }
  if (loadExisting && existing.error) {
    return <p className="p-6 text-sm text-destructive">Conversa não encontrada: {existing.error.message}</p>;
  }
  const initial = loadExisting && existing.data ? toUIMessages(existing.data.messages) : [];
  return <ChatSession key={props.sessionKey} {...props} initialMessages={initial} />;
}

function ChatSession({ workspaceId, sessionKey, conversationId, onConversationCreated, mode, onModeChange, documentIds, readyCount, initialMessages }: Props & { initialMessages: ChatMessage[] }) {
  const qc = useQueryClient();
  // O transport é criado uma vez por sessão; lê o estado atual por refs para não recriar o chat a cada mudança.
  const live = useRef({ conversationId, mode, documentIds, onConversationCreated });
  useEffect(() => {
    live.current = { conversationId, mode, documentIds, onConversationCreated };
  });

  const transport = useMemo(
    () =>
      // eslint-disable-next-line react-hooks/refs -- o ref é lido só no envio da mensagem, fora do render
      new DefaultChatTransport<ChatMessage>({
        api: '/api/chat',
        prepareSendMessagesRequest: ({ messages, trigger }) => ({
          headers: llmHeaders(),
          body: {
            workspaceId,
            conversationId: live.current.conversationId ?? undefined,
            // Conversa existente: só a última mensagem; o histórico vem do banco. Nova: manda tudo (só há uma).
            messages: live.current.conversationId ? messages.slice(-1) : messages,
            mode: live.current.mode === 'full_context' ? 'full_context' : 'rag',
            extraSearch: live.current.mode === 'rag_search',
            documentIds: live.current.documentIds.length > 0 ? live.current.documentIds : undefined,
            trigger,
          },
        }),
      }),
    [workspaceId],
  );

  const { messages, sendMessage, status, stop, regenerate, error, clearError } = useChat<ChatMessage>({
    id: sessionKey,
    messages: initialMessages,
    transport,
    // agrupa os chunks do stream (evita re-render por token)
    throttle: 60,
    onFinish: () => void qc.invalidateQueries({ queryKey: ['conversations', workspaceId] }),
    onError: (err) => toast.error(describeChatError(err)),
  });

  // A conversa nova ganha id no chunk `start` (messageMetadata.conversationId).
  useEffect(() => {
    if (live.current.conversationId) return;
    const withId = messages.find((m) => m.role === 'assistant' && m.metadata?.conversationId);
    if (withId?.metadata?.conversationId) live.current.onConversationCreated(withId.metadata.conversationId);
  }, [messages]);

  const busy = status === 'submitted' || status === 'streaming';
  const canAsk = readyCount > 0;

  function ask(text: string) {
    const q = text.trim();
    if (!q || busy) return;
    if (!canAsk) {
      toast.error('Envie e aguarde o processamento de pelo menos um documento.');
      return;
    }
    clearError();
    void sendMessage({ text: q });
  }

  return (
    <div className="flex h-full flex-col">
      <Conversation className="min-h-0 flex-1">
        <ConversationContent className="mx-auto w-full max-w-3xl gap-6 p-4">
          {messages.length === 0 && (
            <ConversationEmptyState>
              <div className="space-y-1">
                <h3 className="text-sm font-medium">{canAsk ? 'Pergunte sobre o edital' : 'Nenhum documento pronto'}</h3>
                <p className="text-sm text-muted-foreground">
                  {canAsk ? 'As respostas citam o item, a seção e a página de onde vieram. Clique numa citação para ver o trecho e abrir o PDF.' : 'Envie o PDF do edital no painel à esquerda e aguarde a indexação.'}
                </p>
              </div>
              {canAsk && (
                <div className="mt-2 flex max-w-xl flex-wrap justify-center gap-2">
                  {SUGGESTIONS.map((s) => <Suggestion key={s} suggestion={s} onClick={ask} />)}
                </div>
              )}
            </ConversationEmptyState>
          )}
          {messages.map((m, i) => {
            const isLast = i === messages.length - 1;
            if (m.role === 'user') {
              return (
                <Message key={m.id} from="user">
                  <MessageContent>{userText(m)}</MessageContent>
                </Message>
              );
            }
            return (
              <AssistantMessage
                key={m.id}
                message={m}
                streaming={busy && isLast}
                isLast={isLast}
                onRegenerate={isLast && !busy ? () => void regenerate() : undefined}
              />
            );
          })}
          {status === 'submitted' && messages.at(-1)?.role === 'user' && (
            <Message from="assistant">
              <MessageContent className="w-full max-w-none">
                <Thinking step={thinkingStep(null, { fullContext: mode === 'full_context' })} />
              </MessageContent>
            </Message>
          )}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{describeChatError(error)}</AlertDescription>
            </Alert>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="mx-auto w-full max-w-3xl p-4 pt-0">
        <PromptInput onSubmit={(m) => ask(m.text)} className="rounded-xl border bg-background shadow-sm">
          <PromptInputBody>
            <PromptInputTextarea placeholder={canAsk ? 'Pergunte sobre o edital… (Enter envia, Shift+Enter quebra linha)' : 'Aguardando documentos…'} disabled={!canAsk} />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools>
              <NativeSelect size="sm" value={mode} onChange={(e) => onModeChange(e.target.value as ChatMode)} disabled={busy} className="w-auto shrink-0" aria-label="Modo" title={mode === 'rag_search' ? 'think: o modelo pode pedir buscas extras no edital antes de responder (mais lento)' : undefined}>
                <NativeSelectOption value="rag">Algoritmo próprio</NativeSelectOption>
                <NativeSelectOption value="rag_search">Algoritmo próprio · think</NativeSelectOption>
                <NativeSelectOption value="full_context">Doc. inteiro</NativeSelectOption>
              </NativeSelect>
              <LlmSelect disabled={busy} />
              <span className="ml-1 truncate text-xs text-muted-foreground">
                {documentIds.length > 0 ? `${documentIds.length} de ${readyCount} doc.` : `${readyCount} doc.`}
              </span>
            </PromptInputTools>
            <PromptInputSubmit status={status} onStop={stop} disabled={!canAsk} />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  );
}

/** Quem responde: só as origens/modelos habilitados nas configurações; "Configurar…" abre o diálogo. */
function LlmSelect({ disabled }: { disabled: boolean }) {
  const settings = useLlmSettings();
  const choices = llmChoices(settings);
  return (
    <NativeSelect
      size="sm"
      value={currentChoiceId(settings)}
      disabled={disabled}
      className="w-auto shrink-0"
      aria-label="Modelo"
      onChange={(e) => {
        if (e.target.value === 'config') return requestLlmSettings();
        const choice = choices.find((c) => c.id === e.target.value);
        if (choice) setLlmSettings(choice.apply(settings));
      }}
    >
      {choices.length === 0 && <NativeSelectOption value={currentChoiceId(settings)}>Nenhum provedor habilitado</NativeSelectOption>}
      {choices.map((c) => <NativeSelectOption key={c.id} value={c.id}>{c.label}</NativeSelectOption>)}
      <NativeSelectOption value="config">Configurar…</NativeSelectOption>
    </NativeSelect>
  );
}

/** Erros do transport chegam como Error com o corpo da resposta (JSON { error: { code, message } }) ou texto. */
function describeChatError(err: Error): string {
  try {
    const parsed = JSON.parse(err.message) as { error?: { code?: string; message?: string } };
    if (parsed?.error?.message) {
      const code = parsed.error.code;
      if (code === 'context_too_large') return `Os documentos não cabem na janela do modelo para o baseline: ${parsed.error.message}. Use o modo RAG ou selecione menos documentos.`;
      if (code === 'no_documents') return 'Nenhum documento pronto no escopo selecionado.';
      if (code === 'llm_error') return `Erro do provedor de LLM: ${parsed.error.message}`;
      return parsed.error.message;
    }
  } catch {
    /* não era JSON */
  }
  return err.message || 'Falha ao obter a resposta.';
}
