/** Descrição das etapas da arquitetura (o que cada caixa faz) com os parâmetros vivos lidos da configuração. */
import type { PipelineConfig, LlmConfig } from '@editais/shared';
import { DEFAULT_EVAL_ARMS, EVAL_ARMS, EVAL_ARM_IDS } from '@editais/shared';
import type { Health, LlmDefaults } from './api';

export type LaneId = 'ingestao' | 'resposta' | 'avaliacao';

export type Stage = {
  id: string;
  lane: LaneId;
  title: string;
  /** Uma linha (aparece na caixa). */
  summary: string;
  /** Explicação para o painel de detalhes. */
  details: string[];
  /** Parâmetros vivos: rótulo → valor. */
  params: Array<[string, string]>;
  /** Onde está no código. */
  code: string[];
  /** Estado de saúde, quando aplicável. */
  status?: 'ok' | 'down' | 'off';
};

/** Provedor que responde nesta sessão (origem escolhida na tela) e a reserva configurada no servidor. */
export type LiveLlm = { kind: LlmConfig['kind']; model: string; fallback: LlmDefaults['fallback'] };
export type LiveInputs = { config: PipelineConfig; health: Health | null; llm: LiveLlm | null };

export const LANES: Array<{ id: LaneId; title: string; subtitle: string }> = [
  { id: 'ingestao', title: 'Ingestão', subtitle: 'do PDF ao índice — roda uma vez por documento' },
  { id: 'resposta', title: 'Resposta', subtitle: 'de uma pergunta à resposta com referência — roda a cada mensagem' },
  { id: 'avaliacao', title: 'Avaliação', subtitle: 'experimento do TCC — compara o RAG com os baselines' },
];

const fmt = (n: number) => n.toLocaleString('pt-BR');
const onOff = (b: boolean) => (b ? 'ligado' : 'desligado');
const rerankLabel = (r: string) => (r === 'off' ? 'desligado (testado, não compensa)' : r);

export function buildStages({ config, health, llm }: LiveInputs): Stage[] {
  const c = config;
  const doclingUp = health?.docling ?? false;
  const providerLabel = llm ? `${llm.kind} · ${llm.model}` : '—';
  const fallbackLabel = llm?.fallback ? `${llm.fallback.kind} · ${llm.fallback.model}` : 'não configurado';
  // Anthropic e o CLI do Claude Code não aceitam temperatura: o valor não é enviado.
  const temperatureLabel = llm && (llm.kind === 'anthropic' || llm.kind === 'claude-code') ? 'padrão do provedor (não enviada)' : '0';
  const embedDims = c.embedModel.startsWith('e5-small') ? '384' : c.embedModel.startsWith('e5-base') ? '768' : '?';

  return [
    {
      id: 'upload',
      lane: 'ingestao',
      title: 'Upload do PDF',
      summary: 'Edital, anexos, avisos de rerratificação e documentos de apoio',
      details: [
        'Cada documento recebe tipo (edital = norma; apoio = material do usuário) e espécie (edital principal, aviso de rerratificação, anexo…).',
        'Um aviso de rerratificação declara qual documento altera; nas respostas ele prevalece sobre o texto original.',
        'O PDF é guardado com o hash SHA-256 — o mesmo arquivo não é processado duas vezes.',
      ],
      params: [['deduplicação', 'sha256 por workspace'], ['limite', '100 MB']],
      code: ['apps/api/src/routes/documents.ts', 'apps/api/src/storage.ts'],
    },
    {
      id: 'parse',
      lane: 'ingestao',
      title: 'Extração (Docling)',
      summary: 'PDF → layout com cabeçalhos, itens, tabelas e coordenadas por página',
      details: [
        'O Docling roda como serviço local (sidecar) e devolve o documento em JSON: blocos de texto com rótulo (título, seção, item de lista, tabela), página e caixa (bbox).',
        'O JSON é congelado em disco: reindexar com outra configuração reaproveita o parse.',
      ],
      params: [['serviço', doclingUp ? 'no ar (porta 5001)' : 'fora do ar'], ['parser', c.parser], ['saída', 'JSON congelado + hash']],
      code: ['apps/api/src/ingest/docling.ts', 'scripts/dev-docling.ps1'],
      status: doclingUp ? 'ok' : 'down',
    },
    {
      id: 'normalize',
      lane: 'ingestao',
      title: 'Normalização',
      summary: 'Numeração (6.5.5), hierarquia de seções, tabelas e cabeçalhos/rodapés',
      details: [
        'Reconstrói a estrutura do edital: detecta a numeração dos itens, monta a árvore seção › item › alínea e junta tabelas quebradas entre páginas.',
        'Remove cabeçalhos e rodapés repetidos; gera o canonical.md (Markdown com âncoras {#sec-… p=N}) usado pelo baseline de documento inteiro.',
      ],
      params: [['cabeçalho/rodapé', c.removeHeaderFooter ? 'removidos' : 'mantidos'], ['saídas', 'parsed.json · canonical.md · sections.json']],
      code: ['apps/api/src/ingest/normalize.ts'],
    },
    {
      id: 'chunk',
      lane: 'ingestao',
      title: 'Chunking hierárquico',
      summary: 'Trechos por item/seção, tabela como bloco, rótulo estável c_xxxxxx',
      details: [
        'Cada trecho (chunk) corresponde a uma unidade do edital — item, alínea, seção ou tabela — e carrega o caminho da seção, o número do item, a página e as caixas para destacar no PDF.',
        'O rótulo c_xxxxxx é derivado por hash do conteúdo: é ele que o modelo cita e que o validador confere.',
        'Chunks-pai (seção inteira) ficam disponíveis para a expansão folha→pai no retrieval.',
      ],
      params: [
        ['estratégia', c.chunking.strategy === 'hier' ? 'hierárquica' : 'janela fixa'],
        ['tamanho máx.', `${fmt(c.chunking.maxChars)} chars`],
        ['sobreposição', `${fmt(c.chunking.overlapChars)} chars`],
        ['tabelas', c.chunking.tableMode],
        ['mesclar vizinhos', c.chunking.mergePeers ? 'sim' : 'não'],
      ],
      code: ['apps/api/src/ingest/chunker.ts'],
    },
    {
      id: 'embed',
      lane: 'ingestao',
      title: 'Embeddings',
      summary: 'Vetores locais (Transformers.js) com cache por conteúdo',
      details: [
        'Modelo multilíngue rodando no próprio servidor (sem enviar o edital para fora). O texto embedado inclui o prefixo de contexto "[título › seção]".',
        'Os vetores ficam em cache por hash do texto: reindexar com o mesmo chunking não recalcula nada.',
      ],
      params: [['modelo', c.embedModel], ['dimensões', embedDims], ['execução', 'worker local (CPU)'], ['fila', health ? `${health.queue.size} documento(s)` : '—']],
      code: ['apps/api/src/embed/worker.ts', 'apps/api/src/embed/registry.ts'],
    },
    {
      id: 'index',
      lane: 'ingestao',
      title: 'Índices (SQLite)',
      summary: 'FTS5 (léxico) + sqlite-vec (vetorial) no mesmo banco',
      details: [
        'Um único arquivo SQLite guarda documentos, chunks, o índice de texto completo (BM25) e o índice vetorial (KNN).',
        'Ao trocar a configuração, o conjunto de chunks anterior continua servindo até o novo ficar pronto; depois é removido.',
      ],
      params: [['banco', health?.db ? 'ok' : 'indisponível'], ['léxico', 'FTS5 · BM25 · unicode61'], ['vetorial', 'vec0 · cosseno']],
      code: ['apps/api/src/db/sqlite.ts', 'apps/api/src/db/queries.ts', 'apps/api/src/db/migrations/'],
      status: health?.db ? 'ok' : 'down',
    },

    {
      id: 'question',
      lane: 'resposta',
      title: 'Pergunta',
      summary: 'Chat com histórico; follow-ups curtos herdam a pergunta anterior',
      details: [
        'A pergunta chega com o histórico da conversa e o escopo de documentos escolhido.',
        'Perguntas curtas ou com pronomes ("e o valor?") têm a pergunta anterior anexada à consulta de busca — o modelo continua respondendo só com os trechos desta rodada.',
      ],
      params: [['protocolo', 'stream (AI SDK useChat)'], ['escopo', 'todos os prontos ou seleção']],
      code: ['apps/api/src/routes/chat.ts', 'apps/web/src/components/chat/ChatPanel.tsx'],
    },
    {
      id: 'retrieval',
      lane: 'resposta',
      title: 'Retrieval híbrido',
      summary: 'expansão de consulta + glossário do documento → BM25 + vetorial → RRF → expansão folha→pai → orçamento',
      details: [
        'Antes da busca, o modelo reescreve a pergunta em variantes no vocabulário de edital ("quem pode propor?" → "são elegíveis…"); a pergunta e cada variante rodam as duas buscas (termos exatos e similaridade semântica) e todas as listas são fundidas por Reciprocal Rank Fusion. Identificadores exatos da pergunta (item 6.5.5, datas, valores) ganham bônus.',
        'Roteamento por documento (workspace com vários editais): quando a pergunta nomeia um edital ("no edital de Tecnologias Digitais, …"), os trechos dele — e do aviso que o rerratifica e dos anexos com o mesmo nome — ganham bônus na fusão; quando nenhum é nomeado e há vários editais ("qual dos editais…"), cada edital principal garante uma cota mínima no top-k, para o modelo enxergar todos antes de comparar. Com um edital só, não faz nada. No corpus de teste (3 editais juntos) levou o item esperado no documento certo de 86% para 100%.',
        'Glossário derivado do documento: na ingestão, o sistema lê o próprio edital e monta o glossário dele — as definições numeradas ("2.1.4 Instituição Executora Principal: …", cujos termos irmãos do mesmo bloco viram sinônimos de busca), as siglas com o nome por extenso (Schwartz–Hearst) e as expressões "entende-se por X". Nada depende das perguntas de avaliação: o glossário é função do documento. Uma segunda camada, escrita por um LLM na ingestão para cobrir o lado do vocabulário do usuário ("receita operacional bruta" ↔ "quanto minha empresa fatura por ano"), foi implementada e medida: as 430 entradas geradas são de boa qualidade, mas nenhuma casa com a redação real das perguntas do padrão-ouro — aciona em 0 de 45, contra 21 de 45 da extração estrutural. Fica desligada, como resultado negativo registrado. O glossário escrito à mão saiu do padrão: foi montado olhando as perguntas de avaliação, então não vale como resultado.',
        'Realimentação por pseudo-relevância (Rocchio/RM3): busca uma vez, tira dos melhores trechos os termos mais discriminativos por tf-idf e busca de novo com eles. Fecha a lacuna de vocabulário sem lista nenhuma e sem chamar modelo — não há artefato que possa ter sido ajustado ao conjunto de teste. Sozinha piora (query drift); junto com a expansão, melhora o pior caso.',
        'O k do RRF é pequeno de propósito: com k = 60 (valor clássico) conta mais em quantas listas o trecho apareceu do que a posição, e as listas das variantes diluíam o que a pergunta original já achava; com k = 1 o topo de cada lista domina.',
        'Quando duas folhas do mesmo item são selecionadas, a seção inteira substitui as duas (contexto coeso). Retificações vão primeiro no prompt.',
        'Se nenhum trecho contém os termos da pergunta, o modelo é avisado de que os trechos vieram só por similaridade.',
      ],
      params: [
        ['modo', c.retrieval.mode],
        ['variantes da pergunta', c.retrieval.queryExpansion > 0 ? String(c.retrieval.queryExpansion) : 'desligada'],
        ['glossário do documento', onOff(c.retrieval.docGlossary)],
        ['glossário por LLM na ingestão', onOff(c.retrieval.llmGlossary)],
        ['realimentação (PRF)', onOff(c.retrieval.prf)],
        ['roteamento por documento', onOff(c.retrieval.documentRouting)],
        ['reranker', rerankLabel(c.retrieval.rerank)],
        ['candidatos por índice', String(c.retrieval.candidates)],
        ['RRF k', String(c.retrieval.rrfK)],
        ['top-k', String(c.retrieval.topK)],
        ['expansão para o pai', c.retrieval.expandToParent ? 'sim' : 'não'],
        ['orçamento', `${fmt(c.retrieval.contextBudgetChars)} chars`],
      ],
      code: ['apps/api/src/llm/expand.ts', 'apps/api/src/ingest/glossary-extract.ts', 'apps/api/src/ingest/glossary-llm.ts', 'apps/api/src/retrieval/prf.ts', 'apps/api/src/retrieval/routing.ts', 'apps/api/src/retrieval/hybrid.ts'],
    },
    {
      id: 'prompt',
      lane: 'resposta',
      title: 'Prompt',
      summary: 'Trechos rotulados + regras: citar, copiar valores, abster-se, responder todas as leituras',
      details: [
        'Cada trecho vai entre tags <chunk id="c_…" doc="…" secao="…" pagina="…" versao="…">. As instruções exigem rótulo após cada afirmação, cópia literal de valores e datas e abstenção ("Não consta nos documentos selecionados.") quando a informação não está nos trechos.',
        'A partir do qa.v3: se a pergunta admite mais de uma leitura dentro do mesmo edital (prazo de envio × de execução, arranjo simples × em rede), o modelo responde TODAS as leituras, cada uma com sua citação, em vez de perguntar. A pergunta de esclarecimento ficou restrita à ambiguidade de escopo — mais de um edital no contexto, ou termo que os trechos não permitem identificar.',
        'A partir do qa.v4: antes de enviar, o modelo revisa a própria resposta contra os trechos — toda afirmação tem rótulo, todo rótulo existe no contexto, todo valor está copiado literalmente do trecho citado — e corrige o que falhar. O gate continua conferindo depois; a revisão reduz o que ele precisa ajustar.',
        'No baseline de documento inteiro, o canonical.md vai completo e as citações usam as âncoras de seção [sec-…].',
      ],
      params: [['versão', c.generation.promptVersion], ['RAG', c.generation.promptVersion], ['doc. inteiro', c.generation.promptVersion.replace(/^qa\./, 'baseline.')], ['texto completo', 'abaixo']],
      code: ['apps/api/src/llm/prompts/', 'apps/api/src/llm/answer.ts'],
    },
    {
      id: 'llm',
      lane: 'resposta',
      title: 'LLM',
      summary: 'Provedor da sessão: CLI do Claude Code, chave própria (BYOK) ou Ollama local, com provedor reserva',
      details: [
        'A geração usa o provedor escolhido na sessão: o CLI do Claude Code local (assinatura, sem chave), uma chave própria (BYOK, enviada a cada pergunta e nunca gravada) ou um Ollama local. Nos provedores que aceitam o parâmetro, a temperatura vai em 0 para reprodutibilidade; com Anthropic e com o CLI do Claude Code ela não é enviada e vale o padrão do provedor.',
        'Se o provedor principal falhar (limite de uso, indisponibilidade, timeout), a resposta é gerada pelo provedor reserva e o usuário é avisado.',
      ],
      params: [['principal', providerLabel], ['reserva', fallbackLabel], ['temperatura', temperatureLabel], ['timeout', '120 s']],
      code: ['apps/api/src/llm/providers.ts', 'apps/api/src/llm/answer.ts'],
      status: llm ? 'ok' : 'off',
    },
    {
      id: 'search',
      lane: 'resposta',
      title: 'Busca extra (think)',
      summary: 'Se os trechos não bastam, o modelo pede <buscar>termos</buscar> e a busca roda de novo — até 2 rodadas',
      details: [
        'No modo think o prompt autoriza o modelo a NÃO responder ainda: se faltar o item certo, um valor ou uma condição, ele devolve só linhas <buscar>termos</buscar> (até 3), com as palavras que procuraria no edital.',
        'Cada pedido vira uma busca híbrida sem expansão (top-6); os trechos que ainda não estavam no contexto entram, e o modelo gera de novo com o contexto ampliado. No máximo 2 rodadas; depois ele responde com o que há.',
        'Mira os erros de recuperação (a pergunta usa um vocabulário e o edital outro). Custa latência só quando é acionado: na avaliação, 4 de 45 perguntas.',
      ],
      params: [['ligado', c.generation.extraSearch ? 'sim' : 'só no modo think'], ['rodadas', '2'], ['buscas por rodada', 'até 3'], ['top-k da busca extra', '6'], ['limite de contexto extra', '10.000 chars']],
      code: ['apps/api/src/llm/answer.ts'],
    },
    {
      id: 'citations',
      lane: 'resposta',
      title: 'Validação de citações',
      summary: 'Cada rótulo citado é conferido contra os trechos enviados',
      details: [
        'Aceita qualquer forma que o modelo escreva ([c_1], 【c_1】, (c_1), c_1 solto…) e normaliza para [c_1]. Rótulos que não existem no contexto são removidos e contados.',
        'Para cada citação válida, o servidor localiza a sentença do trecho mais parecida com a afirmação (quote), a página e as caixas para o destaque no PDF.',
      ],
      params: [['rótulos', 'c_xxxxxx (RAG) · sec-… (baseline)'], ['inválidos', 'removidos + métrica']],
      code: ['packages/shared/src/labels.ts', 'apps/api/src/llm/citations.ts'],
    },
    {
      id: 'grounding',
      lane: 'resposta',
      title: 'Gate de fundamentação',
      summary: 'Sem referência, não aparece: blocos sem citação e valores não conferidos saem',
      details: [
        'A resposta é dividida em blocos (parágrafo, item de lista, tabela). Cada bloco factual precisa de citação válida; datas, valores, percentuais, horários e números de item precisam constar dos trechos citados.',
        'Antes de cortar, o modelo recebe uma rodada de reparo listando exatamente o que falhou. O que continuar sem referência é omitido e o usuário vê o aviso.',
        'O desfecho vira um status: com referência, parcial, esclarecimento, não consta ou sem referência.',
      ],
      params: [['política', c.generation.grounding], ['rodadas de reparo', String(c.generation.maxRepairs)], ['verificação de valores', 'datas · R$ · % · horários · itens · números']],
      code: ['apps/api/src/llm/grounding.ts'],
    },
    {
      id: 'ui',
      lane: 'resposta',
      title: 'Resposta + referências',
      summary: 'Pílulas [1] [2] que abrem o PDF na página citada com o trecho destacado',
      details: [
        'Cada citação vira uma pílula clicável: abre o PDF por cima do chat na página citada, com a caixa do trecho destacada e a sentença citada em evidência.',
        'Abaixo da resposta ficam o desfecho do gate (afirmações conferidas), o tempo total com o tempo de cada etapa, e os trechos usados.',
        'A conversa é gravada com as citações, o status, os tempos e o relatório do gate, para reabrir depois e para os experimentos.',
      ],
      params: [['painéis', 'Fontes · Chat · Visor de PDF (modal)']],
      code: ['apps/web/src/components/chat/AssistantMessage.tsx', 'apps/web/src/components/pdf/PdfDialog.tsx'],
    },

    {
      id: 'arms',
      lane: 'avaliacao',
      title: 'Braços de arquitetura',
      summary: 'Escada: documento inteiro · vetorial · BM25 · híbrido · só folhas · + expansão · + gate (algoritmo próprio) · + busca extra (think)',
      details: [
'Os braços formam uma escada lida por pares, e cada par difere em um componente só: documento inteiro vs RAG híbrido sem gate mede a recuperação (os dois com o gate apenas observando); RAG vetorial e RAG léxico BM25, cada um contra o híbrido, medem a fusão RRF; híbrido vs só folhas mede a expansão folha→pai; híbrido vs híbrido + expansão de consulta mede a reformulação da pergunta; expansão vs algoritmo próprio mede o gate de fundamentação. Documento inteiro vs algoritmo próprio muda três coisas ao mesmo tempo (recuperação, expansão e gate) e vale como comparação de ponta a ponta. Só o último braço usa o gate; nos demais ele apenas observa (política warn), então a resposta entregue é a que um RAG comum entregaria.',
        'Fora da escada ficam o algoritmo próprio no modo think (busca extra dirigida pelo modelo), o contexto reduzido (top-4) e o controle sem documento, que não é configuração válida do produto — só mede o quanto o modelo inventa sem fonte. Todos passam pelo mesmo validador de citações e pelo mesmo pontuador, então os números são comparáveis; os resultados saem no geral e por documento do dataset.',
        'Na apresentação: documento inteiro (teto), RAG vetorial (o RAG clássico), algoritmo próprio e algoritmo próprio · think, todos com o mesmo modelo, o mesmo prompt e as mesmas variantes de expansão por pergunta.',
      ],
      params: [['escada', DEFAULT_EVAL_ARMS.map((id) => EVAL_ARMS[id].short).join(' → ')], ['fora da escada', EVAL_ARM_IDS.filter((id) => !DEFAULT_EVAL_ARMS.includes(id)).map((id) => EVAL_ARMS[id].short).join(' · ')]],
      code: ['packages/shared/src/eval.ts', 'apps/api/src/eval/runner.ts'],
    },
    {
      id: 'metrics',
      lane: 'avaliacao',
      title: 'Métricas',
      summary: 'Acurácia, abstenção, item recuperado, respostas referenciadas, informação sem referência, latência e tokens',
      details: [
        'Acurácia: a resposta traz todos os valores esperados do padrão-ouro (datas, R$, %, prazos, termos), comparados por forma canônica; nas 2 perguntas sem resposta no edital, correto = abster-se. Abstenção indevida: disse "não consta" quando constava.',
        'Recuperação: o item esperado entrou no contexto (só RAG). Fundamentação: respostas totalmente referenciadas (o modelo citou tudo e os valores constam dos trechos citados) e informação sem referência ou inválida — a mesma conta em todos os braços; sem gate ela é entregue ao usuário, com gate o sistema ajusta antes.',
        'Custo: latência média (com a subida do CLI destacada) e tokens por resposta.',
      ],
      params: [['padrão-ouro', '45 perguntas = 15 × 3 editais, 5 temas, 2 sem resposta'], ['pontuação', 'automática (valores conferidos no texto); a resposta de referência serve à revisão manual']],
      code: ['apps/api/src/eval/'],
    },
    {
      id: 'results',
      lane: 'avaliacao',
      title: 'Resultados',
      summary: 'Tabela e gráficos comparando as execuções',
      details: ['Cada execução do harness gera um arquivo JSON com as respostas e as métricas agregadas; a tela de Resultados compara execuções lado a lado.'],
      params: [['saída', 'data/eval/runs/*.json'], ['tela', '/resultados']],
      code: ['apps/web/src/pages/ResultsPage.tsx'],
    },
  ];
}
