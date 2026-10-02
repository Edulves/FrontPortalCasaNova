/* API client — Painel Feliz Casa Nova (JWT + fetch) */
(function (global) {
  "use strict";

  var TOKEN_KEY = "fcn_access_token";
  var REFRESH_KEY = "fcn_refresh_token";
  var SESSION_KEY = "fcn_session";

  function apiBase() {
    // Mesmo host via nginx proxy, ou override
    if (global.FCN_API_BASE) return global.FCN_API_BASE;
    return "/api";
  }

  function getAccess() {
    try {
      return localStorage.getItem(TOKEN_KEY) || "";
    } catch (e) {
      return "";
    }
  }

  function getRefresh() {
    try {
      return localStorage.getItem(REFRESH_KEY) || "";
    } catch (e) {
      return "";
    }
  }

  function getSession() {
    try {
      var raw = localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function setSession(session) {
    try {
      if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      else localStorage.removeItem(SESSION_KEY);
    } catch (e) {}
  }

  function setTokens(access, refresh) {
    localStorage.setItem(TOKEN_KEY, access || "");
    if (refresh) localStorage.setItem(REFRESH_KEY, refresh);
  }

  function clearTokens() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_KEY);
    localStorage.removeItem(SESSION_KEY);
  }

  function isLoggedIn() {
    return !!getAccess();
  }

  function canWrite() {
    var s = getSession();
    return !!(s && s.pode_escrever);
  }

  function canAdmin() {
    var s = getSession();
    return !!(s && s.pode_administrar);
  }

  function request(path, options) {
    options = options || {};
    var headers = Object.assign({ Accept: "application/json" }, options.headers || {});
    if (!(options.body instanceof FormData) && headers["Content-Type"] !== undefined) {
      headers["Content-Type"] = headers["Content-Type"] || "application/json";
    }
    if (!options.body || typeof options.body === "string") {
      if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
    }
    if (headers["Content-Type"] === undefined) delete headers["Content-Type"];
    var token = getAccess();
    if (token) headers.Authorization = "Bearer " + token;

    return fetch(apiBase() + path, Object.assign({}, options, { headers: headers })).then(
      function (res) {
        if (res.status === 401 && getRefresh()) {
          return refreshToken().then(function (ok) {
            if (!ok) throw new Error("Sessão expirada");
            headers.Authorization = "Bearer " + getAccess();
            return fetch(apiBase() + path, Object.assign({}, options, { headers: headers }));
          });
        }
        return res;
      }
    ).then(function (res) {
      if (!res.ok) {
        return res.json().catch(function () {
          return {};
        }).then(function (body) {
          var msg =
            body.message ||
            (typeof body.detail === "string" ? body.detail : null) ||
            body.erro ||
            res.statusText ||
            "Erro na API";
          if (typeof msg === "object") msg = JSON.stringify(msg);
          if (res.status === 429) msg = msg || "Muitas tentativas. Aguarde um momento.";
          if (res.status === 403) msg = msg || "Sem permissão para esta ação.";
          var err = new Error(msg);
          err.status = res.status;
          err.code = body.code || null;
          throw err;
        });
      }
      if (res.status === 204) return null;
      return res.json();
    });
  }

  function refreshToken() {
    return fetch(apiBase() + "/auth/token/refresh/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh: getRefresh() }),
    })
      .then(function (r) {
        if (!r.ok) {
          clearTokens();
          return false;
        }
        return r.json().then(function (data) {
          setTokens(data.access, getRefresh());
          return true;
        });
      })
      .catch(function () {
        clearTokens();
        return false;
      });
  }

  function login(username, password) {
    return fetch(apiBase() + "/auth/token/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: username, password: password }),
    }).then(function (r) {
      return r.json().then(function (data) {
        if (!r.ok) throw new Error(data.detail || "Falha no login");
        setTokens(data.access, data.refresh);
        setSession({
          username: data.username || username,
          papel: data.papel || "operador",
          organizacao_id: data.organizacao_id,
          organizacao_nome: data.organizacao_nome,
          pode_escrever: data.pode_escrever !== false && data.papel !== "visualizador",
          pode_administrar: !!data.pode_administrar || data.papel === "admin",
        });
        return data;
      });
    });
  }

  function getMe() {
    return request("/me/").then(function (me) {
      setSession({
        username: me.username,
        papel: me.papel,
        organizacao_id: me.organizacao_id,
        organizacao_nome: me.organizacao_nome,
        pode_escrever: !!me.pode_escrever,
        pode_administrar: !!me.pode_administrar,
      });
      return me;
    });
  }

  function requestPasswordReset(payload) {
    return fetch(apiBase() + "/auth/password-reset/", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload || {}),
    }).then(function (r) {
      return r.json().then(function (data) {
        if (!r.ok) throw new Error(data.message || data.detail || "Falha ao pedir reset");
        return data;
      });
    });
  }

  function confirmPasswordReset(payload) {
    return fetch(apiBase() + "/auth/password-reset/confirm/", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload || {}),
    }).then(function (r) {
      return r.json().then(function (data) {
        if (!r.ok) throw new Error(data.message || data.detail || "Falha ao redefinir senha");
        return data;
      });
    });
  }

  function listUsuarios() {
    return request("/usuarios/");
  }

  function inviteUsuario(payload) {
    return request("/usuarios/", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  function logout() {
    clearTokens();
  }

  function loadEstado() {
    return request("/estado/");
  }

  function getResumo() {
    return request("/resumo/");
  }

  function getAlertas() {
    return request("/alertas/");
  }

  function saveVenda(payload, id) {
    // Adapta o payload do frontend para o formato esperado pelo backend C#
    // Frontend envia: { mes: "2026-10", cliente: "...", valor: ..., dataAssinatura: "...", ... }
    // Backend espera: { mes: 10, ano: 2026, cliente: "...", valor: ..., assinada: bool, ... }
    var adapted = Object.assign({}, payload);

    // Extrai mês e ano do campo "mes" (formato "YYYY-MM") e converte para inteiros
    if (adapted.mes && typeof adapted.mes === "string" && /^\d{4}-\d{2}$/.test(adapted.mes)) {
      var partes = adapted.mes.split("-");
      adapted.ano = parseInt(partes[0], 10);
      adapted.mes = parseInt(partes[1], 10);
    } else if (adapted.mes && typeof adapted.mes === "string") {
      adapted.ano = adapted.ano || new Date().getFullYear();
      adapted.mes = parseInt(adapted.mes, 10);
    } else {
      adapted.ano = adapted.ano || new Date().getFullYear();
      adapted.mes = adapted.mes || (new Date().getMonth() + 1);
    }

    // Converte dataAssinatura para booleano "assinada"
    if (adapted.dataAssinatura && adapted.dataAssinatura.length >= 7) {
      adapted.assinada = true;
    } else if (adapted.assinada === undefined) {
      adapted.assinada = false;
    }

    // Converte todos os nomes de campos para PascalCase (formato que o backend C# espera)
    // Mês/ano
    if (adapted.ano !== undefined || adapted.Ano === undefined)
      adapted.Ano = adapted.ano !== undefined ? adapted.ano : new Date().getFullYear();
    if (adapted.mes !== undefined || adapted.Mes === undefined)
      adapted.Mes = adapted.mes !== undefined ? adapted.mes : (new Date().getMonth() + 1);
    delete adapted.ano;
    delete adapted.mes;

    // Dados da venda — converte camelCase → PascalCase (atribuição direta, sem ||)
    if ("cliente" in adapted) adapted.Cliente = adapted.cliente;
    if ("numero" in adapted) adapted.Numero = adapted.numero;
    if ("telefone" in adapted) adapted.Telefone = adapted.telefone;
    if ("construtora" in adapted) adapted.Construtora = adapted.construtora;
    if ("produto" in adapted) adapted.Produto = adapted.produto;
    if ("blocoQuadra" in adapted || "bloco_quadra" in adapted)
      adapted.BlocoQuadra = adapted.blocoQuadra !== undefined ? adapted.blocoQuadra : adapted.bloco_quadra;
    if ("unidade" in adapted) adapted.Unidade = adapted.unidade;
    if ("valor" in adapted) adapted.Valor = adapted.valor;
    if ("percentual" in adapted) adapted.Percentual = adapted.percentual;
    if ("comissao" in adapted) adapted.Comissao = adapted.comissao;
    if ("corretor" in adapted) adapted.Corretor = adapted.corretor;
    if ("origem" in adapted) adapted.Origem = adapted.origem;
    if ("financiado" in adapted) adapted.Financiado = adapted.financiado;
    if ("regiao_id" in adapted || "empreendimento_id" in adapted)
      adapted.RegiaoId = adapted.regiao_id !== undefined ? adapted.regiao_id : adapted.empreendimento_id || 0;
    if ("assinada" in adapted) adapted.Assinada = adapted.assinada;
    if ("dataAssinatura" in adapted) adapted.DataAssinatura = adapted.dataAssinatura;
    if ("dataEntrada" in adapted) adapted.DataEntrada = adapted.dataEntrada;

    // Remove campos com nome antigo (camelCase / snake_case)
    delete adapted.cliente;
    delete adapted.numero;
    delete adapted.telefone;
    delete adapted.construtora;
    delete adapted.produto;
    delete adapted.unidade;
    delete adapted.valor;
    delete adapted.percentual;
    delete adapted.comissao;
    delete adapted.corretor;
    delete adapted.origem;
    delete adapted.financiado;
    delete adapted.regiao_id;
    delete adapted.empreendimento_id;
    delete adapted.assinada;
    delete adapted.dataAssinatura;
    delete adapted.dataEntrada;
    delete adapted.bloco_quadra;
    delete adapted.blocoQuadra;
    delete adapted.empreendimento;
    delete adapted.id;

    if (id) {
      return request("/vendas/" + id + "/", {
        method: "PATCH",
        body: JSON.stringify(adapted),
      });
    }
    return request("/vendas/", { method: "POST", body: JSON.stringify(adapted) });
  }

  function deleteVenda(id) {
    return request("/vendas/" + id + "/", { method: "DELETE" });
  }

  function savePerdida(payload, id) {
    if (id) {
      return request("/vendas-perdidas/" + id + "/", {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
    }
    return request("/vendas-perdidas/", { method: "POST", body: JSON.stringify(payload) });
  }

  function deletePerdida(id) {
    return request("/vendas-perdidas/" + id + "/", { method: "DELETE" });
  }

  function patchConfig(payload) {
    // Aceita camelCase do painel ou snake_case da API
    var body = {
      alerta_dias_sem_assinatura:
        payload.alerta_dias_sem_assinatura != null
          ? payload.alerta_dias_sem_assinatura
          : payload.alertaDiasSemAssinatura,
      campos_obrigatorios:
        payload.campos_obrigatorios != null
          ? payload.campos_obrigatorios
          : payload.camposObrigatorios,
      logo_data_url:
        payload.logo_data_url != null ? payload.logo_data_url : payload.logoDataUrl,
    };
    Object.keys(body).forEach(function (k) {
      if (body[k] === undefined) delete body[k];
    });
    return request("/config/", { method: "PATCH", body: JSON.stringify(body) });
  }

  function listEmpreendimentos() {
    return request("/regioes/");
  }

  function createEmpreendimento(nome, slug) {
    return request("/regioes/", {
      method: "POST",
      body: JSON.stringify({ nome: nome, slug: slug }),
    });
  }

  /** Aliases novos — mesmo contrato */
  function listRegioes() {
    return listEmpreendimentos();
  }

  function createRegiao(nome, slug) {
    return createEmpreendimento(nome, slug);
  }

  function syncFontes() {
    return request("/importacoes-csv/executar-todas/", { method: "POST", body: "{}" });
  }

  function syncFonte(id) {
    return request("/importacoes-csv/" + id + "/executar/", { method: "POST", body: "{}" });
  }

  function createFonte(payload) {
    return request("/importacoes-csv/", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  function deleteFonte(id) {
    return request("/importacoes-csv/" + id + "/", { method: "DELETE" });
  }

  function importarArquivo(file, regiaoId, substituir) {
    var body = new FormData();
    body.append("arquivo", file);
    if (regiaoId) body.append("regiao_id", String(regiaoId));
    if (substituir) body.append("substituir", "true");
    return request("/importacoes-csv/arquivo/", {
      method: "POST",
      body: body,
      headers: { "Content-Type": undefined },
    });
  }

  function atribuirRegiao(regiaoId, ids) {
    var body = { regiao_id: regiaoId };
    if (ids && ids.length) body.ids = ids;
    return request("/importacoes-csv/atribuir-regiao/", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  function limparVendas(regiaoId) {
    return request("/importacoes-csv/limpar/", {
      method: "POST",
      body: JSON.stringify(regiaoId ? { regiao_id: regiaoId } : {}),
    });
  }

  global.FCNApi = {
    isLoggedIn: isLoggedIn,
    login: login,
    logout: logout,
    getMe: getMe,
    getSession: getSession,
    canWrite: canWrite,
    canAdmin: canAdmin,
    requestPasswordReset: requestPasswordReset,
    confirmPasswordReset: confirmPasswordReset,
    listUsuarios: listUsuarios,
    inviteUsuario: inviteUsuario,
    loadEstado: loadEstado,
    getResumo: getResumo,
    getAlertas: getAlertas,
    saveVenda: saveVenda,
    deleteVenda: deleteVenda,
    savePerdida: savePerdida,
    deletePerdida: deletePerdida,
    patchConfig: patchConfig,
    listEmpreendimentos: listEmpreendimentos,
    createEmpreendimento: createEmpreendimento,
    listRegioes: listRegioes,
    createRegiao: createRegiao,
    syncFontes: syncFontes,
    syncFonte: syncFonte,
    createFonte: createFonte,
    deleteFonte: deleteFonte,
    importarArquivo: importarArquivo,
    atribuirRegiao: atribuirRegiao,
    limparVendas: limparVendas,
    request: request,
  };
})(window);
