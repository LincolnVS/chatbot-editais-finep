# Resultados

Execuções finais da avaliação: 45 perguntas (`eval/nucleo.csv`) sobre três editais da FINEP, quatro configurações, dois modelos e três repetições completas por modelo, total de 1.080 respostas. Todas usam o mesmo prompt (`qa.v4`). Dentro de cada execução, as quatro reformulações de cada pergunta são geradas uma vez e compartilhadas entre as configurações que as usam.

## Execuções

| Arquivo (`execucoes/`) | Modelo | Repetição | Início (horário de Brasília) |
|---|---|---|---|
| `01M36542VVAFDQK9RFZ8R2PJE7.json` | Claude Sonnet 5 | 1 | 23/09/2026 00:32 |
| `01M367V5DRP1BH7H0TGAKBNPVQ.json` | Claude Sonnet 5 | 2 | 23/09/2026 01:19 |
| `01M379FMK6FQ0AZCVJ5GRMSTEF.json` | Claude Sonnet 5 | 3 | 23/09/2026 11:07 |
| `01M36545VC6CZDEKHMNR7DKKXP.json` | Claude Haiku 4.5 | 1 | 23/09/2026 00:32 |
| `01M3680RZ0SRQR854YQN9XJ166.json` | Claude Haiku 4.5 | 2 | 23/09/2026 01:22 |
| `01M377MYAYN0MRH66Z47N2NF7F.json` | Claude Haiku 4.5 | 3 | 23/09/2026 10:35 |

Os modelos foram acessados pela interface de linha de comando `claude` (provedor `claude-code` do harness), que informa a contagem de tokens de cada chamada, mas não permite fixar temperatura nem semente. A repetição 2 do Haiku foi interrompida por limite de uso e retomada com `--resume`. Antes da repetição 2, os valores esperados de seis perguntas (q03-agr, q09-agr, q10-reg, q10-tec, q13-reg e q13-tec) foram corrigidos para conferir só o que cada pergunta pede; a repetição 1 foi repontuada com o gabarito corrigido (`--rescore`), sem gerar as respostas de novo, e os casos dela ainda guardam os valores anteriores no campo `expectedValues`. A repetição 3 de cada modelo rodou em nove processos paralelos de cinco perguntas, com todas as configurações de uma pergunta no mesmo processo.

Cada arquivo traz, por pergunta e configuração, a resposta bruta e a entregue, os trechos recuperados, as reformulações, o resultado do gate, os tokens e a latência. Para abrir as execuções na aba **Resultados** da interface, copie-as para `data/eval/runs/`.

## Métricas

| Métrica | Definição |
|---|---|
| Acurácia sem referência | A resposta contém todos os valores esperados e não erra o que foi pedido, não contradiz o edital nem afirma algo que não existe nele (ver Conferência). Não exige citação. Nas duas perguntas sem resposta, o correto é abster-se. |
| Acurácia com referência | Certa pelo critério anterior e com todo bloco factual apoiado em citação válida cujos valores constam do trecho. |
| Valores esperados (automático) | Só a pontuação automática, antes da conferência. |
| Respostas totalmente referenciadas | Todo bloco factual tem citação válida, certo ou não. Se o gate precisou retirar algum bloco, a resposta conta como não referenciada. |
| Item esperado recuperado | O item de origem esperado (ou seu pai ou filho) entrou no contexto do modelo. |
| Abstenção indevida | Percentual das 43 perguntas com resposta em que o sistema disse que a informação não consta. |
| Tokens por pergunta | Entrada + saída de todas as chamadas: expansão, geração, reparo e buscas. |
| Latência média | Tempo da resposta, sem a chamada de expansão de consulta e sem a inicialização do CLI (cerca de 1,6 s por chamada). As execuções dos dois modelos rodaram em paralelo na mesma máquina; compare tempos só dentro de uma execução. |

## Claude Sonnet 5 (média das 3 repetições)

| Métrica | Doc. inteiro | RAG vetorial | Configuração híbrida | Configuração com busca adicional |
|---|---|---|---|---|
| Acurácia sem referência | 98% | 79% | 90% | 98% |
| Acurácia com referência | 72% | 46% | 87% | 93% |
| Valores esperados (automático) | 100% | 79% | 93% | 98% |
| Respostas totalmente referenciadas | 73% | 55% | 94% | 95% |
| Item esperado recuperado | - | 77% | 95% | 98% |
| Abstenção indevida | 2% | 9% | 2% | 4% |
| Tokens por pergunta | 26,4k | 8,4k | 17,2k | 24,3k |
| Latência média | 7,2 s | 6,5 s | 9,1 s | 14,5 s |

## Claude Haiku 4.5 (média das 3 repetições)

| Métrica | Doc. inteiro | RAG vetorial | Configuração híbrida | Configuração com busca adicional |
|---|---|---|---|---|
| Acurácia sem referência | 90% | 72% | 89% | 92% |
| Acurácia com referência | 58% | 52% | 86% | 92% |
| Valores esperados (automático) | 96% | 76% | 93% | 94% |
| Respostas totalmente referenciadas | 63% | 70% | 97% | 99% |
| Item esperado recuperado | - | 77% | 98% | 98% |
| Abstenção indevida | 3% | 12% | 3% | 2% |
| Tokens por pergunta | 21,4k | 7,2k | 16,9k | 19,7k |
| Latência média | 13,7 s | 12,9 s | 22,0 s | 26,6 s |

## Por repetição (sem referência / com referência)

| Modelo | Configuração | Repetição 1 | Repetição 2 | Repetição 3 | Perguntas com falha |
|---|---|---|---|---|---|
| Sonnet 5 | Doc. inteiro | 98% / 73% | 98% / 69% | 98% / 73% | 3 (0 em todas) |
| Sonnet 5 | RAG vetorial | 80% / 49% | 78% / 40% | 80% / 49% | 10 (9 em todas) |
| Sonnet 5 | Configuração híbrida | 91% / 89% | 87% / 87% | 93% / 84% | 7 (1 em todas) |
| Sonnet 5 | Configuração com busca adicional | 100% / 91% | 98% / 96% | 96% / 93% | 3 (0 em todas) |
| Haiku 4.5 | Doc. inteiro | 89% / 58% | 89% / 53% | 91% / 62% | 10 (1 em todas) |
| Haiku 4.5 | RAG vetorial | 71% / 53% | 73% / 51% | 71% / 51% | 16 (10 em todas) |
| Haiku 4.5 | Configuração híbrida | 89% / 89% | 84% / 76% | 93% / 93% | 11 (1 em todas) |
| Haiku 4.5 | Configuração com busca adicional | 91% / 91% | 87% / 87% | 98% / 98% | 8 (1 em todas) |

## Por edital (sem referência / com referência, média das repetições)

| Edital | Modelo | Doc. inteiro | RAG vetorial | Configuração híbrida | Configuração com busca adicional |
|---|---|---|---|---|---|
| Subvenção Regional | Sonnet 5 | 98% / 69% | 87% / 44% | 96% / 93% | 100% / 96% |
| MIB R2 - Tecnologias Digitais | Sonnet 5 | 98% / 80% | 80% / 47% | 84% / 82% | 96% / 91% |
| Agricultura Familiar para ICTs 2026 | Sonnet 5 | 98% / 67% | 71% / 47% | 91% / 84% | 98% / 93% |
| Subvenção Regional | Haiku 4.5 | 93% / 64% | 78% / 60% | 91% / 89% | 100% / 100% |
| MIB R2 - Tecnologias Digitais | Haiku 4.5 | 84% / 53% | 76% / 49% | 84% / 84% | 82% / 82% |
| Agricultura Familiar para ICTs 2026 | Haiku 4.5 | 91% / 56% | 62% / 47% | 91% / 84% | 93% / 93% |

## Por tema (sem referência / com referência, média das repetições)

| Tema | Modelo | Doc. inteiro | RAG vetorial | Configuração híbrida | Configuração com busca adicional |
|---|---|---|---|---|---|
| Valores | Sonnet 5 | 96% / 89% | 89% / 70% | 96% / 96% | 100% / 100% |
| Valores | Haiku 4.5 | 96% / 78% | 81% / 67% | 96% / 93% | 96% / 96% |
| Prazos | Sonnet 5 | 100% / 63% | 100% / 67% | 100% / 93% | 100% / 100% |
| Prazos | Haiku 4.5 | 100% / 93% | 96% / 89% | 100% / 100% | 100% / 100% |
| Elegibilidade | Sonnet 5 | 96% / 52% | 52% / 19% | 78% / 67% | 96% / 81% |
| Elegibilidade | Haiku 4.5 | 70% / 30% | 30% / 11% | 74% / 67% | 85% / 85% |
| Avaliação | Sonnet 5 | 100% / 89% | 78% / 52% | 85% / 85% | 96% / 96% |
| Avaliação | Haiku 4.5 | 85% / 44% | 74% / 52% | 89% / 89% | 85% / 85% |
| Documentação | Sonnet 5 | 96% / 67% | 78% / 22% | 93% / 93% | 96% / 89% |
| Documentação | Haiku 4.5 | 96% / 44% | 78% / 41% | 85% / 81% | 93% / 93% |

## Recuperação sem geração

hit@12: fração das 43 perguntas com item esperado em que esse item entra entre os 12 trechos, sem chamar o modelo de geração, reaproveitando as reformulações gravadas em 12 execuções (`npm run eval:retrieval`).

| Configuração | Expansão | hit@12 médio | Mínimo | Observação |
|---|---|---|---|---|
| Híbrida (BM25 + vetor + RRF) | Não | 88,4% | - | Sem expansão e sem glossário |
| Híbrida + glossário do edital | Não | 90,7% | - | Glossário extraído do documento na ingestão |
| Híbrida + expansão | Sim | 94,0% | 90,7% | Quatro variantes da pergunta geradas pelo modelo |
| Híbrida + expansão + glossário do edital | Sim | 96,3% | 90,7% | Configuração adotada |
| Adotada + glossário do acervo | Sim | 96,1% | 93,0% | Os três editais não compartilham termos definidos |
| Adotada + glossário gerado por LLM | Sim | 96,3% | 90,7% | Entradas escritas pelo modelo a partir do edital |
| Híbrida + expansão + glossário escrito à mão | Sim | 100,0% | 100,0% | Descartado: escrito com as perguntas à vista |

A última linha é um resultado descartado: esse glossário foi escrito com as perguntas de avaliação à vista, e todas as execuções feitas com ele ficaram fora dos resultados.

## Conferência caso a caso

As 983 respostas que o avaliador automático marcou como certas foram relidas contra o texto integral do edital, com uma regra fixada antes da leitura: a resposta passa a contar como errada se erra o que a pergunta pede, contradiz o edital ou afirma algo que não existe nele. Declarações de ausência ("Não consta nos documentos selecionados") não contam como erro. A leitura foi feita às cegas, sem identificação da configuração, com apoio de um assistente de IA; os autores verificaram uma amostra de 34 respostas sorteadas entre as 934 não apontadas, sem divergência, e decidiram cada um dos 48 casos apontados, por tipo de afirmação e para todas as configurações.

- 48 respostas apontadas: 20 aceitas e **28 contadas como erradas** (11 no documento inteiro, 5 no RAG vetorial, 9 na configuração híbrida e 3 na configuração com busca adicional).
- A conferência só retira acertos: respostas que o avaliador marcou como erradas continuam erradas.
- A lista completa, com o trecho de cada resposta, o que o edital diz e a decisão de cada caso aceito, está em [`eval/conferencia.json`](../eval/conferencia.json). Em `respostas.csv`, a coluna `erro_conferencia` traz o tipo de erro dessas 28.

## Arquivos

| Arquivo | Conteúdo |
|---|---|
| `execucoes/*.json` | As seis execuções completas, como gravadas pelo harness. |
| `respostas.csv` | As 1.080 respostas, uma linha por modelo, repetição, pergunta e configuração. |
| `metricas.csv` | Métricas de cada execução (proporções de 0 a 1), no geral (`edital` = `Todos`) e por edital, uma coluna por configuração. |
| `consolidado.json` | Médias por modelo, configuração, edital e tema, com a conferência aplicada. |
| `laboratorio-recuperacao.json` | Medições de recuperação sem geração. |

Colunas de `respostas.csv`:

| Coluna | Conteúdo |
|---|---|
| `modelo`, `repeticao` | Execução de origem. |
| `pergunta`, `edital`, `tema`, `item_esperado` | Identificação da pergunta no padrão-ouro. |
| `configuracao`, `status` | Configuração avaliada e desfecho da resposta (`answered`, `partial` ou `not_found`). |
| `valores_esperados` | Todos os valores esperados aparecem na resposta (avaliação automática). |
| `erro_conferencia` | Tipo de erro apontado na conferência (`contradiz`, `inexistente`, `erro_pedido`); vazio quando não há. |
| `correta` | Acerto sem referência, com a conferência aplicada. |
| `referenciada` | Todo bloco factual tem citação válida. |
| `correta_com_referencia` | Correta e referenciada. |
| `item_recuperado`, `citou_item` | O item esperado entrou no contexto / foi citado. |
| `tokens_entrada`, `latencia_ms` | Custo da resposta. |
| `resposta` | Texto entregue ao usuário. |
