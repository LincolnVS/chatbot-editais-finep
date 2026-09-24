# Padrão-ouro da avaliação

## Arquivos

| Arquivo | Conteúdo |
|---|---|
| `nucleo.csv` | As 45 perguntas da avaliação final: as mesmas 15 perguntas aplicadas a cada um dos três editais. |
| `conferencia.json` | Conferência caso a caso das respostas das execuções finais: respostas contadas como erradas e casos aceitos, com a justificativa de cada um. |
| `_conjunto-inicial.csv` | Conjunto inicial de 54 perguntas, diferentes para cada edital, com o qual foram tomadas as decisões de arquitetura. Foi substituído pelo núcleo por não distinguir as configurações entre si. Tem o formato anterior (sem `nivel` e `expected_answer`), e o prefixo `_` o deixa fora da lista de conjuntos da interface. |

## Colunas de `nucleo.csv`

`id`, `workspace` (código do edital), `topic` (tema), `nivel` (`direta` ou `composta`), `question`, `expected_item` (item do edital onde está a resposta), `expected_values` (valores que a resposta precisa conter, separados por `|`), `expected_answer` (resposta de referência) e `answerable` (`sim` ou `não`).

Datas, valores monetários, percentuais e números são comparados em forma canônica; termos, sem acento, sem distinção de caixa e sem diferença entre singular e plural. Nas perguntas sem resposta, a resposta correta é a abstenção.

## Rodar

```bash
npm run eval -- [--workspace <id|código|nome>] [--arms full_context,rag_dense,rag_hybrid,rag_search] [--questions nucleo.csv] [--grounding strict|warn|off] [--label "…"] [--provider <provedor> --model <modelo>]
npm run eval -- --resume <id>     # retoma uma execução interrompida
npm run eval -- --rescore <id|all> # repontua execuções gravadas sem chamar o modelo
npm run eval -- --help
```

Sem `--workspace`, cada pergunta usa o edital da coluna `workspace`. As saídas ficam em `data/eval/runs/<id>.json` e aparecem na aba **Resultados**.
