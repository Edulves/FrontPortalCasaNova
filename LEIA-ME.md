# Painel de Vendas — Feliz Casa Nova

Interface do SaaS (HTML/CSS/JS). Exige login JWT e API.

## Uso

1. Na raiz: `docker compose up --build` (Postgres e API em http://localhost:8000).
2. O nginx que publica esta pasta fica fora do repositório e deve encaminhar `/api` para a API.

## De onde vêm os dados

| Fonte | Como |
|---|---|
| **Banco (Postgres)** | Fonte da verdade — edições no painel gravam na API |
| **Planilha Google** | Publicar aba como CSV → cadastrar em Dados & config → “Atualizar” (sync no servidor) |
| **Backup JSON** | Botão “Baixar dados.json” — só snapshot; não é o banco |

Não há mais `dados.json` no repositório. Instalação limpa: bootstrap cria org/admin/polos; vendas entram pela planilha ou pelo formulário.

## Arquivos

| Arquivo | Função |
|---|---|
| `index.html` | Shell + login |
| `api.js` | Cliente JWT/fetch |
| `app.js` | UI |
| `styles.css` | Visual |
| `chart.umd.js` | Gráficos |
