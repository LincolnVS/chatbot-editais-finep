# Sobe o docling-serve (parser de PDF) como sidecar HTTP na porta 5001.
# Primeira execução baixa o ambiente Python (~1,7 GB) — depois fica em cache do uv.
$env:PYTHONUTF8 = "1"
$env:DOCLING_SERVE_ENABLE_UI = "0"
uvx --python 3.12 docling-serve==1.32.0 run --port 5001
