/**
 * Realimentação por pseudo-relevância (Rocchio/RM3 simplificado): assume que os primeiros trechos recuperados são
 * relevantes, tira deles os termos mais discriminativos e monta uma consulta nova com esses termos.
 *
 * Fecha a lacuna de vocabulário sem lista escrita por ninguém e sem chamar modelo: o vocabulário vem do próprio
 * resultado da busca, então não há artefato que possa ter sido ajustado às perguntas de avaliação.
 *
 * Discriminação por tf-idf sobre o escopo: o termo pesa pela frequência nos trechos do topo e desconta a frequência
 * no acervo inteiro (palavra que aparece em todo edital — "proposta", "Finep" — não informa nada).
 */

const STOPWORDS = new Set(
  `a o as os um uma uns umas de da do das dos e ou que para por com sem sob sobre entre no na nos nas ao aos à às
   se ser será serão seja sejam ter tem têm haver há este esta estes estas esse essa esses essas isso aquele aquela
   seu sua seus suas pelo pela pelos pelas quando onde como qual quais cujo cuja mais menos muito pouco todo toda
   todos todas outro outra outros outras não sim também já ainda apenas somente conforme observado disposto demais
   deverá deverão devem deve poderá poderão pode podem será caso após antes até desde mesmo mesma respectivo
   art artigo item itens inciso alínea parágrafo`.split(/\s+/).filter(Boolean),
);

const MIN_TERMO = 4;

function fold(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
}

function palavras(texto: string): string[] {
  return fold(texto).split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= MIN_TERMO && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

/** Frequência de documento no acervo amostrado, para descontar o que é comum a todo edital. */
function df(amostra: string[]): Map<string, number> {
  const contagem = new Map<string, number>();
  for (const texto of amostra) {
    for (const t of new Set(palavras(texto))) contagem.set(t, (contagem.get(t) ?? 0) + 1);
  }
  return contagem;
}

/**
 * Termos de realimentação: os mais discriminativos dos `topo`, comparados ao acervo (`amostra`), tirando os que a
 * consulta já tem.
 */
export function feedbackTerms(query: string, topo: string[], amostra: string[], quantos: number): string[] {
  if (topo.length === 0) return [];
  const naConsulta = new Set(palavras(query));
  const dfAcervo = df(amostra);
  const n = Math.max(amostra.length, 1);
  const peso = new Map<string, number>();
  for (const texto of topo) {
    for (const t of palavras(texto)) {
      if (naConsulta.has(t)) continue;
      const idf = Math.log((n + 1) / ((dfAcervo.get(t) ?? 0) + 1));
      if (idf <= 0) continue;
      peso.set(t, (peso.get(t) ?? 0) + idf);
    }
  }
  return [...peso.entries()].toSorted((a, b) => b[1] - a[1]).slice(0, quantos).map(([t]) => t);
}

/** Consulta de realimentação: a pergunta original mais os termos extraídos dos melhores trechos. */
export function feedbackQuery(query: string, termos: string[]): string | null {
  return termos.length > 0 ? `${query} ${termos.join(' ')}` : null;
}
