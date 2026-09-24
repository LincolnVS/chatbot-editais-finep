# Editais RAG

Chatbot com RAG para perguntas sobre editais de fomento à inovação da FINEP. Cada resposta vem com citações verificáveis: o item, a seção e a página, e o trecho destacado no PDF.

Projeto desenvolvido como Trabalho de Conclusão de Curso da Especialização em Processamento de Linguagem Natural (Instituto de Informática da UFG / Centro de Competência Embrapii em Tecnologias Imersivas, AKCIT), 2026, por Antonio de Sousa Cruz Neto, Brian Danilo de Souza Albernaz e Lincoln Vinicius Schreiber.

## O que o sistema faz

- Ingere os PDFs de um edital (edital principal, avisos de rerratificação e anexos), reconstrói a hierarquia de seções, itens e tabelas e indexa os trechos para busca léxica e vetorial.
- Responde em chat com base apenas nos documentos selecionados. Toda afirmação precisa de citação válida; quando a informação não está nos documentos, o sistema responde "Não consta nos documentos selecionados".
- Cada citação abre o PDF na página correspondente, com o trecho destacado.
- Inclui um harness de avaliação que roda as configurações comparadas sobre um padrão-ouro e mostra os resultados na interface.

## Arquitetura

```
INGESTÃO (uma vez por documento)
PDF ─► deduplicação por SHA-256
    ─► Docling: blocos com rótulo, página e coordenadas
    ─► normalização: hierarquia de seções/itens, numeração, tabelas partidas, cabeçalho/rodapé
    ─► chunking hierárquico: itens, alíneas, seções e tabelas (até 1.600 caracteres)
    ─► rótulo curto por trecho (c_xxxxxx), usado nas citações
    ─► embeddings multilingual-e5-base q8 (768 dimensões, CPU local, Transformers.js)
    ─► glossário extraído do próprio edital (definições numeradas, siglas, "entende-se por")
    ─► SQLite único: documentos + FTS5/BM25 + sqlite-vec

RESPOSTA (configuração híbrida)
pergunta + histórico + escopo
    ─► expansão de consulta: 4 reformulações pelo LLM + formas equivalentes do glossário do edital
    ─► BM25 + busca vetorial (30 candidatos por índice, para a pergunta e cada variante)
    ─► Reciprocal Rank Fusion (k = 1) + bônus para trechos com identificadores da pergunta (item, data, valor)
    ─► 12 trechos; dois ou mais da mesma seção viram a seção inteira (orçamento de 28 mil caracteres)
    ─► roteamento por documento quando há vários editais no acervo
    ─► LLM com regras de fundamentação ─► validação das citações
    ─► gate de fundamentação: confere, bloco a bloco, citação válida e valores presentes no trecho
         falhou → 1 rodada de reparo → o que continuar sem suporte é retirado
    ─► resposta com referências clicáveis
```

Na **configuração com busca adicional**, o modelo recebe os mesmos trechos e pode pedir até 3 buscas próprias por rodada, com até 6 trechos cada e até 10 mil caracteres extras, em no máximo 2 rodadas.

### Configurações comparadas

| Configuração | Id no harness | O que faz |
|---|---|---|
| Documento inteiro | `full_context` | Edital e anexos completos no contexto, sem recuperação. O gate só mede. |
| RAG vetorial | `rag_dense` | 12 trechos mais parecidos por cosseno, com expansão folha→pai. Sem BM25, sem expansão, sem glossário. |
| Configuração híbrida | `rag_hybrid` | Busca híbrida, expansão de consulta, glossário do edital, RRF com bônus de identificadores e gate com reparo. |
| Configuração com busca adicional | `rag_search` | O anterior, mais as buscas adicionais pedidas pelo modelo. |

O código mantém opções testadas durante o desenvolvimento e desligadas nas quatro configurações avaliadas: reranqueamento com cross-encoder, expansão por pseudo-relevância (PRF), glossário escrito à mão, glossário gerado por LLM e glossário compartilhado entre editais. O harness também tem configurações intermediárias, usadas para comparar os componentes um a um (`rag_bm25`, `rag_leaves`, `rag_no_gate`, `rag_expand`, `rag_top4`), e um controle sem documento (`closed_book`). Nenhuma delas entra nos resultados publicados, exceto as variações de glossário medidas no laboratório de recuperação (`npm run eval:retrieval`).

## Resultados

45 perguntas sobre 3 editais, 4 configurações, 2 modelos (Claude Sonnet 5 e Claude Haiku 4.5) e 3 repetições: 1.080 respostas. Média das repetições:

| Configuração | Sonnet: sem ref. | Sonnet: com ref. | Haiku: sem ref. | Haiku: com ref. | Tokens/pergunta (Sonnet) |
|---|---:|---:|---:|---:|---:|
| Documento inteiro | 98% | 72% | 90% | 58% | 26,4k |
| RAG vetorial | 79% | 46% | 72% | 52% | 8,4k |
| Configuração híbrida | 90% | 87% | 89% | 86% | 17,2k |
| Configuração com busca adicional | 98% | 93% | 92% | 92% | 24,3k |

- **Acurácia sem referência:** a resposta contém os valores esperados e não afirma nada errado, mesmo sem citar.
- **Acurácia com referência:** está certa e cada afirmação está apoiada em um trecho citado.

Na acurácia com referência, as configurações propostas ficam bem acima do documento inteiro com os dois modelos, usando menos tokens. Na acurácia sem referência, enquanto o edital cabe na janela de contexto, ler o documento inteiro acerta tanto quanto a melhor configuração proposta. As configurações propostas são mais lentas, porque cada etapa acrescenta chamadas ao modelo.

Tabelas completas, execuções e dados por resposta: [`resultados/`](resultados/README.md).

## Estrutura

```
apps/api          backend TypeScript (Hono, better-sqlite3, FTS5, sqlite-vec, Transformers.js, AI SDK)
apps/web          frontend (Vite, React, Tailwind, shadcn/ui, react-pdf)
packages/shared   tipos e schemas compartilhados
scripts/          inicialização do docling-serve e teste ponta a ponta
eval/             padrão-ouro e conferência das respostas
editais/          PDFs dos três editais avaliados (documentos públicos da FINEP)
resultados/       execuções finais da avaliação, respostas e métricas
data/             banco, uploads e modelos (gerado localmente, não versionado)
```

## Requisitos

- Node.js ≥ 24 e npm ≥ 11
- [uv](https://docs.astral.sh/uv/) para rodar o `docling-serve` com Python 3.12

## Como rodar

```bash
npm install
cp .env.example .env
npm run dev        # sobe Docling (5001), API (3000) e frontend (5173)
```

Abra http://localhost:5173. Para subir separado: `npm run dev:docling`, `npm run dev:api`, `npm run dev:web`.

O provedor de LLM é configurável por requisição (chave do próprio usuário, pela tela de configurações) ou pelo `.env`: Anthropic, OpenAI, Google, qualquer API compatível com OpenAI (Groq, GLM, Ollama, LM Studio…) ou o CLI `claude` instalado na máquina (`claude-code`). Sem configuração, a API usa o provedor `mock`.

### Variáveis de ambiente

| Variável | Default | Descrição |
|---|---|---|
| `PORT` | `3000` | porta da API |
| `DATA_DIR` | `./data` | banco, uploads, documentos processados e modelos |
| `DOCLING_URL` | `http://localhost:5001` | endereço do docling-serve |
| `EMBED_MODEL` | `e5-base-q8` | modelo de embedding local (`e5-small-q8` ou `e5-base-q8`) |
| `LLM_DEFAULT_KIND` | `mock` | `mock`, `anthropic`, `openai`, `google`, `openai-compatible` ou `claude-code` |
| `LLM_DEFAULT_BASE_URL` | — | URL base (obrigatória para `openai-compatible`) |
| `LLM_DEFAULT_MODEL` | — | modelo do provedor default |
| `LLM_DEFAULT_API_KEY` | — | chave do provedor default (fica só no servidor) |
| `CLAUDE_CLI_PATH` | — | caminho do CLI `claude`, se não estiver no PATH, ou `off` para desativar |
| `LOG_LEVEL` | `info` | nível de log |

Headers por requisição: `X-LLM-Provider`, `X-LLM-Base-URL`, `X-LLM-Model`, `X-LLM-Key`.

## Reproduzir a avaliação

1. Com o sistema no ar, crie os três editais na interface (**Novo edital**) com estes códigos e envie os PDFs de `editais/`:

   | Edital | Código | Arquivos |
   |---|---|---|
   | Subvenção Regional | `MIB-R2-SBV-REGIONAL` | `editais/subvencao-regional/` (edital, aviso de rerratificação, anexo) |
   | MIB R2 — Tecnologias Digitais | `MIB-R2-TECDIG` | `editais/mib-r2-tecnologias-digitais/` (edital, anexo 1) |
   | Agricultura Familiar para ICTs 2026 | `AGRIFAM-ICT-2026` | `editais/agricultura-familiar-icts-2026/` (edital, anexo de linhas temáticas, anexo de telas) |

2. Rode as quatro configurações sobre o padrão-ouro (`eval/nucleo.csv`, que já traz o código do edital de cada pergunta):

   ```bash
   npm run eval -- --arms full_context,rag_dense,rag_hybrid,rag_search --provider anthropic --model claude-sonnet-5 --label minha-execucao
   ```

   A chave é lida de `ANTHROPIC_API_KEY` (ou da variável indicada em `--api-key-env`). As execuções publicadas em `resultados/` usaram `--provider claude-code --model sonnet` e `--model haiku`. Outras opções: `npm run eval -- --help`.

3. A execução fica em `data/eval/runs/<id>.json` e aparece na aba **Resultados**. Para ver as execuções publicadas na interface, copie `resultados/execucoes/*.json` para `data/eval/runs/`.

A recuperação também pode ser medida sem chamar o modelo de geração: `npm run eval:retrieval` (hit@12 por configuração, reaproveitando as reformulações gravadas nas execuções).

## Testes e qualidade

```bash
npm test               # testes automatizados (Vitest)
npm run typecheck      # API, frontend e pacote compartilhado
npm run quality        # lint, tipos, testes com cobertura, duplicação e auditoria de dependências
node scripts/smoke.mjs # ponta a ponta com PDFs reais (API e Docling no ar)
```
