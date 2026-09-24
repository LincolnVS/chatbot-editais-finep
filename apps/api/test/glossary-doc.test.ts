import { describe, expect, it } from 'vitest';
import { extractGlossary, type GlossaryEntry } from '../src/ingest/glossary-extract.ts';
import { docGlossaryTerms, docGlossaryVariants } from '../src/retrieval/doc-glossary.ts';
import { feedbackQuery, feedbackTerms } from '../src/retrieval/prf.ts';

const EDITAL = `
2. DEFINIÇÕES
2.1. No âmbito da presente Chamada Pública, serão adotadas as seguintes definições:
2.1.1 Instituição Proponente: ICT que manifeste interesse em celebrar o instrumento contratual com a Finep.
2.1.2 Instituição Executora Principal: ICT responsável pela execução do objeto do instrumento contratual.
2.1.3 Instituição Coexecutora: ICT parceira que irá contribuir para o desenvolvimento do objeto.
3. ELEGIBILIDADE
3.1. Poderão participar as Instituições Científicas, Tecnológicas e de Inovação (ICTs) públicas ou privadas.
3.2. Entende-se por risco tecnológico a possibilidade de insucesso no desenvolvimento de solução.
`;

describe('glossário derivado do documento', () => {
  const entradas = extractGlossary(EDITAL);

  it('extrai os termos definidos em itens numerados', () => {
    const termos = entradas.filter((e) => e.kind === 'definicao').map((e) => e.term);
    expect(termos).toContain('Instituição Proponente');
    expect(termos).toContain('Instituição Coexecutora');
  });

  it('usa os termos irmãos do mesmo bloco como expansão', () => {
    const proponente = entradas.find((e) => e.term === 'Instituição Proponente');
    expect(proponente?.aliases).toContain('Instituição Executora Principal');
    expect(proponente?.aliases).not.toContain('Instituição Proponente');
  });

  it('extrai sigla com o nome por extenso', () => {
    const sigla = entradas.find((e) => e.kind === 'sigla');
    expect(sigla?.term).toMatch(/Instituições Científicas/);
    expect(sigla?.aliases).toContain('ICT');
  });

  it('extrai definição embutida cortando o determinante', () => {
    expect(entradas.find((e) => e.kind === 'expressao')?.term).toBe('risco tecnológico');
  });

  it('dispara por palavra distintiva do termo, não só pelo termo inteiro', () => {
    const grupos = docGlossaryTerms('Quem pode apresentar proposta como proponente?', entradas);
    expect(grupos.flat()).toContain('Instituição Executora Principal');
  });

  it('dispara pela sigla e devolve o nome por extenso', () => {
    expect(docGlossaryTerms('uma ICT pode participar?', entradas).flat().join(' ')).toMatch(/Instituições Científicas/);
  });

  it('não repete na variante o que a consulta já diz', () => {
    const variantes = docGlossaryVariants('o que é risco tecnológico?', entradas);
    for (const v of variantes) expect(v.match(/risco tecnológico/gi)?.length).toBe(1);
  });

  it('não dispara quando a consulta não toca nenhum termo', () => {
    expect(docGlossaryTerms('qual a cor do céu?', entradas)).toEqual([]);
  });

  it('com atestação, só expande com termo que existe no documento buscado', () => {
    const presente = (termos: string[]) => new Set(termos.filter((t) => t !== 'Instituição Coexecutora'));
    const grupos = docGlossaryTerms('Quem pode apresentar proposta como proponente?', entradas, 3, presente);
    expect(grupos.flat()).not.toContain('Instituição Coexecutora');
    expect(grupos.flat()).toContain('Instituição Executora Principal');
  });

  it('descarta o grupo inteiro quando nada nele está atestado', () => {
    expect(docGlossaryTerms('uma ICT pode participar?', entradas, 3, () => new Set())).toEqual([]);
  });

  it('da camada de LLM leva só o termo do edital, nunca os sinônimos coloquiais', () => {
    const llm: GlossaryEntry[] = [
      { term: 'risco tecnológico', aliases: ['chance de dar errado', 'medo de não funcionar'], kind: 'llm', label: null },
    ];
    expect(docGlossaryTerms('qual a chance de dar errado?', llm)).toEqual([['risco tecnológico']]);
  });
});

describe('realimentação por pseudo-relevância', () => {
  const topo = ['O prazo de interposição de recurso é de dez dias corridos contados da divulgação.'];
  const amostra = [...topo, 'A proposta deve ser enviada pelo portal da Finep.', 'O valor máximo por proposta é de um milhão.'];

  it('tira da consulta os termos discriminativos dos melhores trechos', () => {
    const termos = feedbackTerms('prazo de recurso', topo, amostra, 5);
    expect(termos).toContain('interposicao');
    expect(termos).not.toContain('prazo');
  });

  it('descarta palavra comum a todo o acervo', () => {
    const termos = feedbackTerms('prazo', ['proposta proposta interposicao'], ['proposta', 'proposta', 'proposta'], 5);
    expect(termos).not.toContain('proposta');
  });

  it('não monta consulta quando não há termo novo', () => {
    expect(feedbackQuery('prazo', [])).toBeNull();
    expect(feedbackTerms('prazo', [], amostra, 5)).toEqual([]);
  });
});
