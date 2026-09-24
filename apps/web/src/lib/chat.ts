/**
 * Tipos e helpers do chat (protocolo useChat do AI SDK + data parts enviadas pelo servidor).
 */
import type { UIMessage } from 'ai';
import type { AnswerStatus, AnswerWarning, Citation, GroundingReport, MessageFeedback, RetrievalResult, AnswerTimings } from '@editais/shared';
import { LABEL_RE, SECTION_RE, normalizeLabels } from '@editais/shared';
import type { StoredMessage } from './api';

export type RetrievalSummary = Omit<RetrievalResult, 'context'>;
export type ChatWarning = AnswerWarning;
export type ChatStatus = { status: AnswerStatus; grounding: GroundingReport; provider: string; model: string; repaired: boolean; fallbackFrom?: string; timings?: AnswerTimings; extraSearches?: string[] };
/** Etapa em andamento, enviada pelo servidor durante a resposta (geração, busca extra pedida pelo modelo, revisão). */
export type ChatStage = { stage: 'generation' | 'search' | 'repair'; queries?: string[] };

export type ChatMetadata = { conversationId?: string; feedback?: MessageFeedback };
export type ChatDataParts = { retrieval: RetrievalSummary; citation: Citation; warning: ChatWarning; status: ChatStatus; stage: ChatStage };
export type ChatMessage = UIMessage<ChatMetadata, ChatDataParts>;

export type AssistantView = {
  text: string;
  reasoning: string;
  citations: Citation[];
  retrieval: RetrievalSummary | null;
  warnings: ChatWarning[];
  status: ChatStatus | null;
  /** Última etapa anunciada pelo servidor (só faz sentido enquanto a resposta chega). */
  stage: ChatStage | null;
  /** Buscas extras já anunciadas nesta resposta. */
  searched: number;
};

/** Extrai texto, raciocínio, citações, avisos e status das parts de uma mensagem do assistente. */
export function assistantView(message: ChatMessage): AssistantView {
  const view: AssistantView = { text: '', reasoning: '', citations: [], retrieval: null, warnings: [], status: null, stage: null, searched: 0 };
  const seen = new Set<string>();
  for (const part of message.parts) {
    switch (part.type) {
      case 'text':
        view.text += part.text;
        break;
      case 'reasoning':
        view.reasoning += part.text;
        break;
      case 'data-citation':
        if (!seen.has(part.data.label)) {
          seen.add(part.data.label);
          view.citations.push(part.data);
        }
        break;
      case 'data-retrieval':
        view.retrieval = part.data;
        break;
      case 'data-warning':
        view.warnings.push(part.data);
        break;
      case 'data-status':
        view.status = part.data;
        break;
      case 'data-stage':
        view.stage = part.data;
        if (part.data.stage === 'search') view.searched += 1;
        break;
      default:
        break;
    }
  }
  return view;
}

export function userText(message: ChatMessage): string {
  return message.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
}

/** Converte os rótulos `[c_xxxxxx]` / `[sec-…]` do texto em links markdown `[n](#cite-<label>)` que o renderer transforma em pílulas clicáveis. */
export function linkifyCitations(text: string, citations: Citation[], streaming: boolean): string {
  const ordinal = new Map(citations.map((c) => [c.label, c.ordinal]));
  const replace = (_whole: string, label: string) => {
    const n = ordinal.get(label);
    if (n !== undefined) return `[${n}](#cite-${label})`;
    return streaming ? '[…]' : '';
  };
  return normalizeLabels(text).replace(LABEL_RE, replace).replace(SECTION_RE, replace).replace(/[ \t]+([.,;:!?])/g, '$1');
}

/** Rótulo curto e descrição do desfecho de uma resposta (badge da mensagem). */
export function describeStatus(status: AnswerStatus): { label: string; hint: string; tone: 'ok' | 'warn' | 'muted' } {
  switch (status) {
    case 'answered':
      return { label: 'Com referência', hint: 'Todas as afirmações têm trecho de origem e os valores conferem com os documentos.', tone: 'ok' };
    case 'partial':
      return { label: 'Parcial', hint: 'Parte do que o modelo escreveu foi omitida por não ter referência nos documentos.', tone: 'warn' };
    case 'clarification':
      return { label: 'Esclarecimento', hint: 'A pergunta ficou ambígua; o assistente pediu mais detalhes antes de responder.', tone: 'muted' };
    case 'not_found':
      return { label: 'Não consta', hint: 'A informação não foi localizada nos documentos selecionados.', tone: 'muted' };
    case 'unsupported':
      return { label: 'Sem referência', hint: 'O modelo não conseguiu apoiar a resposta nos documentos; nada foi exibido sem referência.', tone: 'warn' };
    default:
      return { label: status, hint: '', tone: 'muted' };
  }
}

/** Reconstrói UIMessages a partir das mensagens persistidas (GET /api/conversations/:id). */
export function toUIMessages(stored: StoredMessage[]): ChatMessage[] {
  return stored
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => {
      const parts = Array.isArray(m.parts) && m.parts.length > 0
        ? (m.parts as ChatMessage['parts'])
        : ([{ type: 'text', text: m.content }, ...m.citations.map((c) => ({ type: 'data-citation' as const, data: c }))] as ChatMessage['parts']);
      return { id: m.id, role: m.role as 'user' | 'assistant', parts, metadata: { conversationId: m.conversationId, feedback: m.feedback ?? null } };
    });
}
