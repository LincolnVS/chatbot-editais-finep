/* eslint-disable react-refresh/only-export-components -- helper da etapa vive junto do componente que a exibe */
import { useEffect, useState } from 'react';
import { Shimmer } from '@/components/ai-elements/shimmer';
import type { ChatStage } from '@/lib/chat';

/** O que o sistema está fazendo agora, para a linha de espera: emoji fixo da etapa + texto. */
export type ThinkingStep = { emoji: string; text: string };

const FRAMES = ['🤔', '💭', '🧠', '⚙️'];

/** Etapa exibida a partir do último `data-stage` recebido (ou da fase de preparação, antes de qualquer chunk). */
export function thinkingStep(stage: ChatStage | null, opts: { fullContext?: boolean; searched?: number } = {}): ThinkingStep {
  if (!stage) {
    return opts.fullContext ? { emoji: '📄', text: 'Lendo o documento inteiro…' } : { emoji: '🔎', text: 'Reformulando a pergunta e buscando trechos no edital…' };
  }
  switch (stage.stage) {
    case 'search':
      return stage.queries?.length
        ? { emoji: '📚', text: `O modelo pediu mais trechos: ${stage.queries.map((q) => `“${q}”`).join(', ')}` }
        : { emoji: '🤔', text: 'O modelo ia dizer que não consta — pedindo que busque antes' };
    case 'repair':
      return { emoji: '🔁', text: 'Revisando as referências da resposta…' };
    default:
      return opts.searched ? { emoji: '✍️', text: 'Escrevendo a resposta com os trechos extras…' } : { emoji: '✍️', text: 'Escrevendo a resposta…' };
  }
}

/** Linha de espera: um "computador pensando" que alterna emojis, seguido da etapa atual. */
export function Thinking({ step, className }: { step: ThinkingStep; className?: string }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), 700);
    return () => clearInterval(id);
  }, []);
  return (
    <p className={className ?? 'flex items-center gap-2 text-sm'}>
      <span aria-hidden className="w-5 text-center">{FRAMES[frame]}</span>
      <span aria-hidden>{step.emoji}</span>
      <Shimmer as="span">{step.text}</Shimmer>
    </p>
  );
}
