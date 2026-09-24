import type { EvalCase } from '@editais/shared';
import conferencia from '../../../../eval/conferencia.json';

/**
 * Conferência caso a caso das execuções finais: respostas que trazem os valores esperados, mas erram o que a pergunta
 * pede, contradizem o edital ou afirmam algo que não existe nele.
 */
const errors = new Set(conferencia.erros.map((e) => `${e.run}|${e.pergunta}|${e.configuracao}`));

export const conferenceErrorCount = conferencia.erros.length;

export type ConferredCase = EvalCase & {
  /** Veredito do avaliador automático: a resposta contém todos os valores do padrão-ouro. */
  valuesOk: boolean;
};

/** Aplica a conferência a uma execução: `correct` passa a exigir também que a resposta não afirme nada errado. */
export function conferRun(runId: string, cases: EvalCase[]): ConferredCase[] {
  return cases.map((c) => ({
    ...c,
    valuesOk: c.correct,
    correct: c.correct && !errors.has(`${runId}|${c.questionId}|${c.arm}`),
  }));
}
