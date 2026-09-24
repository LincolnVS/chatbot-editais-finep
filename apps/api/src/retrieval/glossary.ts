/**
 * Glossário do domínio (editais de fomento): grupos de termos que os editais usam para o mesmo conceito. Quando a consulta
 * toca um grupo, ganha uma variante determinística com os termos irmãos — fecha a lacuna de vocabulário sem chamar modelo
 * ("tempo de constituição" → "funcionamento regular", "registro na Junta Comercial").
 *
 * Cada grupo tem os TERMOS (o que entra na variante) e, quando o conceito é ambíguo ou a palavra é comum demais, GATILHOS
 * próprios (o que na pergunta aciona o grupo); sem gatilhos, todo termo é gatilho. O casamento é por palavra inteira
 * (aceita plural), sem acento e sem caixa: "rob" não dispara em "problema", "recurso" não dispara em "recursos financeiros".
 */

type Group = { terms: string[]; triggers?: string[] };

const GROUPS: Group[] = [
  {
    // existência/antiguidade da empresa — o edital fala em funcionamento regular, registro na Junta Comercial, atividade operacional
    terms: ['tempo de constituição', 'constituída', 'data de constituição', 'funcionamento regular', 'registro na junta comercial', 'rcpj', 'existência legal', 'atividade operacional', 'anos de existência', 'em funcionamento há'],
    triggers: ['tempo de constituição', 'constituída', 'constituição da empresa', 'data de constituição', 'tempo de existência', 'tempo de funcionamento', 'funcionamento regular', 'junta comercial', 'antiguidade'],
  },
  {
    // quem pode apresentar proposta
    terms: ['proponente', 'instituição proponente', 'empresa proponente', 'convenente', 'executora', 'coexecutora', 'beneficiária', 'são elegíveis', 'elegibilidade', 'podem apresentar proposta', 'pessoa jurídica', 'sede no território nacional', 'empresas brasileiras'],
    triggers: ['proponente', 'quem pode', 'elegível', 'elegíveis', 'elegibilidade', 'podem participar', 'podem apresentar', 'pode apresentar', 'convenente', 'executora', 'coexecutora'],
  },
  {
    // porte da empresa
    terms: ['porte', 'microempresa', 'pequena empresa', 'média empresa', 'grande empresa', 'receita operacional bruta', 'faturamento', 'enquadramento de porte'],
    triggers: ['porte', 'microempresa', 'pequena empresa', 'média empresa', 'grande empresa', 'receita operacional bruta', 'faturamento', 'receita bruta'],
  },
  {
    terms: ['contrapartida', 'contrapartida financeira', 'contrapartida econômica', 'aporte', 'recursos próprios', 'percentual mínimo de contrapartida'],
    triggers: ['contrapartida', 'aporte', 'recursos próprios'],
  },
  {
    // datas e prazos da chamada e do projeto
    terms: ['prazo', 'data limite', 'cronograma', 'vigência', 'período de execução', 'prazo de execução', 'envio da proposta', 'submissão', 'apresentação da proposta', 'encerramento', 'prorrogação'],
    triggers: ['prazo', 'data limite', 'até quando', 'quando', 'cronograma', 'vigência', 'período de execução', 'prorrogação', 'data de envio', 'data final'],
  },
  {
    // valores e limites financeiros
    terms: ['valor', 'recursos financeiros', 'orçamento', 'dotação orçamentária', 'valor mínimo', 'valor máximo', 'teto', 'montante', 'limite de recursos'],
    triggers: ['valor', 'quanto', 'recursos financeiros', 'orçamento', 'dotação', 'teto', 'montante', 'valor mínimo', 'valor máximo'],
  },
  {
    // documentação exigida
    terms: ['documentação', 'documentos', 'habilitação', 'comprovação', 'certidão', 'documentos obrigatórios', 'formulário', 'anexos obrigatórios'],
    triggers: ['documentação', 'documentos', 'documento', 'habilitação', 'comprovação', 'certidão', 'certidões', 'formulário'],
  },
  {
    // avaliação e classificação
    terms: ['avaliação', 'análise de mérito', 'critérios de avaliação', 'pontuação', 'nota', 'classificação', 'eliminação', 'desclassificação', 'inabilitação', 'nota mínima', 'desempate'],
    triggers: ['avaliação', 'avaliada', 'avaliadas', 'análise de mérito', 'critérios', 'pontuação', 'nota', 'notas', 'classificação', 'eliminação', 'desclassificação', 'eliminatório', 'eliminatórios', 'inabilitação', 'desempate'],
  },
  {
    // recurso administrativo (não confundir com recursos financeiros)
    terms: ['recurso', 'recurso administrativo', 'pedido de reconsideração', 'contestação', 'impugnação', 'prazo recursal', 'interposição de recurso'],
    triggers: ['recurso administrativo', 'interpor recurso', 'interposição', 'recorrer', 'reconsideração', 'contestação', 'impugnação', 'prazo recursal', 'recurso contra', 'apresentar recurso', 'cabe recurso'],
  },
  {
    terms: ['ict', 'instituição científica, tecnológica e de inovação', 'universidade', 'instituto de pesquisa', 'instituição de ensino', 'fundação de apoio'],
    triggers: ['ict', 'icts', 'instituição científica', 'universidade', 'instituto de pesquisa', 'instituição de ensino', 'fundação de apoio'],
  },
  {
    // maturidade tecnológica e P&D
    terms: ['inovação', 'p&d', 'pesquisa e desenvolvimento', 'trl', 'nível de maturidade tecnológica', 'desenvolvimento tecnológico', 'grau de inovação'],
    triggers: ['trl', 'maturidade tecnológica', 'p&d', 'pesquisa e desenvolvimento', 'grau de inovação', 'desenvolvimento tecnológico'],
  },
  {
    terms: ['parceria', 'cooperação', 'arranjo', 'arranjo simples', 'arranjo em rede', 'rede', 'coexecução', 'interveniente', 'parceiro'],
    triggers: ['parceria', 'parcerias', 'parceiro', 'parceiros', 'cooperação', 'arranjo', 'arranjos', 'em rede', 'coexecução', 'interveniente'],
  },
  {
    terms: ['esclarecimento', 'esclarecimentos', 'dúvidas', 'e-mail', 'contato', 'atendimento', 'canal de comunicação'],
    triggers: ['esclarecimento', 'esclarecimentos', 'dúvida', 'dúvidas', 'contato', 'e-mail', 'email', 'tirar dúvidas'],
  },
  {
    terms: ['retificação', 'rerratificação', 'aviso de rerratificação', 'alteração do edital', 'errata', 'republicação'],
    triggers: ['retificação', 'rerratificação', 'retificado', 'alterado', 'alteração', 'errata', 'mudou', 'mudança'],
  },
  {
    // fluxo financeiro do projeto
    terms: ['pagamento', 'desembolso', 'parcela', 'parcelas', 'liberação de recursos', 'repasse', 'prestação de contas'],
    triggers: ['pagamento', 'pagamentos', 'desembolso', 'parcela', 'parcelas', 'liberação de recursos', 'repasse', 'prestação de contas'],
  },
  {
    terms: ['vedação', 'vedado', 'impedimento', 'não poderão participar', 'inadimplência', 'regularidade fiscal', 'débitos', 'não é permitido', 'não serão aceitas'],
    triggers: ['vedação', 'vedado', 'vedada', 'impedimento', 'impedido', 'não pode', 'não podem', 'proibido', 'inadimplência', 'inadimplente', 'regularidade fiscal', 'débitos'],
  },
  {
    // recorte regional
    terms: ['região', 'regionalização', 'norte', 'nordeste', 'centro-oeste', 'sul', 'sudeste', 'sede', 'território', 'município', 'localização'],
    triggers: ['região', 'regiões', 'regional', 'regionalização', 'norte', 'nordeste', 'centro-oeste', 'sul', 'sudeste', 'sede', 'localização', 'localizada', 'localizadas'],
  },
  {
    // bônus na pontuação — nos editais da Finep costuma ser o critério de regionalização
    terms: ['pontuação adicional', 'bônus', 'pontos adicionais', 'critério de desempate', 'acréscimo', 'majoração', 'prioridade', 'regionalização'],
    triggers: ['pontuação adicional', 'bônus', 'pontos extras', 'pontos adicionais', 'pontuação extra', 'desempate', 'majoração', 'prioridade'],
  },
];

function fold(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Palavra ou expressão inteira (aceita plural em -s/-es), sem acento. */
function matcher(term: string): RegExp {
  return new RegExp(String.raw`(?<!\p{L})${escapeRe(fold(term))}(?:e?s)?(?!\p{L})`, 'u');
}

const COMPILED = GROUPS.map((g) => ({
  terms: g.terms,
  termRes: g.terms.map(matcher),
  triggers: (g.triggers ?? g.terms).map((t) => ({ term: t, re: matcher(t) })),
}));

/** Termos irmãos dos grupos que a consulta toca (ordem: gatilho casado mais longo primeiro), sem os que a consulta já tem. */
export function glossaryTerms(query: string, maxGroups = 3): string[][] {
  const q = fold(query);
  const hits: Array<{ len: number; terms: string[] }> = [];
  for (const g of COMPILED) {
    const matched = g.triggers.filter((t) => t.re.test(q));
    if (matched.length === 0) continue;
    const len = Math.max(...matched.map((t) => t.term.length));
    const terms = g.terms.filter((_, i) => !g.termRes[i]!.test(q));
    if (terms.length > 0) hits.push({ len, terms });
  }
  return hits.toSorted((a, b) => b.len - a.len).slice(0, maxGroups).map((h) => h.terms);
}

/** Uma variante por grupo tocado: a consulta + os termos irmãos (entra na fusão como as variantes do modelo). */
export function glossaryVariants(query: string, maxGroups = 3): string[] {
  return glossaryTerms(query, maxGroups).map((terms) => `${query} ${terms.join(' ')}`);
}
