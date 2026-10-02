/**
 * Servidor de desenvolvimento — Painel Feliz Casa Nova
 * 
 * Serve os arquivos estáticos do frontend e faz proxy reverso
 * das requisições /api para o backend C# (porta 5136).
 * 
 * Uso: node server.js
 * Acesse: http://localhost:8080
 * 
 * Sem dependências externas — usa apenas módulos nativos do Node.js.
 */

const http = require("http");
const urlMod = require("url");
const fs = require("fs");
const path = require("path");

const PORT = 8080;
const API_HOST = "localhost";
const API_PORT = 5000; // Altere para 5136 se o backend estiver nessa porta

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png":  "image/png",
  ".ico":  "image/x-icon",
  ".svg":  "image/svg+xml",
  ".txt":  "text/plain; charset=utf-8",
};

/* ---------------------------------------------------------------- 
   Servir arquivos estáticos
   ---------------------------------------------------------------- */
function serveFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // Tenta 404.html
      const four04 = path.join(__dirname, "404.html");
      fs.readFile(four04, (err2, data2) => {
        if (err2) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("404 — Página não encontrada");
          return;
        }
        res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
        res.end(data2);
      });
      return;
    }
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  });
}

/* ---------------------------------------------------------------- 
   Proxy reverso — encaminha /api/* para o backend C# (porta 5136)
   Usa http.request para comunicação direta com o backend.
   ---------------------------------------------------------------- */
function proxyRequest(clientReq, clientRes, targetPath) {
  // Coleta o corpo da requisição original
  const bodyChunks = [];
  clientReq.on("data", (chunk) => bodyChunks.push(chunk));
  clientReq.on("end", () => {
    const body = Buffer.concat(bodyChunks);

    // Prepara headers para encaminhar
    const headers = {};
    const skipHeaders = ["host", "connection", "transfer-encoding", "accept-encoding"];
    for (const [k, v] of Object.entries(clientReq.headers)) {
      if (!skipHeaders.includes(k.toLowerCase())) {
        headers[k] = String(v);
      }
    }
    headers["host"] = API_HOST + ":" + API_PORT;
    headers["content-length"] = String(body.length);

    const options = {
      hostname: API_HOST,
      port: API_PORT,
      path: targetPath,
      method: clientReq.method,
      headers: headers,
    };

    const proxyReq = http.request(options, (proxyRes) => {
      // Coleta a resposta do backend
      const respChunks = [];
      proxyRes.on("data", (chunk) => respChunks.push(chunk));
      proxyRes.on("end", () => {
        const respBody = Buffer.concat(respChunks);

        // Monta headers da resposta
        const respHeaders = {};
        const skipRespHeaders = ["transfer-encoding", "connection", "keep-alive"];
        for (const [k, v] of Object.entries(proxyRes.headers)) {
          if (!skipRespHeaders.includes(k.toLowerCase())) {
            respHeaders[k] = Array.isArray(v) ? v.join(", ") : String(v);
          }
        }
        // Garante CORS para o browser
        respHeaders["access-control-allow-origin"] = "*";

        clientRes.writeHead(proxyRes.statusCode, respHeaders);
        clientRes.end(respBody);
      });
      proxyRes.on("error", (err) => {
        console.error("Proxy response error:", err.message);
        clientRes.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
        clientRes.end(JSON.stringify({ detail: "Erro na resposta do backend" }));
      });
    });

    proxyReq.on("error", (err) => {
      console.error("Proxy request error:", err.message);
      clientRes.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
      clientRes.end(JSON.stringify({
        detail: "Falha ao conectar com o backend C#",
        error: err.message,
        hint: "Confirme se a API está rodando em http://" + API_HOST + ":" + API_PORT,
      }));
    });

    // Envia body para o backend
    proxyReq.write(body);
    proxyReq.end();
  });
}

/* ---------------------------------------------------------------- 
   Servidor HTTP principal
   ---------------------------------------------------------------- */
const server = http.createServer((req, res) => {
  const parsedUrl = new urlMod.URL(req.url, "http://localhost:" + PORT);
  const reqPath = parsedUrl.pathname;

  console.log(req.method + " " + reqPath);

  // Proxy reverso para /api
  if (reqPath === "/api" || reqPath.startsWith("/api/")) {
    proxyRequest(req, res, reqPath);
    return;
  }

  // Arquivos estáticos
  const filePath = (reqPath === "/" || reqPath === "")
    ? path.join(__dirname, "index.html")
    : path.join(__dirname, reqPath);

  serveFile(res, filePath);
});

// ──────────────────────────────────────────────────────────────
//  Inicialização
// ──────────────────────────────────────────────────────────────
server.listen(PORT, "0.0.0.0", () => {
  console.log("");
  console.log("  ╔══════════════════════════════════════════════════╗");
  console.log("  ║   Painel Feliz Casa Nova — Servidor de Dev      ║");
  console.log("  ║                                                  ║");
  console.log("  ║   Frontend: http://localhost:" + String(PORT) + "                   ║");
  console.log("  ║   API:      http://localhost:" + String(PORT) + "/api               ║");
  console.log("  ║   Backend:  http://" + API_HOST + ":" + String(API_PORT) + "                  ║");
  console.log("  ║                                                  ║");
  console.log("  ║   Pressione Ctrl+C para parar                   ║");
  console.log("  ╚══════════════════════════════════════════════════╝");
  console.log("");
});