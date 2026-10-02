/**
 * Configuração do Frontend - Painel Feliz Casa Nova
 * 
 * Este arquivo define configurações globais para o frontend,
 * incluindo a URL base da API do backend.
 * 
 * ───────────────────────────────────────────────────────────
 *  COMO ACESSAR O PAINEL
 * ───────────────────────────────────────────────────────────
 * 
 * 1. SERVER.JS (RECOMENDADO) — Resolve CORS automaticamente
 *    Execute na pasta frontend: node server.js
 *    Acesse: http://localhost:8080
 *    A API fica em http://localhost:8080/api (proxy reverso)
 *    NÃO precisa configurar CORS, pois frontend e API estão
 *    no mesmo domínio.
 * 
 * 2. NGINX / APACHE — Proxy reverso
 *    Configure o proxy para encaminhar /api para o backend.
 *    Exemplo nginx:
 *      location /api {
 *          proxy_pass http://localhost:5136;
 *      }
 *    Acesse: http://localhost (ou domínio configurado)
 * 
 * 3. DIRETO (SEM PROXY) — Requer CORS
 *    Descomente a linha com URL absoluta abaixo.
 *    O backend já permite as origens configuradas em
 *    CORS_ORIGINS no appsettings.json (inclui localhost:8080,
 *    localhost:3000, localhost:5173, etc.)
 */

// ─── Opção A (recomendada): caminho relativo ──────────────
// Funciona com server.js (proxy reverso) ou nginx.
// O apêndice "/api" é adicionado automaticamente aos endpoints.
// window.FCN_API_BASE = '/api';

// ─── Opção B: URL absoluta (para acesso direto sem proxy) ─
// Descomente a linha abaixo e comente a Opção A se quiser
// acessar o backend diretamente (exige CORS configurado).
window.FCN_API_BASE = 'https:/felizcasanovaapi.foxheart.com.br/api';
