/* ============================================================
   FELIZ CASA NOVA — Painel de Vendas
   Lógica da aplicação (sem dependências de build).
   ============================================================ */

(function(){
  "use strict";

  /* ---------------- estado ---------------- */
  var STATE = null;          // objeto de dados (ver dados.json)
  var CURRENT_VIEW = "overview";
  var CHARTS = {};           // instâncias Chart.js ativas, por canvas id
  var editingVendaId = null;
  var editingRegiaoForNewVenda = null;
  var DIRTY = false;
  var CSV_HOST_ALLOW = ["docs.google.com", "spreadsheets.google.com"];
  var EMP_ID_BY_NOME = {};
  var LEGACY_AUTOSAVE_KEYS = ["fcn-painel-autosave-v1", "fcn-painel-last-export-v1"];
  var TERMOS_VERSAO = "2026-08-28";
  var LOGO_MAX_BYTES = 350 * 1024;
  var LOGO_MAX_W = 800;
  var LOGO_MAX_H = 300;

  /** SaaS: só opera autenticado na API. */
  function useApi(){ return !!(window.FCNApi && FCNApi.isLoggedIn()); }

  function requireApi(){
    if(useApi()) return true;
    toast("Faça login para continuar. Os dados ficam no servidor.");
    showApp(false);
    return false;
  }

  function apiPk(item){
    if(!item) return null;
    if(item._apiPk != null) return item._apiPk;
    if(/^\d+$/.test(String(item.id))) return Number(item.id);
    return null;
  }

  var _configSaveTimer = null;
  function saveConfigToApi(extra){
    if(!useApi()) return Promise.resolve();
    var payload = Object.assign({
      alertaDiasSemAssinatura: STATE.config.alertaDiasSemAssinatura,
      camposObrigatorios: STATE.config.camposObrigatorios,
      logoDataUrl: STATE.logoDataUrl
    }, extra || {});
    return FCNApi.patchConfig(payload).then(function(){
      DIRTY = false;
      updateDirtyChip();
    });
  }

  function scheduleConfigSave(){
    if(!requireApi()) return;
    if(!podeAdministrar()){
      toast("Só administradores alteram a configuração.");
      return;
    }
    clearTimeout(_configSaveTimer);
    _configSaveTimer = setTimeout(function(){
      saveConfigToApi().then(function(){
        toast("Configuração salva na API.");
      }).catch(function(err){ toast(err.message); });
    }, 450);
  }

  function showApp(show){
    var login = document.getElementById("login-screen");
    var shell = document.getElementById("app-shell");
    if(login) login.classList.toggle("skip-hidden", show);
    if(shell) shell.classList.toggle("skip-hidden", !show);
  }

  function rebuildEmpMap(){
    EMP_ID_BY_NOME = {};
    (STATE.regioes||[]).forEach(function(r){
      if(r._apiId) EMP_ID_BY_NOME[(r.nome||"").toUpperCase()] = r._apiId;
    });
  }

  function reloadFromApi(){
    return FCNApi.loadEstado().then(function(data){
      var checked = validarEstadoMinimo(data);
      if(!checked.ok) throw new Error(checked.erro);
      STATE = checked.data;
      rebuildEmpMap();
      return FCNApi.listEmpreendimentos().then(function(emps){
        var list = Array.isArray(emps) ? emps : (emps && emps.results) || [];
        list.forEach(function(e){
          var reg = STATE.regioes.find(function(r){
            return r.id===e.slug || (r.nome||"").toUpperCase()===(e.nome||"").toUpperCase();
          });
          if(reg){ reg._apiId = e.id; if(e.slug) reg.id = e.slug; }
        });
        rebuildEmpMap();
        DIRTY = false;
        updateDirtyChip();
        renderAll();
      });
    });
  }

  function showLoading(on, text){
    var el = document.getElementById("global-loading");
    var t = document.getElementById("global-loading-text");
    if(t && text) t.textContent = text;
    if(el) el.classList.toggle("skip-hidden", !on);
  }

  function setBusy(btn, busy, labelBusy){
    if(!btn) return;
    if(busy){
      btn.dataset._label = btn.textContent;
      btn.disabled = true;
      btn.setAttribute("aria-busy", "true");
      if(labelBusy) btn.textContent = labelBusy;
    } else {
      btn.disabled = false;
      btn.removeAttribute("aria-busy");
      if(btn.dataset._label) btn.textContent = btn.dataset._label;
    }
  }

  function showApiBanner(msg){
    var b = document.getElementById("api-banner");
    if(!b) return;
    if(!msg){ b.classList.add("skip-hidden"); b.textContent = ""; return; }
    b.textContent = msg;
    b.classList.remove("skip-hidden");
  }

  function emptyStateHTML(title, hint){
    return '<div class="empty-state"><strong>'+escapeHTML(title||"Nada por aqui")+'</strong>'+
      (hint ? '<p class="hint">'+escapeHTML(hint)+'</p>' : '')+'</div>';
  }

  function showLoginPanel(which){
    ["login-panel","forgot-panel","reset-panel"].forEach(function(id){
      var el = document.getElementById(id);
      if(el) el.classList.toggle("skip-hidden", id!==which);
    });
  }

  function parseResetHash(){
    var h = (location.hash||"").replace(/^#/, "");
    if(h.indexOf("reset=")===0){
      var raw = decodeURIComponent(h.slice(6));
      var parts = raw.split(".");
      if(parts.length>=2){
        return {uid: parts[0], token: parts.slice(1).join(".")};
      }
    }
    return null;
  }

  function podeEscrever(){ return !!(window.FCNApi && FCNApi.canWrite && FCNApi.canWrite()); }
  function podeAdministrar(){ return !!(window.FCNApi && FCNApi.canAdmin && FCNApi.canAdmin()); }

  function applyRoleUI(){
    var write = podeEscrever();
    var admin = podeAdministrar();
    var addVenda = document.getElementById("btn-global-add-venda");
    if(addVenda) addVenda.classList.toggle("skip-hidden", !write);
    var refresh = document.getElementById("btn-global-refresh");
    if(refresh) refresh.classList.toggle("skip-hidden", !write);
    document.querySelectorAll(".tab-add").forEach(function(el){
      el.classList.toggle("skip-hidden", !admin);
    });
    document.querySelectorAll("[data-needs-write]").forEach(function(el){
      el.classList.toggle("skip-hidden", !write);
    });
    document.querySelectorAll("[data-needs-admin]").forEach(function(el){
      el.classList.toggle("skip-hidden", !admin);
    });
  }

  function bootWithApi(){
    showApp(true);
    showApiBanner("");
    wireModals();
    tickClock();
    setInterval(tickClock, 30000);
    showLoading(true, "Carregando painel…");
    var mePromise = FCNApi.getMe ? FCNApi.getMe().catch(function(){ return null; }) : Promise.resolve(null);
    return mePromise.then(function(){
      return reloadFromApi();
    }).then(function(){
      showLoading(false);
      return ensureTermosAceitos();
    }).then(function(){
      applyRoleUI();
      toast("Conectado à API.");
      autoAtualizarAoAbrir();
    }).catch(function(err){
      showLoading(false);
      if(err && err.message === "Termos não aceitos.") return;
      showApiBanner("Não foi possível carregar os dados: "+(err.message||"erro"));
      toast("Falha ao carregar estado: "+err.message);
    });
  }

  function wireLogin(){
    var form = document.getElementById("form-login");
    if(!form) return;
    form.addEventListener("submit", function(e){
      e.preventDefault();
      var user = document.getElementById("login-user").value.trim();
      var pass = document.getElementById("login-pass").value;
      var errEl = document.getElementById("login-error");
      var btn = document.getElementById("btn-login-submit");
      if(errEl) errEl.textContent = "";
      setBusy(btn, true, "Entrando…");
      FCNApi.login(user, pass).then(function(){
        return bootWithApi();
      }).catch(function(err){
        if(errEl) errEl.textContent = err.message || "Login inválido";
      }).then(function(){ setBusy(btn, false); });
    });

    var btnForgot = document.getElementById("btn-show-forgot");
    if(btnForgot) btnForgot.addEventListener("click", function(){ showLoginPanel("forgot-panel"); });
    var back1 = document.getElementById("btn-back-login");
    var back2 = document.getElementById("btn-back-login-2");
    if(back1) back1.addEventListener("click", function(){ showLoginPanel("login-panel"); history.replaceState(null,"",location.pathname); });
    if(back2) back2.addEventListener("click", function(){ showLoginPanel("login-panel"); history.replaceState(null,"",location.pathname); });

    var formForgot = document.getElementById("form-forgot");
    if(formForgot){
      formForgot.addEventListener("submit", function(e){
        e.preventDefault();
        var msg = document.getElementById("forgot-msg");
        var payload = {
          username: (document.getElementById("forgot-user").value||"").trim(),
          email: (document.getElementById("forgot-email").value||"").trim()
        };
        if(msg) msg.textContent = "Enviando…";
        FCNApi.requestPasswordReset(payload).then(function(data){
          var t = data.message || "Se a conta existir, enviamos o link.";
          if(data.debug_link) t += " (dev: veja também o log do backend)";
          if(msg) msg.textContent = t;
          if(data.debug_link) console.info("Reset link:", data.debug_link);
        }).catch(function(err){
          if(msg) msg.textContent = err.message;
        });
      });
    }

    var formReset = document.getElementById("form-reset");
    if(formReset){
      formReset.addEventListener("submit", function(e){
        e.preventDefault();
        var msg = document.getElementById("reset-msg");
        var p1 = document.getElementById("reset-pass").value;
        var p2 = document.getElementById("reset-pass2").value;
        if(p1!==p2){ if(msg) msg.textContent = "As senhas não conferem."; return; }
        FCNApi.confirmPasswordReset({
          uid: document.getElementById("reset-uid").value,
          token: document.getElementById("reset-token").value,
          new_password: p1
        }).then(function(data){
          if(msg) msg.textContent = data.message || "Senha atualizada.";
          toast("Senha atualizada. Faça login.");
          setTimeout(function(){
            history.replaceState(null,"",location.pathname);
            showLoginPanel("login-panel");
          }, 800);
        }).catch(function(err){
          if(msg) msg.textContent = err.message;
        });
      });
    }

    var resetInfo = parseResetHash();
    if(resetInfo){
      document.getElementById("reset-uid").value = resetInfo.uid;
      document.getElementById("reset-token").value = resetInfo.token;
      showLoginPanel("reset-panel");
      showApp(false);
    }

    var btnOut = document.getElementById("btn-logout");
    if(btnOut){
      btnOut.addEventListener("click", function(){
        FCNApi.logout();
        location.reload();
      });
    }
  }

  var MESES_PT = ["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"];
  var MESES_EXT = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];

  function uid(){
    if(typeof crypto!=="undefined" && crypto.randomUUID) return crypto.randomUUID().replace(/-/g,"").slice(0,12);
    return Math.random().toString(36).slice(2,10)+Math.random().toString(36).slice(2,6);
  }

  /** Aceita data:image/...;base64,... ou path relativo sem protocolo (ex.: logo.png). */
  function sanitizeLogoSrc(src){
    if(!src || typeof src!=="string") return null;
    var s = src.trim();
    if(!s || /[\r\n\0]/.test(s)) return null;
    if(/^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/i.test(s)) return s;
    if(/^[a-zA-Z0-9._\-:/]+$/.test(s) && s.indexOf("://")===-1 && s.indexOf(":")===-1) return s;
    return null;
  }

  function estimateDataUrlBytes(dataUrl){
    var i = dataUrl.indexOf(",");
    if(i < 0) return dataUrl.length;
    var b64 = dataUrl.slice(i + 1);
    return Math.floor(b64.length * 3 / 4);
  }

  /** Redimensiona/comprime raster; SVG só valida tamanho. */
  function compressLogoFile(file, done){
    if(!file || !file.type){ done(null, "Arquivo inválido."); return; }
    if(/^image\/svg/i.test(file.type)){
      var svgReader = new FileReader();
      svgReader.onload = function(){
        var safe = sanitizeLogoSrc(svgReader.result);
        if(!safe){ done(null, "SVG inválido."); return; }
        if(estimateDataUrlBytes(safe) > 500 * 1024){
          done(null, "SVG muito grande (máx. 500 KB).");
          return;
        }
        done(safe);
      };
      svgReader.onerror = function(){ done(null, "Não foi possível ler o SVG."); };
      svgReader.readAsDataURL(file);
      return;
    }
    if(!/^image\//i.test(file.type)){
      done(null, "Use PNG, JPEG, GIF, WebP ou SVG.");
      return;
    }
    var img = new Image();
    var objUrl = URL.createObjectURL(file);
    img.onload = function(){
      URL.revokeObjectURL(objUrl);
      var w = img.width, h = img.height;
      var scale = Math.min(1, LOGO_MAX_W / w, LOGO_MAX_H / h);
      w = Math.max(1, Math.round(w * scale));
      h = Math.max(1, Math.round(h * scale));
      var canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      var ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      var quality = 0.88;
      var dataUrl = canvas.toDataURL("image/jpeg", quality);
      while(estimateDataUrlBytes(dataUrl) > LOGO_MAX_BYTES && quality > 0.45){
        quality -= 0.08;
        dataUrl = canvas.toDataURL("image/jpeg", quality);
      }
      if(estimateDataUrlBytes(dataUrl) > 500 * 1024){
        done(null, "Imagem ainda grande demais após compressão. Use arquivo menor.");
        return;
      }
      var safe = sanitizeLogoSrc(dataUrl);
      done(safe || null, safe ? null : "Formato de imagem rejeitado.");
    };
    img.onerror = function(){
      URL.revokeObjectURL(objUrl);
      done(null, "Não foi possível ler a imagem.");
    };
    img.src = objUrl;
  }

  function termosAceitos(){
    try{
      return localStorage.getItem("fcn-termos-aceitos") === TERMOS_VERSAO;
    }catch(e){ return true; }
  }

  function marcarTermosAceitos(){
    try{ localStorage.setItem("fcn-termos-aceitos", TERMOS_VERSAO); }catch(e){}
  }

  function ensureTermosAceitos(){
    if(termosAceitos()) return Promise.resolve();
    return new Promise(function(resolve, reject){
      var modal = document.getElementById("modal-termos");
      var chk = document.getElementById("termos-check");
      var btnOk = document.getElementById("btn-termos-aceitar");
      var btnOut = document.getElementById("btn-termos-sair");
      if(!modal || !chk || !btnOk) return resolve();
      showLoading(false);
      modal.classList.add("open");
      chk.checked = false;
      btnOk.disabled = true;
      function onChk(){ btnOk.disabled = !chk.checked; }
      function cleanup(){
        chk.removeEventListener("change", onChk);
        btnOk.removeEventListener("click", onOk);
        if(btnOut) btnOut.removeEventListener("click", onOut);
      }
      function onOk(){
        if(!chk.checked) return;
        marcarTermosAceitos();
        modal.classList.remove("open");
        cleanup();
        resolve();
      }
      function onOut(){
        modal.classList.remove("open");
        cleanup();
        if(window.FCNApi && FCNApi.logout) FCNApi.logout();
        showApp(false);
        reject(new Error("Termos não aceitos."));
      }
      chk.addEventListener("change", onChk);
      btnOk.addEventListener("click", onOk);
      if(btnOut) btnOut.addEventListener("click", onOut);
    });
  }

  function validarEstadoMinimo(raw){
    if(!raw || typeof raw!=="object" || Array.isArray(raw)) return {ok:false, erro:"O JSON precisa ser um objeto."};
    if(!Array.isArray(raw.regioes)) return {ok:false, erro:"Campo \"regioes\" ausente ou inválido (esperado array)."};
    // Aceita tanto "vendas" (plural) quanto "venda" (singular) por compatibilidade
    var vendasRaw = Array.isArray(raw.vendas) ? raw.vendas : (Array.isArray(raw.venda) ? raw.venda : null);
    if(!vendasRaw) return {ok:false, erro:"Campo \"vendas\" ausente ou inválido (esperado array)."};
    var vendasPerdidasRaw = Array.isArray(raw.vendasPerdidas) ? raw.vendasPerdidas : (Array.isArray(raw.venda_perdida) ? raw.venda_perdida : []);
    var out = {
      empresa: raw.empresa || "Feliz Casa Nova",
      atualizadoEm: raw.atualizadoEm || null,
      logoDataUrl: sanitizeLogoSrc(raw.logoDataUrl) || null,
      config: (raw.config && typeof raw.config==="object" && !Array.isArray(raw.config)) ? raw.config : {},
      regioes: raw.regioes,
      vendas: vendasRaw,
      vendasPerdidas: vendasPerdidasRaw
    };
    if(!Array.isArray(out.config.camposObrigatorios)){
      out.config.camposObrigatorios = ["cliente","construtora","produto","valor","corretor"];
    } else {
      out.config.camposObrigatorios = out.config.camposObrigatorios.map(function(c){
        return c === "empreendimento" ? "construtora" : c;
      });
    }
    if(typeof out.config.alertaDiasSemAssinatura!=="number"){
      out.config.alertaDiasSemAssinatura = parseInt(out.config.alertaDiasSemAssinatura,10) || 15;
    }
    if(!Array.isArray(out.config.fontesCSV)) out.config.fontesCSV = [];
    out.vendas = out.vendas.map(function(v){
      var c = Object.assign({}, v);
      c.construtora = c.construtora || c.empreendimento || "";
      c.empreendimento = c.empreendimento || c.construtora || "";
      // Preencher regiao (nome) a partir do regiao_id, se disponível
      if((!c.regiao || !c.regiao.trim()) && c.regiao_id){
        var reg = out.regioes.find(function(r){ return r.id === c.regiao_id; });
        if(reg) c.regiao = reg.nome;
      }
      return c;
    });
    out.vendasPerdidas = out.vendasPerdidas.map(function(p){
      var c = Object.assign({}, p);
      c.construtora = c.construtora || c.empreendimento || "";
      c.empreendimento = c.empreendimento || c.construtora || "";
      return c;
    });
    return {ok:true, data:out};
  }

  function markDirty(){
    // Legado offline: no SaaS a API é a fonte da verdade — não grava estado no localStorage.
    if(STATE) STATE.atualizadoEm = new Date().toISOString();
  }

  function clearDirtyAfterExport(){
    DIRTY = false;
  }

  function clearLegacyLocalState(){
    LEGACY_AUTOSAVE_KEYS.forEach(function(k){
      try{ localStorage.removeItem(k); }catch(e){}
    });
  }

  function updateDirtyChip(){
    /* chip removido do HTML no modo SaaS */
  }

  function urlCSVPermitida(url){
    try{
      var u = new URL(url);
      if(u.protocol!=="https:") return {ok:false, erro:"Use um link https:// (Google Sheets publicado)."};
      var host = u.hostname.toLowerCase();
      var ok = CSV_HOST_ALLOW.some(function(h){ return host===h || host.endsWith("."+h); });
      if(!ok) return {ok:false, erro:"Host não permitido. Use docs.google.com ou spreadsheets.google.com."};
      return {ok:true};
    }catch(e){
      return {ok:false, erro:"URL inválida."};
    }
  }

  function textoPareceCSVVendas(text){
    var lines = String(text||"").split(/\r?\n/).filter(function(l){return l.trim().length;});
    if(!lines.length) return false;
    if(/assinatura|cliente/i.test(lines[0])) return lines.length>=2;
    var cols = parseCSVLine(lines[0]);
    return cols.length>=9;
  }

  /* ---------------- utilidades ---------------- */
  function fmtBRL(n){
    n = Number(n)||0;
    return n.toLocaleString("pt-BR",{style:"currency",currency:"BRL",maximumFractionDigits:0});
  }
  function fmtBRLFull(n){
    n = Number(n)||0;
    return n.toLocaleString("pt-BR",{style:"currency",currency:"BRL",maximumFractionDigits:2});
  }
  function fmtNum(n){ return Number(n||0).toLocaleString("pt-BR"); }
  function fmtDateBR(iso){
    if(!iso) return "—";
    var p = iso.split("-");
    if(p.length!==3) return iso;
    return p[2]+"/"+p[1]+"/"+p[0];
  }
  function todayISO(){
    var d = new Date();
    return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
  }
  function daysSince(iso){
    if(!iso) return null;
    var d1 = new Date(iso+"T00:00:00");
    var d2 = new Date(todayISO()+"T00:00:00");
    return Math.round((d2-d1)/86400000);
  }
  function mesLabel(mesISO){ // "2026-01" -> "Jan/26"
    if(!mesISO) return "—";
    var p = mesISO.split("-");
    var idx = parseInt(p[1],10)-1;
    return MESES_PT[idx] + "/" + p[0].slice(2);
  }
  function slugify(s){
    return s.toString().toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
      .replace(/[^a-z0-9]+/g,"-").replace(/(^-|-$)/g,"") || uid();
  }
  function titleCase(s){
    if(!s) return s;
    return s.toString().toLowerCase().replace(/(^|\s|\/)([a-zà-ú])/g, function(m,sep,c){return sep+c.toUpperCase();});
  }
  function toast(msg){
    var t = document.getElementById("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(function(){ t.classList.remove("show"); }, 3200);
  }
  function el(tag, cls, html){
    var e = document.createElement(tag);
    if(cls) e.className = cls;
    if(html!==undefined) e.innerHTML = html;
    return e;
  }

  /* ---------------- acesso a dados ---------------- */
  function regiaoById(id){
    return STATE.regioes.find(function(r){ return r.id===id; });
  }
  function vendasSemRegiao(){
    return STATE.vendas.filter(function(v){ return !(v.regiao||"").trim() && !v.exemplo; });
  }
  function vendasDaRegiao(regiaoNome){
    return STATE.vendas.filter(function(v){
      return (v.regiao||"").toUpperCase() === (regiaoNome||"").toUpperCase() && !v.exemplo;
    });
  }
  /** Regra única: resumoManual só conta se a região ainda não tem vendas lançadas. */
  function usarResumoManual(regiao){
    if(!regiao || !regiao.resumoManual) return false;
    return vendasDaRegiao(regiao.nome).length===0;
  }
  function vendasFechadasDaRegiao(regiaoNome){
    return vendasDaRegiao(regiaoNome).filter(function(v){ return !!v.dataAssinatura; });
  }
  function todasVendasFechadas(){
    return STATE.vendas.filter(function(v){ return !!v.dataAssinatura && !v.exemplo; });
  }
  function sumVGV(list){ return list.reduce(function(a,v){return a+(Number(v.valor)||0);},0); }
  function sumVGC(list){ return list.reduce(function(a,v){return a+(Number(v.comissao)||0);},0); }

  function shiftMonth(yyyyMm, delta){
    var p = (yyyyMm||"").split("-");
    if(p.length<2) return null;
    var y = parseInt(p[0],10), m = parseInt(p[1],10)-1 + delta;
    while(m<0){ m+=12; y--; }
    while(m>11){ m-=12; y++; }
    return y+"-"+String(m+1).padStart(2,"0");
  }

  function mesAtual(){
    var d = new Date();
    return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0");
  }

  /** Bounds YYYY-MM inclusive a partir de preset (all|3|6|12|ano|custom). */
  function periodoBounds(preset, deCustom, ateCustom){
    if(preset==="all" || !preset) return {de:null, ate:null};
    if(preset==="custom"){
      var de = (deCustom||"").slice(0,7) || null;
      var ate = (ateCustom||"").slice(0,7) || null;
      return {de:de, ate:ate};
    }
    if(preset==="ano"){
      var y = String(new Date().getFullYear());
      return {de:y+"-01", ate:y+"-12"};
    }
    var n = parseInt(preset,10) || 6;
    var ate = mesAtual();
    var de = shiftMonth(ate, -(n-1));
    return {de:de, ate:ate};
  }

  function mesDaVenda(v){
    if(v.mes && /^\d{4}-\d{2}$/.test(v.mes)) return v.mes;
    if(v.dataAssinatura && v.dataAssinatura.length>=7) return v.dataAssinatura.slice(0,7);
    if(v.dataEntrada && v.dataEntrada.length>=7) return v.dataEntrada.slice(0,7);
    return null;
  }

  /** Construtora da venda (planilha: coluna EMPREENDIMENTO). */
  function construtoraDaVenda(v){
    if(!v) return "";
    return v.construtora || v.empreendimento || "";
  }

  /**
   * opts: { periodo, de, ate, regiao, corretor, status, mes, emp, produto, q }
   * status: fechadas | abertas | todas
   * opts.emp = filtro por construtora
   */
  function filtrarVendas(lista, opts){
    opts = opts || {};
    var bounds = periodoBounds(opts.periodo, opts.de, opts.ate);
    var status = opts.status || "fechadas";
    var q = (opts.q||"").toLowerCase().trim();
    return (lista||[]).filter(function(v){
      if(v.exemplo) return false;
      var fechada = !!v.dataAssinatura;
      if(status==="fechadas" && !fechada) return false;
      if(status==="abertas" && fechada) return false;
      if(opts.regiao && (v.regiao||"").toUpperCase()!==(opts.regiao||"").toUpperCase()) return false;
      if(opts.corretor && (v.corretor||"")!==opts.corretor) return false;
      if(opts.mes && mesDaVenda(v)!==opts.mes) return false;
      if(opts.emp && construtoraDaVenda(v)!==opts.emp) return false;
      if(opts.produto && (v.produto||"")!==opts.produto) return false;
      if(bounds.de || bounds.ate){
        var m = mesDaVenda(v);
        if(!m) return false;
        if(bounds.de && m<bounds.de) return false;
        if(bounds.ate && m>bounds.ate) return false;
      }
      if(q){
        var hay = [v.cliente,v.corretor,v.unidade,v.produto,v.telefone,construtoraDaVenda(v),v.regiao].join(" ").toLowerCase();
        if(hay.indexOf(q)===-1) return false;
      }
      return true;
    });
  }

  function uniqueSorted(arr){
    return Array.from(new Set(arr.filter(Boolean))).sort(function(a,b){
      return String(a).localeCompare(String(b),"pt-BR");
    });
  }

  function fillSelect(sel, values, emptyLabel){
    if(!sel) return;
    var cur = sel.value;
    sel.innerHTML = "";
    sel.appendChild(new Option(emptyLabel||"Todos", ""));
    values.forEach(function(v){ sel.appendChild(new Option(v.label!=null?v.label:v, v.value!=null?v.value:v)); });
    if(cur) sel.value = cur;
  }

  function camposFaltando(v){
    var req = STATE.config.camposObrigatorios || [];
    var faltando = [];
    req.forEach(function(campo){
      var val = (campo==="construtora" || campo==="empreendimento")
        ? construtoraDaVenda(v)
        : (campo==="blocoQuadra" ? (v.blocoQuadra || v.bloco_quadra) : v[campo]);
      if(val===undefined || val===null || String(val).trim()==="" || (campo==="valor" && Number(val)<=0)){
        faltando.push(campo);
      }
    });
    return faltando;
  }

  var CAMPO_LABEL = {
    cliente:"Cliente", telefone:"Telefone", construtora:"Construtora", empreendimento:"Construtora", produto:"Produto",
    valor:"Valor", corretor:"Corretor", blocoQuadra:"Bloco/Quadra", unidade:"Unidade", origem:"Origem", regiao:"Região"
  };

  /* ---------------- alertas ---------------- */
  function calcularAlertas(){
    var alertas = [];
    var limite = STATE.config.alertaDiasSemAssinatura || 15;

    STATE.vendas.forEach(function(v){
      // 1) processo em andamento há muito tempo sem assinatura
      if(!v.dataAssinatura && v.dataEntrada){
        var dias = daysSince(v.dataEntrada);
        if(dias!==null && dias>=limite){
          alertas.push({
            tipo:"assinatura",
            sev: dias>=limite*2 ? "high":"mid",
            titulo:(v.cliente||"Cliente sem nome") + " — " + dias + " dias sem assinatura",
            detalhe:(construtoraDaVenda(v)||"—")+" · "+(v.produto||"—")+" · corretor "+(v.corretor||"—") +
                    (v.exemplo ? "  (exemplo — edite ou exclua em Configurações)":""),
            vendaId: v.id
          });
        }
      }
      // 2) informação faltando em venda já lançada
      var faltando = camposFaltando(v);
      if(faltando.length){
        alertas.push({
          tipo:"dados",
          sev:"mid",
          titulo:(v.cliente||"Venda #"+ (v.numero||"?")) + " — falta preencher " + faltando.map(function(c){return CAMPO_LABEL[c]||c;}).join(", "),
          detalhe:(construtoraDaVenda(v)||"—")+" · "+(v.regiao||"—")+(v.dataAssinatura ? " · assinado em "+fmtDateBR(v.dataAssinatura):""),
          vendaId: v.id
        });
      }
    });

    // ordena: severidade alta primeiro
    alertas.sort(function(a,b){ return (a.sev==="high"?0:1) - (b.sev==="high"?0:1); });
    return alertas;
  }

  /* ============================================================
     RENDER: TABS
     ============================================================ */
  function renderTabs(){
    var bar = document.getElementById("tabbar");
    bar.innerHTML = "";

    function addTab(id, label, count){
      var b = el("button","tab-btn"+(CURRENT_VIEW===id?" active":""));
      b.type = "button";
      b.dataset.view = id;
      b.appendChild(document.createTextNode(label));
      if(count!==undefined){
        var span = document.createElement("span");
        span.className = "count";
        span.textContent = String(count);
        b.appendChild(span);
      }
      b.addEventListener("click", function(){ setView(id); });
      bar.appendChild(b);
    }

    addTab("overview","Visão geral");
    var sem = vendasSemRegiao().length;
    if(sem) addTab("sem-regiao","Sem região", sem);
    STATE.regioes.forEach(function(r){
      var n = vendasDaRegiao(r.nome).length;
      addTab("regiao:"+r.id, r.nome, n || undefined);
    });
    // addTab("perdidas","Vendas perdidas", STATE.vendasPerdidas.length || undefined);
    // addTab("dados","Dados & config");

    var addBtn = el("button","tab-add","+");
    addBtn.type = "button";
    addBtn.title = "Adicionar nova região";
    addBtn.addEventListener("click", novaRegiaoPrompt);
    bar.appendChild(addBtn);
  }

  function novaRegiaoPrompt(){
    if(!podeAdministrar()){
      toast("Só administradores podem criar regiões.");
      return;
    }
    var nome = window.prompt("Nome da nova região a acompanhar (ex.: Camaçari, Salvador, Lauro de Freitas):");
    if(!nome) return;
    var id = slugify(nome);
    if(regiaoById(id)){ toast("Essa aba já existe."); setView("regiao:"+id); return; }
    if(useApi()){
      FCNApi.createEmpreendimento(nome.trim(), id).then(function(){
        return reloadFromApi();
      }).then(function(){
        setView("regiao:"+id);
        toast("Aba \""+nome+"\" criada na API.");
      }).catch(function(err){ toast(err.message); });
      return;
    }
    STATE.regioes.push({id:id, nome:nome.trim(), resumoManual:null});
    markDirty();
    renderTabs();
    setView("regiao:"+id);
    toast("Aba \""+nome+"\" criada. Use \"Adicionar venda\" para lançar os negócios.");
  }

  function setView(view){
    CURRENT_VIEW = view;
    document.querySelectorAll(".view").forEach(function(v){ v.classList.remove("active"); });
    document.querySelectorAll(".tab-btn").forEach(function(b){ b.classList.toggle("active", b.dataset.view===view); });

    if(view==="overview") renderOverview();
    else if(view==="sem-regiao") renderSemRegiao();
    // else if(view==="perdidas") renderPerdidas();
    // else if(view==="dados") renderDados();
    else if(view.indexOf("regiao:")===0) renderRegiao(view.slice(7));

    var target = document.getElementById("view-"+view.replace(":","-"));
    if(target) target.classList.add("active");
  }

  function ensureViewContainer(id){
    var domId = "view-"+id.replace(":","-");
    var node = document.getElementById(domId);
    if(!node){
      node = el("section","view");
      node.id = domId;
      document.getElementById("view-root").appendChild(node);
    }
    return node;
  }

  function readOverviewFilters(){
    return {
      periodo: (document.getElementById("ov-periodo")||{}).value || "12",
      de: (document.getElementById("ov-de")||{}).value || "",
      ate: (document.getElementById("ov-ate")||{}).value || "",
      regiao: (document.getElementById("ov-regiao")||{}).value || "",
      corretor: (document.getElementById("ov-corretor")||{}).value || "",
      status: (document.getElementById("ov-status")||{}).value || "fechadas",
      emp: (document.getElementById("ov-emp")||{}).value || ""
    };
  }

  function syncCustomPeriodVisibility(){
    var wrap = document.getElementById("ov-custom-range");
    var periodo = (document.getElementById("ov-periodo")||{}).value;
    if(wrap) wrap.classList.toggle("skip-hidden", periodo!=="custom");
  }

  /* ============================================================
     RENDER: VISÃO GERAL
     ============================================================ */
  function renderOverview(){
    var root = ensureViewContainer("overview");
    var base = STATE.vendas.filter(function(v){ return !v.exemplo; });
    var regioes = uniqueSorted(STATE.regioes.map(function(r){ return r.nome; }));
    var corretores = uniqueSorted(base.map(function(v){ return v.corretor; }));
    var emps = uniqueSorted(base.map(construtoraDaVenda));
    var alertas = calcularAlertas();

    root.innerHTML =
      '<div class="section-title"><h2>Visão geral — todas as regiões</h2>'+
      '<span class="hint">Filtros atualizam KPIs, gráficos e ranking juntos</span></div>'+

      '<div class="filter-bar" id="overview-filters">'+
        '<div class="filter-field"><label>Período</label>'+
          '<select class="input" id="ov-periodo">'+
            '<option value="3">Últimos 3 meses</option>'+
            '<option value="6">Últimos 6 meses</option>'+
            '<option value="12" selected>Últimos 12 meses</option>'+
            '<option value="ano">Ano atual</option>'+
            '<option value="all">Todo o histórico</option>'+
            '<option value="custom">Intervalo customizado</option>'+
          '</select></div>'+
        '<div class="filter-field filter-range skip-hidden" id="ov-custom-range">'+
          '<label>De / até (mês)</label>'+
          '<div class="filter-range-inputs">'+
            '<input class="input" type="month" id="ov-de">'+
            '<input class="input" type="month" id="ov-ate">'+
          '</div></div>'+
        '<div class="filter-field"><label>Região</label><select class="input" id="ov-regiao"></select></div>'+
        '<div class="filter-field"><label>Construtora</label><select class="input" id="ov-emp"></select></div>'+
        '<div class="filter-field"><label>Corretor</label><select class="input" id="ov-corretor"></select></div>'+
        '<div class="filter-field"><label>Status</label>'+
          '<select class="input" id="ov-status">'+
            '<option value="fechadas" selected>Assinadas</option>'+
            '<option value="abertas">Em negociação</option>'+
            '<option value="todas">Todas</option>'+
          '</select></div>'+
        '<div class="filter-field filter-actions"><label>&nbsp;</label>'+
          '<button type="button" class="btn btn-ghost btn-sm" id="ov-reset">Limpar filtros</button></div>'+
      '</div>'+

      '<div class="kpi-row" id="overview-kpis"></div>'+
      '<p class="hint filter-summary" id="overview-filter-summary"></p>'+

      '<div class="grid-2" style="margin-top:12px;">'+
        '<div class="panel"><div class="panel-head"><h3>Vendas por mês</h3><span class="hint" id="ov-chart-months-hint">VGV e nº no recorte</span></div>'+
          '<canvas id="chart-overview-months" height="230"></canvas></div>'+
        '<div class="panel"><div class="panel-head"><h3>Por construtora</h3><span class="hint">participação no VGV</span></div>'+
          '<canvas id="chart-overview-emp" height="230"></canvas></div>'+
      '</div>'+

      '<div class="grid-2 reverse" style="margin-top:18px;">'+
        '<div class="panel"><div class="panel-head"><h3>Alertas</h3><span class="hint">assinatura demorada e dados incompletos</span></div>'+
          '<div id="overview-alerts" class="alert-list"></div></div>'+
        '<div class="panel"><div class="panel-head"><h3>Ranking de corretores</h3><span class="hint">por VGV no recorte</span></div>'+
          '<div id="overview-corretores" class="table-wrap"></div></div>'+
      '</div>';

    fillSelect(document.getElementById("ov-regiao"), regioes, "Todas as regiões");
    fillSelect(document.getElementById("ov-corretor"), corretores, "Todos os corretores");
    fillSelect(document.getElementById("ov-emp"), emps, "Todas as construtoras");

    function refreshOverview(){
      syncCustomPeriodVisibility();
      var opts = readOverviewFilters();
      var filtradas = filtrarVendas(base, opts);
      var paraCharts = filtradas.filter(function(v){ return !!v.dataAssinatura; });
      var vgv = sumVGV(paraCharts);
      var vgc = sumVGC(paraCharts);
      var defaults = opts.periodo==="12" && !opts.regiao && !opts.corretor && !opts.emp && opts.status==="fechadas";
      var manualVGV=0, manualVGC=0, manualVendas=0;
      if(defaults){
        STATE.regioes.forEach(function(r){
          if(!usarResumoManual(r)) return;
          manualVGV += Number(r.resumoManual.vgv||0);
          manualVGC += Number(r.resumoManual.vgc||0);
          manualVendas += Number(r.resumoManual.vendas||0);
        });
      }

      var kpiRoot = document.getElementById("overview-kpis");
      kpiRoot.innerHTML =
        kpiCard("VGV", fmtBRL(vgv+manualVGV), manualVGV? "inclui "+fmtBRL(manualVGV)+" manual": (paraCharts.length+" assinadas no recorte"), "accent-gold")+
        kpiCard("VGC", fmtBRL(vgc+manualVGC), "comissão no recorte", "accent-teal")+
        kpiCard(opts.status==="abertas"?"Em negociação":"Vendas", fmtNum(opts.status==="abertas"?filtradas.length:(paraCharts.length+manualVendas)), opts.status==="todas"? (filtradas.length+" no filtro"):"no período selecionado", "")+
        kpiCard("Alertas ativos", fmtNum(alertas.length), alertas.length? "revise ao lado":"tudo em dia", alertas.length? "accent-brick":"accent-teal");

      var bounds = periodoBounds(opts.periodo, opts.de, opts.ate);
      var bits = [];
      if(opts.periodo==="all") bits.push("todo o histórico");
      else if(opts.periodo==="ano") bits.push("ano atual");
      else if(opts.periodo==="custom") bits.push((bounds.de||"…")+" → "+(bounds.ate||"…"));
      else bits.push("últimos "+opts.periodo+" meses");
      if(opts.regiao) bits.push(opts.regiao);
      if(opts.emp) bits.push(opts.emp);
      if(opts.corretor) bits.push(opts.corretor);
      bits.push(opts.status==="fechadas"?"assinadas":opts.status==="abertas"?"em negociação":"todas");
      document.getElementById("overview-filter-summary").textContent =
        filtradas.length+" venda(s) · "+bits.join(" · ");

      renderAlertsInto(document.getElementById("overview-alerts"), alertas.slice(0,8));
      renderCorretorRanking(document.getElementById("overview-corretores"), paraCharts.length?paraCharts:filtradas);
      renderChartMonths("chart-overview-months", paraCharts);
      renderChartEmpreendimento("chart-overview-emp", paraCharts);
    }

    ["ov-periodo","ov-de","ov-ate","ov-regiao","ov-corretor","ov-emp","ov-status"].forEach(function(id){
      var node = document.getElementById(id);
      if(node) node.addEventListener("change", refreshOverview);
    });
    document.getElementById("ov-reset").addEventListener("click", function(){
      document.getElementById("ov-periodo").value = "12";
      document.getElementById("ov-de").value = "";
      document.getElementById("ov-ate").value = "";
      document.getElementById("ov-regiao").value = "";
      document.getElementById("ov-corretor").value = "";
      document.getElementById("ov-emp").value = "";
      document.getElementById("ov-status").value = "fechadas";
      refreshOverview();
    });

    refreshOverview();
  }

  function kpiCard(label, value, sub, extraClass){
    return '<div class="kpi-card '+(extraClass||"")+'">'+
      '<div class="kpi-label">'+label+'</div>'+
      '<div class="kpi-value">'+value+'</div>'+
      '<div class="kpi-sub">'+(sub||"")+'</div></div>';
  }

  function renderCorretorRanking(container, vendas){
    var map = {};
    vendas.forEach(function(v){
      var k = v.corretor || "—";
      if(!map[k]) map[k] = {vgv:0,n:0};
      map[k].vgv += Number(v.valor)||0;
      map[k].n += 1;
    });
    var rows = Object.keys(map).map(function(k){ return {corretor:k, vgv:map[k].vgv, n:map[k].n}; });
    rows.sort(function(a,b){return b.vgv-a.vgv;});
    rows = rows.slice(0,8);
    var html = '<table><thead><tr><th>Corretor</th><th class="num">Vendas</th><th class="num">VGV</th></tr></thead><tbody>';
    rows.forEach(function(r){
      html += '<tr><td>'+escapeHTML(r.corretor)+'</td><td class="num mono">'+r.n+'</td><td class="num mono">'+fmtBRL(r.vgv)+'</td></tr>';
    });
    html += '</tbody></table>';
    container.innerHTML = rows.length ? html : '<div class="empty-state">Sem vendas lançadas ainda.</div>';
  }

  /* ============================================================
     RENDER: REGIÃO
     ============================================================ */
  function renderRegiao(id){
    var regiao = regiaoById(id);
    var root = ensureViewContainer("regiao:"+id);
    if(!regiao){ root.innerHTML = "<p>Aba não encontrada.</p>"; return; }

    var vendas = vendasDaRegiao(regiao.nome);
    var manual = usarResumoManual(regiao) ? regiao.resumoManual : null;
    var rid = regiao.id;

    root.innerHTML =
      '<div class="section-title"><h2>'+escapeHTML(regiao.nome)+'</h2>'+
      '<span class="hint" id="rg-hint-'+rid+'">'+vendas.length+' vendas lançadas nesta aba</span></div>'+

      '<div class="filter-bar" id="rg-filters-'+rid+'">'+
        '<div class="filter-field"><label>Período</label>'+
          '<select class="input" id="rg-periodo-'+rid+'">'+
            '<option value="all" selected>Todo o histórico</option>'+
            '<option value="3">Últimos 3 meses</option>'+
            '<option value="6">Últimos 6 meses</option>'+
            '<option value="12">Últimos 12 meses</option>'+
            '<option value="ano">Ano atual</option>'+
          '</select></div>'+
        '<div class="filter-field"><label>Mês</label><select class="input" id="filter-mes-'+rid+'"></select></div>'+
        '<div class="filter-field"><label>Construtora</label><select class="input" id="filter-emp-'+rid+'"></select></div>'+
        '<div class="filter-field"><label>Corretor</label><select class="input" id="rg-corretor-'+rid+'"></select></div>'+
        '<div class="filter-field"><label>Status</label>'+
          '<select class="input" id="rg-status-'+rid+'">'+
            '<option value="todas" selected>Todas</option>'+
            '<option value="fechadas">Assinadas</option>'+
            '<option value="abertas">Em negociação</option>'+
          '</select></div>'+
        '<div class="filter-field filter-grow"><label>Busca</label>'+
          '<input class="input" type="search" placeholder="Cliente, unidade, telefone…" id="filter-search-'+rid+'"></div>'+
      '</div>'+

      '<div class="kpi-row" id="rg-kpis-'+rid+'"></div>'+
      '<p class="hint filter-summary" id="rg-summary-'+rid+'"></p>'+
      (regiao.resumoManual && !manual
        ? '<p class="hint">Resumo manual ignorado nesta aba porque há vendas lançadas — KPIs usam as linhas.</p>'
        : "")+
      (manual && manual.obs ? '<p class="hint">'+escapeHTML(manual.obs)+'</p>' : "")+

      '<div class="grid-2" style="margin-top:12px;">'+
        '<div class="panel"><div class="panel-head"><h3>Comparativo mês a mês</h3><span class="hint">VGV assinado no recorte</span></div>'+
          '<canvas id="chart-regiao-'+rid+'-months" height="220"></canvas></div>'+
        '<div class="panel"><div class="panel-head"><h3>Por produto</h3><span class="hint">participação no VGV</span></div>'+
          '<canvas id="chart-regiao-'+rid+'-prod" height="220"></canvas></div>'+
      '</div>'+

      '<div class="panel" style="margin-top:18px;">'+
        '<div class="panel-head"><h3>Vendas lançadas</h3>'+
          '<button class="btn btn-primary btn-sm" id="btn-add-venda-'+rid+'" data-needs-write>+ Adicionar venda</button></div>'+
        '<div class="table-wrap"><table id="tbl-vendas-'+rid+'"><thead><tr>'+
          '<th>Nº</th><th>Assinatura</th><th>Cliente</th><th>Telefone</th><th>Construtora</th><th>Produto</th>'+
          '<th>Bl./Qd.</th><th>Unid.</th><th class="num">Valor</th><th class="num">Comissão</th><th>Corretor</th><th>Origem</th><th>Status</th><th></th>'+
        '</tr></thead><tbody></tbody></table></div>'+
      '</div>';

    document.getElementById("btn-add-venda-"+rid).addEventListener("click", function(){ abrirModalVenda(null, regiao.nome); });
    if(!podeEscrever()){
      var btnAdd = document.getElementById("btn-add-venda-"+rid);
      if(btnAdd) btnAdd.classList.add("skip-hidden");
    }

    fillSelect(document.getElementById("filter-mes-"+rid),
      uniqueSorted(vendas.map(mesDaVenda)).map(function(m){ return {value:m, label:mesLabel(m)}; }),
      "Todos os meses");
    fillSelect(document.getElementById("filter-emp-"+rid),
      uniqueSorted(vendas.map(construtoraDaVenda)),
      "Todas as construtoras");
    fillSelect(document.getElementById("rg-corretor-"+rid),
      uniqueSorted(vendas.map(function(v){ return v.corretor; })),
      "Todos os corretores");

    function refreshRegiao(){
      var opts = {
        periodo: document.getElementById("rg-periodo-"+rid).value,
        mes: document.getElementById("filter-mes-"+rid).value,
        emp: document.getElementById("filter-emp-"+rid).value,
        corretor: document.getElementById("rg-corretor-"+rid).value,
        status: document.getElementById("rg-status-"+rid).value,
        q: document.getElementById("filter-search-"+rid).value
      };
      var filtered = filtrarVendas(vendas, opts);
      filtered.sort(function(a,b){ return (b.dataAssinatura||"9999").localeCompare(a.dataAssinatura||"9999"); });
      var fechadas = filtered.filter(function(v){ return !!v.dataAssinatura; });
      var vgv = sumVGV(fechadas), vgc = sumVGC(fechadas);
      var useManual = manual && opts.periodo==="all" && !opts.mes && !opts.emp && !opts.corretor && !opts.q && opts.status==="todas";

      var kpiRoot = document.getElementById("rg-kpis-"+rid);
      if(useManual){
        kpiRoot.innerHTML =
          kpiCard("VGV (resumo)", fmtBRL(manual.vgv), "ainda sem linha a linha", "accent-gold")+
          kpiCard("VGC (resumo)", fmtBRL(manual.vgc), "comissão total", "accent-teal")+
          kpiCard("Vendas (resumo)", fmtNum(manual.vendas), "unidades assinadas", "");
      } else {
        kpiRoot.innerHTML =
          kpiCard("VGV", fmtBRL(vgv), fechadas.length+" assinadas no recorte", "accent-gold")+
          kpiCard("VGC", fmtBRL(vgc), "comissão no recorte", "accent-teal")+
          kpiCard("Ticket médio", fmtBRL(fechadas.length? vgv/fechadas.length:0), filtered.length+" no filtro", "");
      }

      document.getElementById("rg-summary-"+rid).textContent =
        filtered.length+" venda(s) no filtro · "+fechadas.length+" assinada(s)";
      document.getElementById("rg-hint-"+rid).textContent = vendas.length+" vendas lançadas nesta aba";

      renderChartMonths("chart-regiao-"+rid+"-months", fechadas);
      renderChartEmpreendimento("chart-regiao-"+rid+"-prod", fechadas, "produto");
      renderVendasTable(document.getElementById("tbl-vendas-"+rid).querySelector("tbody"), filtered);
    }

    ["rg-periodo-"+rid,"filter-mes-"+rid,"filter-emp-"+rid,"rg-corretor-"+rid,"rg-status-"+rid].forEach(function(fid){
      document.getElementById(fid).addEventListener("change", refreshRegiao);
    });
    document.getElementById("filter-search-"+rid).addEventListener("input", refreshRegiao);
    refreshRegiao();
  }

  function renderSemRegiao(){
    var root = ensureViewContainer("sem-regiao");
    var todas = vendasSemRegiao();
    root.innerHTML =
      '<div class="section-title"><h2>Vendas sem região</h2>'+
      '<span class="hint">'+todas.length+' venda(s) importadas ainda sem polo</span></div>'+
      '<p class="hint">A planilha não informa a cidade. Use construtora, produto e corretor para decidir. Marque as linhas, escolha a região e aplique. O que ficar de fora continua nesta aba.</p>'+
      '<div class="filter-bar">'+
        '<div class="filter-field"><label>Mês</label><select class="input" id="sr-mes"></select></div>'+
        '<div class="filter-field"><label>Construtora</label><select class="input" id="sr-emp"></select></div>'+
        '<div class="filter-field filter-grow"><label>Busca</label><input class="input" type="search" id="sr-q" placeholder="Cliente, produto, corretor…"></div>'+
      '</div>'+
      '<div class="panel" style="margin-top:12px;">'+
        '<div class="panel-head"><h3>Classificar</h3>'+
          '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">'+
            '<select class="input" id="sr-regiao" style="min-width:180px;"></select>'+
            '<button class="btn btn-primary btn-sm" id="sr-aplicar" data-needs-write>Aplicar nas marcadas</button>'+
          '</div></div>'+
        '<p class="hint" id="sr-status"></p>'+
        '<div class="table-wrap"><table id="tbl-sem-regiao"><thead><tr>'+
          '<th><input type="checkbox" id="sr-all" title="Marcar as linhas deste filtro"></th>'+
          '<th>Nº</th><th>Assinatura</th><th>Cliente</th><th>Construtora</th><th>Produto</th>'+
          '<th>Unid.</th><th class="num">Valor</th><th>Corretor</th><th>Origem</th>'+
        '</tr></thead><tbody></tbody></table></div>'+
      '</div>';

    var selReg = document.getElementById("sr-regiao");
    STATE.regioes.forEach(function(r){
      if(r._apiId) selReg.appendChild(new Option(r.nome, r._apiId));
    });
    fillSelect(document.getElementById("sr-mes"),
      uniqueSorted(todas.map(mesDaVenda)).map(function(m){ return {value:m, label:mesLabel(m)}; }),
      "Todos os meses");
    fillSelect(document.getElementById("sr-emp"),
      uniqueSorted(todas.map(construtoraDaVenda)),
      "Todas as construtoras");
    if(!podeEscrever()) document.getElementById("sr-aplicar").classList.add("skip-hidden");

    function listaFiltrada(){
      return filtrarVendas(todas, {
        periodo: "all",
        status: "todas",
        mes: document.getElementById("sr-mes").value,
        emp: document.getElementById("sr-emp").value,
        q: document.getElementById("sr-q").value
      }).sort(function(a,b){
        return (b.dataAssinatura||"").localeCompare(a.dataAssinatura||"");
      });
    }
    function pintar(){
      var linhas = listaFiltrada();
      var tbody = document.querySelector("#tbl-sem-regiao tbody");
      if(!linhas.length){
        tbody.innerHTML = '<tr><td colspan="10"><div class="empty-state">Nenhuma venda sem região neste filtro.</div></td></tr>';
        return;
      }
      tbody.innerHTML = linhas.map(function(v){
        return '<tr>'+
          '<td><input type="checkbox" class="sr-check" data-pk="'+escapeHTML(String(v._apiPk||""))+'"></td>'+
          '<td class="mono">'+escapeHTML(v.numero||"")+'</td>'+
          '<td class="mono">'+fmtDateBR(v.dataAssinatura)+'</td>'+
          '<td>'+escapeHTML(v.cliente||"")+'</td>'+
          '<td>'+escapeHTML(construtoraDaVenda(v))+'</td>'+
          '<td>'+escapeHTML(v.produto||"")+'</td>'+
          '<td class="mono">'+escapeHTML(v.unidade||"")+'</td>'+
          '<td class="num mono">'+fmtBRL(v.valor)+'</td>'+
          '<td>'+escapeHTML(v.corretor||"")+'</td>'+
          '<td>'+escapeHTML(v.origem||"—")+'</td>'+
        '</tr>';
      }).join("");
      document.getElementById("sr-all").checked = false;
    }
    ["sr-mes","sr-emp"].forEach(function(id){
      document.getElementById(id).addEventListener("change", pintar);
    });
    document.getElementById("sr-q").addEventListener("input", pintar);
    document.getElementById("sr-all").addEventListener("change", function(e){
      document.querySelectorAll(".sr-check").forEach(function(c){ c.checked = e.target.checked; });
    });
    document.getElementById("sr-aplicar").addEventListener("click", function(){
      var regiaoId = document.getElementById("sr-regiao").value;
      var status = document.getElementById("sr-status");
      if(!regiaoId){
        status.textContent = "Escolha a região.";
        return;
      }
      var ids = Array.from(document.querySelectorAll(".sr-check:checked")).map(function(c){
        return Number(c.getAttribute("data-pk"));
      }).filter(function(n){ return n; });
      if(!ids.length){
        status.textContent = "Marque pelo menos uma venda.";
        return;
      }
      showLoading(true, "Definindo região…");
      FCNApi.atribuirRegiao(regiaoId, ids).then(function(res){
        return reloadFromApi().then(function(){
          showLoading(false);
          var msg = (res.atualizadas||0)+" venda(s) foram para "+(res.regiao||"a região")+".";
          toast(msg);
          if(vendasSemRegiao().length) setView("sem-regiao");
          else setView("overview");
        });
      }).catch(function(err){
        showLoading(false);
        status.textContent = err.message || "Não foi possível definir a região.";
      });
    });
    pintar();
  }

  function renderVendasTable(tbody, vendas){
    if(!vendas.length){
      tbody.innerHTML = '<tr><td colspan="14"><div class="empty-state"><div class="glyph">🗂️</div>Nenhuma venda encontrada com esses filtros.</div></td></tr>';
      return;
    }
    var rows = vendas.map(function(v){
      var faltando = camposFaltando(v);
      var statusStamp;
      if(v.dataAssinatura){
        statusStamp = '<span class="stamp ok">Assinado</span>';
      } else if(v.dataEntrada){
        var d = daysSince(v.dataEntrada);
        var limite = STATE.config.alertaDiasSemAssinatura||15;
        statusStamp = '<span class="stamp '+(d>=limite? "risk":"warn")+'">'+d+'d sem assinar</span>';
      } else {
        statusStamp = '<span class="stamp warn">Em aberto</span>';
      }
      return '<tr class="'+(faltando.length?"row-flagged":"")+'" data-id="'+v.id+'">'+
        '<td class="mono">'+escapeHTML(v.numero||"")+'</td>'+
        '<td class="mono">'+fmtDateBR(v.dataAssinatura)+'</td>'+
        '<td>'+escapeHTML(v.cliente||"")+'</td>'+
        '<td class="mono">'+(v.telefone? escapeHTML(v.telefone) : '<span class="badge-empty">—</span>')+'</td>'+
        '<td>'+escapeHTML(construtoraDaVenda(v))+'</td>'+
        '<td>'+escapeHTML(v.produto||"")+'</td>'+
        '<td class="mono">'+escapeHTML(v.blocoQuadra||"")+'</td>'+
        '<td class="mono">'+escapeHTML(v.unidade||"")+'</td>'+
        '<td class="num mono">'+fmtBRL(v.valor)+'</td>'+
        '<td class="num mono">'+fmtBRL(v.comissao)+'</td>'+
        '<td>'+escapeHTML(v.corretor||"")+'</td>'+
        '<td>'+(v.origem? escapeHTML(v.origem):'—')+'</td>'+
        '<td>'+statusStamp+'</td>'+
        '<td><button class="btn btn-ghost btn-sm" data-edit="'+v.id+'">Editar</button></td>'+
      '</tr>';
    }).join("");
    tbody.innerHTML = rows;
    tbody.querySelectorAll("[data-edit]").forEach(function(btn){
      btn.addEventListener("click", function(){ abrirModalVenda(btn.dataset.edit); });
    });
  }

  /* ============================================================
     RENDER: VENDAS PERDIDAS
     ============================================================ */
  function renderPerdidas(){
    var root = ensureViewContainer("perdidas");
    var lista = STATE.vendasPerdidas.slice().sort(function(a,b){
      return (b.ano-a.ano) || ((b.mesNum||0)-(a.mesNum||0));
    });

    var porMes = {};
    lista.forEach(function(p){ var k=p.mes; porMes[k]=(porMes[k]||0)+1; });

    root.innerHTML =
      '<div class="section-title"><h2>Vendas perdidas</h2>'+
      '<span class="hint">'+lista.length+' negociações perdidas registradas · defina uma estratégia de recuperação para cada uma</span></div>'+
      '<div class="kpi-row">'+
        kpiCard("Total perdidas", fmtNum(lista.length), "no período registrado", "accent-brick")+
        kpiCard("Sem estratégia definida", fmtNum(lista.filter(function(p){return !p.estrategia;}).length), "defina uma ação de recuperação", "accent-gold")+
        kpiCard("Mês com mais perdas", topKey(porMes)||"—", "revise o funil deste mês", "")+
      '</div>'+
      '<div class="panel-head" style="margin-top:22px;">'+
        '<h3 style="font-family:var(--font-display);">Registros</h3>'+
        '<button class="btn btn-primary btn-sm" id="btn-add-perdida">+ Registrar venda perdida</button>'+
      '</div>'+
      '<div id="lost-grid" class="lost-grid" style="margin-top:12px;"></div>';

    document.getElementById("btn-add-perdida").addEventListener("click", function(){ abrirModalPerdida(null); });

    var grid = document.getElementById("lost-grid");
    if(!lista.length){
      grid.innerHTML = '<div class="empty-state"><div class="glyph">✅</div>Nenhuma venda perdida registrada.</div>';
      return;
    }
    grid.innerHTML = lista.map(function(p){
      return '<div class="lost-card" data-id="'+p.id+'">'+
        '<div class="lc-top"><div><div class="lc-name">'+escapeHTML(p.cliente)+'</div>'+
          '<div class="lc-meta">'+escapeHTML(construtoraDaVenda(p)||p.empreendimento||"")+' · '+escapeHTML(p.produto||"")+'</div>'+
          '<div class="lc-meta">Corretor: '+escapeHTML(p.corretor||"—")+' · '+escapeHTML(p.telefone||"sem telefone")+'</div></div>'+
          '<span class="lc-month">'+escapeHTML(p.mes)+"/"+p.ano+'</span></div>'+
        '<div class="lc-reason">'+escapeHTML(p.motivo||"Motivo não informado")+'</div>'+
        '<div class="lc-strategy '+(p.estrategia?"":"empty")+'">'+(p.estrategia? escapeHTML(p.estrategia) : "Sem estratégia de recuperação definida ainda.")+'</div>'+
        '<div class="lc-actions">'+
          '<button class="btn btn-ghost btn-sm" data-strategy="'+p.id+'">Definir estratégia</button>'+
          '<button class="btn btn-ghost btn-sm" data-edit-lost="'+p.id+'">Editar</button>'+
        '</div></div>';
    }).join("");

    grid.querySelectorAll("[data-strategy]").forEach(function(btn){
      btn.addEventListener("click", function(){ definirEstrategia(btn.dataset.strategy); });
    });
    grid.querySelectorAll("[data-edit-lost]").forEach(function(btn){
      btn.addEventListener("click", function(){ abrirModalPerdida(btn.dataset.editLost); });
    });
  }

  function topKey(map){
    var best=null,bestN=-1;
    Object.keys(map).forEach(function(k){ if(map[k]>bestN){bestN=map[k]; best=k;} });
    return best;
  }

  function definirEstrategia(id){
    var p = STATE.vendasPerdidas.find(function(x){return String(x.id)===String(id);});
    if(!p) return;
    var val = window.prompt("Estratégia para tentar reverter a venda de \""+p.cliente+"\":", p.estrategia||"");
    if(val===null) return;
    p.estrategia = val.trim();
    if(useApi()){
      var pk = apiPk(p);
      if(!pk){ toast("Registro sem id na API."); return; }
      FCNApi.savePerdida({ estrategia: p.estrategia }, pk).then(function(){
        return reloadFromApi();
      }).then(function(){
        toast("Estratégia salva na API.");
      }).catch(function(err){ toast(err.message); });
      return;
    }
    markDirty();
    renderPerdidas();
    toast("Estratégia salva.");
  }

  /* ============================================================
     RENDER: DADOS & CONFIG
     ============================================================ */
  function renderDados(){
    var root = ensureViewContainer("dados");
    root.innerHTML =
      '<div class="section-title"><h2>Dados &amp; configuração</h2>'+
      '<span class="hint">Fonte da verdade: servidor (API). Export é só backup.</span></div>'+

      '<div class="config-grid">'+
        '<div class="panel">'+
          '<div class="panel-head"><h3>1. Backup (exportar JSON)</h3></div>'+
          '<p class="hint">Baixe um snapshot do estado atual. No dia a dia as edições já gravaram no banco ao salvar.</p>'+
          '<button class="btn btn-dark" id="btn-export">⭳ Baixar dados.json</button>'+
        '</div>'+

        '<div class="panel">'+
          '<div class="panel-head"><h3>2. Identidade visual</h3></div>'+
          '<p class="hint">Troque o logotipo (PNG/SVG) — redimensionado até ~350 KB antes de salvar.</p>'+
          '<div class="dropzone" id="dropzone-logo">🖼️ Clique para escolher outro logotipo (PNG/SVG)</div>'+
          '<input type="file" id="file-logo" accept="image/*" class="skip-hidden">'+
        '</div>'+
      '</div>'+

      '<div class="panel" style="margin-top:18px;">'+
        '<div class="panel-head"><h3>3. Importar planilha (CSV ou XLSX)</h3></div>'+
        '<p class="hint">Envie o arquivo de vendas. O sistema lê o cabeçalho (Cliente, Nº, Assinatura, Empreendimento, Valor…) em qualquer ordem. A região pode ficar em branco: as vendas entram e você escolhe o polo depois. Se a planilha tiver a coluna Região, cada linha já vai para o polo certo.</p>'+
        '<div class="form-grid">'+
          '<div class="field span-2"><label>Arquivo</label><input class="input" type="file" id="file-vendas" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"></div>'+
          '<div class="field"><label>Região agora (opcional)</label><select class="input" id="file-regiao"><option value="">Definir depois</option></select></div>'+
          '<div class="field" style="display:flex;align-items:flex-end;">'+
            '<label style="display:flex;align-items:center;gap:8px;font-size:.82rem;font-weight:500;text-transform:none;letter-spacing:0;color:var(--ink-text);"><input type="checkbox" id="file-substituir" data-needs-admin> Substituir as vendas antes de importar</label>'+
          '</div>'+
        '</div>'+
        '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;">'+
          '<button class="btn btn-primary" id="btn-import-arquivo" data-needs-write>Importar arquivo</button>'+
          '<button class="btn btn-dark" id="btn-limpar-vendas" data-needs-admin>Limpar todas as vendas</button>'+
        '</div>'+
        '<p class="hint" id="file-import-status" style="margin-top:12px;"></p>'+
        '<div id="sem-regiao-box" class="skip-hidden" style="margin-top:14px;padding-top:12px;border-top:1px solid var(--line, rgba(0,0,0,.08));">'+
          '<p class="hint" id="sem-regiao-texto"></p>'+
          '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;">'+
            '<div class="field" style="min-width:220px;margin:0;"><label>Região dessas vendas</label><select class="input" id="atribuir-regiao"></select></div>'+
            '<button class="btn btn-primary" id="btn-atribuir-regiao" data-needs-write>Aplicar em todas</button>'+
          '</div>'+
        '</div>'+
      '</div>'+

      '<div class="panel" style="margin-top:18px;">'+
        '<div class="panel-head"><h3>4. Conectar à planilha do Google</h3>'+
          '<button class="btn btn-dark btn-sm" id="btn-fetch-all" data-needs-write>⟳ Atualizar tudo agora</button></div>'+
        '<p class="hint">Publique cada aba/mês como CSV. Só links <b>https://</b> de <b>docs.google.com</b> / <b>spreadsheets.google.com</b>. A sincronização roda no servidor.</p>'+
        '<ol class="steps">'+
          '<li>Na planilha: <b>Arquivo → Compartilhar → Publicar na Web</b>.</li>'+
          '<li>Escolha a aba do mês (ex.: JUNHO), formato <b>CSV</b>, publique e copie o link.</li>'+
          '<li>Cadastre abaixo na <b>região</b> correspondente (Lauro, Camaçari…). Marque “Atualizar sozinho” para sync ao abrir.</li>'+
        '</ol>'+
        '<div id="csv-sources-list" style="display:flex;flex-direction:column;gap:8px;margin:14px 0;"></div>'+
        '<div class="form-grid">'+
          '<div class="field span-2"><label>Apelido da fonte</label><input class="input" id="csv-label" placeholder="ex.: Lauro de Freitas — Junho/2026"></div>'+
          '<div class="field span-2"><label>Link CSV publicado</label><input class="input" type="url" id="csv-url" placeholder="Cole aqui o link …/pub?...output=csv"></div>'+
          '<div class="field"><label>Região do painel</label><select class="input" id="csv-regiao"></select></div>'+
          '<div class="field" style="display:flex;align-items:flex-end;">'+
            '<label style="display:flex;align-items:center;gap:8px;font-size:.82rem;font-weight:500;text-transform:none;letter-spacing:0;color:var(--ink-text);"><input type="checkbox" id="csv-auto"> Atualizar sozinho ao abrir o painel</label>'+
          '</div>'+
        '</div>'+
        '<div style="margin-top:10px;"><button class="btn btn-primary" id="btn-add-source" data-needs-admin>+ Salvar fonte</button></div>'+
        '<p class="hint" id="csv-status" style="margin-top:12px;"></p>'+
        '<div class="mono-note">Ordem de colunas no CSV (como na planilha):<br>'+
        '<b>Nº, Assinatura, Cliente, Telefone, Empreendimento → construtora, Produto, Bl./Qd., Unidade, Valor, %, Comissão, Corretor, Origem, Financiado</b><br>'+
        'A <b>região</b> do painel vem da fonte cadastrada acima — não de uma coluna do CSV.</div>'+
      '</div>'+

      '<div class="config-grid" style="margin-top:18px;">'+
        '<div class="panel">'+
          '<div class="panel-head"><h3>Alertas</h3></div>'+
          '<div class="field"><label>Alertar quando faltar assinatura por mais de (dias)</label>'+
            '<input class="input" type="number" min="1" id="cfg-dias" style="width:120px;" value="'+(STATE.config.alertaDiasSemAssinatura||15)+'"></div>'+
          '<div class="field" style="margin-top:12px;"><label>Campos obrigatórios (geram alerta de "falta de informação")</label>'+
            '<div class="checklist" id="cfg-campos"></div></div>'+
        '</div>'+
        '<div class="panel" data-needs-admin id="panel-usuarios">'+
          '<div class="panel-head"><h3>Equipe (convites)</h3></div>'+
          '<p class="hint">Só admin. Papéis: admin, operador, visualizador.</p>'+
          '<div id="usuarios-list" class="table-wrap" style="margin-bottom:12px;"></div>'+
          '<div class="form-grid">'+
            '<div class="field"><label>Usuário</label><input class="input" id="invite-user"></div>'+
            '<div class="field"><label>E-mail</label><input class="input" id="invite-email" type="email"></div>'+
            '<div class="field"><label>Senha inicial</label><input class="input" id="invite-pass" type="password" minlength="8"></div>'+
            '<div class="field"><label>Papel</label><select class="input" id="invite-papel">'+
              '<option value="operador">Operador</option>'+
              '<option value="visualizador">Visualizador</option>'+
              '<option value="admin">Admin</option></select></div>'+
          '</div>'+
          '<button type="button" class="btn btn-primary" id="btn-invite-user" style="margin-top:10px;">Convidar</button>'+
          '<p class="hint" id="invite-status" style="margin-top:8px;"></p>'+
        '</div>'+
      '</div>';

    var campos = ["cliente","telefone","construtora","produto","valor","corretor","blocoQuadra","unidade","origem"];
    var box = document.getElementById("cfg-campos");
    campos.forEach(function(c){
      var checked = (STATE.config.camposObrigatorios||[]).indexOf(c)>-1;
      var label = el("label","");
      label.innerHTML = '<input type="checkbox" value="'+c+'" '+(checked?"checked":"")+'> '+(CAMPO_LABEL[c]||c);
      box.appendChild(label);
    });
    box.addEventListener("change", function(){
      var vals = Array.from(box.querySelectorAll("input:checked")).map(function(i){return i.value;});
      STATE.config.camposObrigatorios = vals;
      scheduleConfigSave();
    });
    document.getElementById("cfg-dias").addEventListener("change", function(e){
      STATE.config.alertaDiasSemAssinatura = parseInt(e.target.value,10) || 15;
      scheduleConfigSave();
    });

    var csvRegiaoSel = document.getElementById("csv-regiao");
    var fileRegiaoSel = document.getElementById("file-regiao");
    var atribuirSel = document.getElementById("atribuir-regiao");
    STATE.regioes.forEach(function(r){
      csvRegiaoSel.appendChild(new Option(r.nome, r.nome));
      if(r._apiId){
        fileRegiaoSel.appendChild(new Option(r.nome, r._apiId));
        atribuirSel.appendChild(new Option(r.nome, r._apiId));
      }
    });
    var semRegiao = (STATE.vendas||[]).filter(function(v){ return !(v.regiao||"").trim(); }).length;
    var semBox = document.getElementById("sem-regiao-box");
    if(semRegiao){
      semBox.classList.remove("skip-hidden");
      document.getElementById("sem-regiao-texto").textContent = semRegiao+" venda(s) sem região. Abra a aba Sem região para ver cada venda e classificar. O botão abaixo aplica o polo em todas de uma vez.";
    }
    document.getElementById("btn-import-arquivo").addEventListener("click", importarArquivoVendas);
    document.getElementById("btn-limpar-vendas").addEventListener("click", limparVendasPainel);
    document.getElementById("btn-atribuir-regiao").addEventListener("click", atribuirRegiaoImportada);

    renderCSVSources();
    document.getElementById("btn-add-source").addEventListener("click", adicionarFonteCSV);
    document.getElementById("btn-fetch-all").addEventListener("click", function(){ buscarTodasFontes(true); });
    document.getElementById("btn-export").addEventListener("click", exportarJSON);

    var dzLogo = document.getElementById("dropzone-logo");
    var fiLogo = document.getElementById("file-logo");
    dzLogo.addEventListener("click", function(){ fiLogo.click(); });
    fiLogo.addEventListener("change", function(){
      var f = fiLogo.files[0]; if(!f) return;
      compressLogoFile(f, function(safe, errMsg){
        if(!safe){
          toast(errMsg || "Arquivo de logo rejeitado. Use PNG, JPEG, GIF, WebP ou SVG.");
          fiLogo.value = "";
          return;
        }
        STATE.logoDataUrl = safe;
        renderMasthead();
        if(!requireApi()) return;
        if(!podeAdministrar()){
          toast("Só administradores alteram o logotipo.");
          return;
        }
        saveConfigToApi({ logoDataUrl: safe }).then(function(){
          toast("Logotipo salvo na API.");
        }).catch(function(err){ toast(err.message); });
      });
    });
    applyRoleUI();
    wireUsuariosPanel();
  }

  function wireUsuariosPanel(){
    if(!podeAdministrar() || !FCNApi.listUsuarios) return;
    var list = document.getElementById("usuarios-list");
    var status = document.getElementById("invite-status");
    function refresh(){
      FCNApi.listUsuarios().then(function(users){
        if(!list) return;
        if(!users.length){
          list.innerHTML = emptyStateHTML("Nenhum usuário", "Convide a equipe abaixo.");
          return;
        }
        var html = '<table><thead><tr><th>Usuário</th><th>E-mail</th><th>Papel</th></tr></thead><tbody>';
        users.forEach(function(u){
          html += '<tr><td>'+escapeHTML(u.username)+'</td><td>'+escapeHTML(u.email||"—")+'</td><td>'+escapeHTML(u.papel)+'</td></tr>';
        });
        html += '</tbody></table>';
        list.innerHTML = html;
      }).catch(function(err){
        if(list) list.innerHTML = emptyStateHTML("Não foi possível listar", err.message);
      });
    }
    refresh();
    var btn = document.getElementById("btn-invite-user");
    if(!btn) return;
    btn.addEventListener("click", function(){
      var payload = {
        username: (document.getElementById("invite-user").value||"").trim(),
        email: (document.getElementById("invite-email").value||"").trim(),
        password: document.getElementById("invite-pass").value||"",
        papel: document.getElementById("invite-papel").value
      };
      if(!payload.username || payload.password.length<8){
        if(status) status.textContent = "Usuário e senha (mín. 8) são obrigatórios.";
        return;
      }
      setBusy(btn, true, "Convidando…");
      FCNApi.inviteUsuario(payload).then(function(){
        if(status) status.textContent = "Usuário criado.";
        document.getElementById("invite-user").value = "";
        document.getElementById("invite-email").value = "";
        document.getElementById("invite-pass").value = "";
        refresh();
        toast("Usuário convidado.");
      }).catch(function(err){
        if(status) status.textContent = err.message;
      }).then(function(){ setBusy(btn, false); });
    });
  }

  function importarArquivo(){
    toast("Import JSON local desativado. Os dados vêm do servidor.");
  }

  function exportarJSON(){
    STATE.atualizadoEm = new Date().toISOString();
    var blob = new Blob([JSON.stringify(STATE, null, 2)], {type:"application/json"});
    var a = document.createElement("a");
    var url = URL.createObjectURL(blob);
    a.href = url;
    a.download = "dados.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function(){ URL.revokeObjectURL(url); }, 1500);
    clearDirtyAfterExport();
    toast("Backup dados.json baixado.");
  }

  function parseCSVLine(line){
    var out=[], cur="", inQ=false;
    for(var i=0;i<line.length;i++){
      var c = line[i];
      if(c==='"'){ inQ = !inQ; continue; }
      if(c===',' && !inQ){ out.push(cur); cur=""; continue; }
      cur+=c;
    }
    out.push(cur);
    return out;
  }
  function brDateToISO(s){
    s=(s||"").trim();
    var m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if(!m) return null;
    var dia = parseInt(m[1],10), mes = parseInt(m[2],10), ano = parseInt(m[3],10);
    if(mes<1 || mes>12 || dia<1 || dia>31) return null;
    var iso = ano+"-"+String(mes).padStart(2,"0")+"-"+String(dia).padStart(2,"0");
    var d = new Date(iso+"T00:00:00");
    if(isNaN(d.getTime()) || d.getFullYear()!==ano || (d.getMonth()+1)!==mes || d.getDate()!==dia) return null;
    return iso;
  }
  function brMoneyToNumber(s){
    // aceita tanto formato brasileiro (R$ 243.315,51) quanto "cru" vindo de
    // planilhas publicadas sem formatação (243315.51).
    s=(s||"").toString().replace(/[R$\s]/g,"");
    if(!s) return 0;
    var hasComma = s.indexOf(",")>-1;
    var hasDot = s.indexOf(".")>-1;
    if(hasComma && hasDot){
      s = s.replace(/\./g,"").replace(",",".");            // 243.315,51 -> 243315.51
    } else if(hasComma && !hasDot){
      s = s.replace(",",".");                                // 243315,51 -> 243315.51
    } else if(hasDot && !hasComma){
      var parts = s.split(".");
      if(parts.length>2 || (parts.length===2 && parts[1].length===3)){
        s = s.replace(/\./g,"");                             // 243.315 (milhar) -> 243315
      } // senão, já está em formato decimal (243315.51) — mantém
    }
    var n = parseFloat(s);
    return isNaN(n)?0:n;
  }

  /* ---- fontes CSV salvas (config.fontesCSV) ---- */
  function getFontes(){
    if(!STATE.config.fontesCSV) STATE.config.fontesCSV = [];
    return STATE.config.fontesCSV;
  }

  function renderCSVSources(){
    var box = document.getElementById("csv-sources-list");
    if(!box) return;
    var fontes = getFontes();
    if(!fontes.length){
      box.innerHTML = '<div class="hint">Nenhuma fonte cadastrada ainda — adicione a primeira logo abaixo.</div>';
      return;
    }
    box.innerHTML = fontes.map(function(f){
      return '<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--paper-dim);border:1px solid var(--paper-line);border-radius:10px;flex-wrap:wrap;" data-source="'+f.id+'">'+
        '<div style="flex:1;min-width:160px;"><strong style="font-size:.85rem;">'+escapeHTML(f.label||"(sem apelido)")+'</strong>'+
        '<div class="hint" style="word-break:break-all;">'+escapeHTML(f.url)+'</div></div>'+
        '<span class="lc-month">'+escapeHTML(f.regiao)+'</span>'+
        (f.auto? '<span class="stamp ok" style="transform:none;">auto</span>' : '')+
        (f.ultimaBusca? '<span class="hint">últ.: '+new Date(f.ultimaBusca).toLocaleString("pt-BR")+'</span>' : '')+
        '<button class="btn btn-ghost btn-sm" data-fetch-one="'+f.id+'">Buscar</button>'+
        '<button class="btn btn-ghost btn-sm" data-remove-source="'+f.id+'">Remover</button>'+
      '</div>';
    }).join("");
    box.querySelectorAll("[data-fetch-one]").forEach(function(btn){
      btn.addEventListener("click", function(){ buscarUmaFonte(btn.dataset.fetchOne, true); });
    });
    box.querySelectorAll("[data-remove-source]").forEach(function(btn){
      btn.addEventListener("click", function(){
        var fonte = getFontes().find(function(f){ return f.id===btn.dataset.removeSource; });
        if(useApi()){
          var pk = apiPk(fonte);
          if(!pk){ toast("Fonte sem id na API."); return; }
          if(!window.confirm("Remover esta fonte CSV?")) return;
          FCNApi.deleteFonte(pk).then(function(){
            return reloadFromApi();
          }).then(function(){
            toast("Fonte removida.");
          }).catch(function(err){ toast(err.message); });
          return;
        }
        STATE.config.fontesCSV = getFontes().filter(function(f){return f.id!==btn.dataset.removeSource;});
        markDirty();
        renderCSVSources();
      });
    });
  }

  var MESES_NOME_NUM = {
    janeiro:1, fevereiro:2, marco:3, abril:4, maio:5, junho:6,
    julho:7, agosto:8, setembro:9, outubro:10, novembro:11, dezembro:12
  };

  /** Infere YYYY-MM a partir de fonte.mesRef ou do apelido (ex.: "Lauro — Julho/2026"). */
  function inferMesRefFonte(fonte){
    if(!fonte) return null;
    if(fonte.mesRef && /^\d{4}-\d{2}$/.test(fonte.mesRef)) return fonte.mesRef;
    var label = String(fonte.label||"");
    var mIso = label.match(/(20\d{2})-(\d{2})/);
    if(mIso) return mIso[1]+"-"+mIso[2];
    var mBr = label.match(/(\d{1,2})\/(20\d{2})/);
    if(mBr) return mBr[2]+"-"+String(mBr[1]).padStart(2,"0");
    var mNome = label.match(/(janeiro|fevereiro|mar[cç]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\s*\/?\s*(20\d{2})/i);
    if(mNome){
      var key = mNome[1].toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");
      var n = MESES_NOME_NUM[key];
      if(n) return mNome[2]+"-"+String(n).padStart(2,"0");
    }
    return null;
  }

  function mesRefDaVenda(v, mesRefFonte){
    if(v && v.mes && /^\d{4}-\d{2}$/.test(v.mes)) return v.mes;
    if(v && v.dataAssinatura && v.dataAssinatura.length>=7) return v.dataAssinatura.slice(0,7);
    if(v && v.dataEntrada && v.dataEntrada.length>=7) return v.dataEntrada.slice(0,7);
    return mesRefFonte || null;
  }

  function adicionarFonteCSV(){
    if(!podeAdministrar()){
      toast("Só administradores cadastram fontes CSV.");
      return;
    }
    var label = document.getElementById("csv-label").value.trim();
    var url = document.getElementById("csv-url").value.trim();
    var regiao = document.getElementById("csv-regiao").value;
    var auto = document.getElementById("csv-auto").checked;
    var status = document.getElementById("csv-status");
    if(!url){ status.textContent = "Cole um link CSV publicado antes de salvar."; return; }
    var checkUrl = urlCSVPermitida(url);
    if(!checkUrl.ok){ status.textContent = checkUrl.erro; return; }
    var entry = {id:uid(), label:label||url, url:url, regiao:regiao, auto:auto, ultimaBusca:null};
    var mesRef = inferMesRefFonte(entry);
    if(mesRef) entry.mesRef = mesRef;

    if(useApi()){
      var empId = EMP_ID_BY_NOME[(regiao||"").toUpperCase()];
      if(!empId){
        status.textContent = "Selecione uma região cadastrada na API.";
        return;
      }
      FCNApi.createFonte({
        label: entry.label,
        url: entry.url,
        regiao: empId,
        empreendimento: empId,
        regiao_nome: regiao,
        auto: auto,
        mes_ref: mesRef || null,
        legado_id: entry.id
      }).then(function(){
        document.getElementById("csv-label").value = "";
        document.getElementById("csv-url").value = "";
        document.getElementById("csv-auto").checked = false;
        return reloadFromApi();
      }).then(function(){
        status.textContent = "Fonte salva na API"+(mesRef? " (mês "+mesRef+")":"")+".";
        toast("Fonte CSV salva.");
      }).catch(function(err){
        status.textContent = err.message;
        toast(err.message);
      });
      return;
    }

    getFontes().push(entry);
    markDirty();
    document.getElementById("csv-label").value = "";
    document.getElementById("csv-url").value = "";
    document.getElementById("csv-auto").checked = false;
    renderCSVSources();
    status.textContent = "Fonte salva"+(mesRef? " (mês de referência "+mesRef+")":"")+". Clique em \"Buscar\" para trazer as vendas agora, ou em \"Atualizar tudo agora\" para buscar todas de uma vez.";
  }

  /**
   * Match seguro (não usa Nº sozinho):
   * 1) região + número + mês (YYYY-MM)
   * 2) fallback: região + cliente + unidade + construtora (1 hit)
   * Ambíguos → conflito (não aplica).
   */
  function encontrarVendaExistente(v, mesRefFonte){
    var mesmaRegiao = function(x){
      return (x.regiao||"").toUpperCase() === (v.regiao||"").toUpperCase();
    };
    var mesRef = mesRefDaVenda(v, mesRefFonte);

    if(v.numero && mesRef){
      var porNumMes = STATE.vendas.filter(function(x){
        if(!mesmaRegiao(x) || !x.numero || String(x.numero)!==String(v.numero)) return false;
        var xm = mesRefDaVenda(x, null);
        return xm && xm===mesRef;
      });
      if(porNumMes.length===1) return {venda:porNumMes[0], conflito:false};
      if(porNumMes.length>1) return {venda:null, conflito:true};
    }

    if(v.cliente){
      var porCliente = STATE.vendas.filter(function(x){
        return mesmaRegiao(x) && x.cliente &&
          x.cliente.toLowerCase()===v.cliente.toLowerCase() &&
          (x.unidade||"")===(v.unidade||"") &&
          construtoraDaVenda(x)===construtoraDaVenda(v);
      });
      if(porCliente.length===1) return {venda:porCliente[0], conflito:false};
      if(porCliente.length>1) return {venda:null, conflito:true};
    }
    return {venda:null, conflito:false};
  }

  /** true se o valor do CSV/import deve sobrescrever o existente (vazio/null não sobrescreve). */
  function valorPreenchido(val){
    if(val===undefined || val===null || val==="") return false;
    if(typeof val==="number" && isNaN(val)) return false;
    return true;
  }

  /**
   * Merge parcial: só aplica campos preenchidos do importado.
   * forcarLimpar (futuro): array de chaves a zerar mesmo se o import vier vazio.
   */
  function mergeCamposPreenchidos(existente, importado, forcarLimpar){
    forcarLimpar = forcarLimpar || [];
    Object.keys(importado).forEach(function(k){
      if(k==="id") return;
      if(forcarLimpar.indexOf(k)>-1){
        existente[k] = importado[k];
        return;
      }
      if(valorPreenchido(importado[k])) existente[k] = importado[k];
    });
    existente.id = existente.id;
    existente.exemplo = false;
  }

  function mergeVendasImportadas(lista, mesRefFonte){
    var novas=0, atualizadas=0, conflitos=0;
    lista.forEach(function(v){
      var hit = encontrarVendaExistente(v, mesRefFonte);
      if(hit.conflito){ conflitos++; return; }
      if(hit.venda){
        mergeCamposPreenchidos(hit.venda, v, []);
        atualizadas++;
      } else {
        if(v.valor==null) v.valor = 0;
        if(v.comissao==null) v.comissao = 0;
        STATE.vendas.push(v);
        novas++;
      }
    });
    if(novas || atualizadas) markDirty();
    return {novas:novas, atualizadas:atualizadas, conflitos:conflitos};
  }

  function formatMergeResumo(res){
    var parts = [res.novas+" novas", res.atualizadas+" atualizadas"];
    if(res.conflitos) parts.push(res.conflitos+" conflito(s) ignorado(s)");
    return parts.join(", ");
  }

  function parseCSVParaVendas(text, regiaoNome, mesRefFonte){
    var lines = text.split(/\r?\n/).filter(function(l){return l.trim().length;});
    var out = [];
    lines.forEach(function(line, idx){
      var cols = parseCSVLine(line);
      if(idx===0 && /assinatura|cliente/i.test(line)) return; // pula cabeçalho
      if(cols.length<9) return;
      var dataISO = brDateToISO(cols[1]);
      var mes = dataISO ? dataISO.slice(0,7) : (mesRefFonte || null);
      var rawValor = (cols[8]||"").trim();
      var rawComissao = (cols[10]||"").trim();
      var rawPerc = (cols[9]||"").trim();
      var venda = {
        id: uid(),
        regiao: regiaoNome,
        numero: (cols[0]||"").trim(),
        dataAssinatura: dataISO,
        dataEntrada: null,
        mes: mes,
        cliente: titleCase((cols[2]||"").trim()),
        telefone: (cols[3]||"").trim(),
        construtora: (cols[4]||"").trim().toUpperCase(),
        produto: titleCase((cols[5]||"").trim()),
        blocoQuadra: (cols[6]||"").trim(),
        unidade: (cols[7]||"").trim(),
        valor: rawValor==="" ? null : brMoneyToNumber(rawValor),
        percentual: rawPerc==="" ? null : parseFloat(rawPerc.replace("%","").replace(",",".")),
        comissao: rawComissao==="" ? null : brMoneyToNumber(rawComissao),
        corretor: titleCase((cols[11]||"").trim()),
        origem: titleCase((cols[12]||"").trim()),
        financiado: titleCase((cols[13]||"").trim())
      };
      venda.empreendimento = venda.construtora;
      if(venda.cliente) out.push(venda);
    });
    return out;
  }

  function buscarUmaFonte(id, manual){
    var fonte = getFontes().find(function(f){return f.id===id;});
    if(!fonte) return Promise.resolve({novas:0,atualizadas:0,conflitos:0,erro:"fonte não encontrada"});
    var status = document.getElementById("csv-status");

    if(useApi()){
      var pk = apiPk(fonte);
      if(!pk){
        if(manual && status) status.textContent = "Fonte sem id na API.";
        return Promise.resolve({novas:0,atualizadas:0,conflitos:0,erro:"sem id"});
      }
      if(manual && status) status.textContent = "Buscando \""+fonte.label+"\" via API…";
      return FCNApi.syncFonte(pk).then(function(res){
        return reloadFromApi().then(function(){
          if(manual){
            var msg = "\""+fonte.label+"\": "+formatMergeResumo(res)+".";
            if(status) status.textContent = msg;
            toast(fonte.label+": "+formatMergeResumo(res)+".");
          }
          return res;
        });
      }).catch(function(err){
        if(manual && status) status.textContent = "Erro na fonte \""+fonte.label+"\": "+err.message;
        return {novas:0, atualizadas:0, conflitos:0, erro:err.message};
      });
    }

    var checkUrl = urlCSVPermitida(fonte.url);
    if(!checkUrl.ok){
      if(manual && status) status.textContent = checkUrl.erro;
      return Promise.resolve({novas:0,atualizadas:0,conflitos:0,erro:checkUrl.erro});
    }
    if(manual && status) status.textContent = "Buscando \""+fonte.label+"\"…";
    var mesRef = inferMesRefFonte(fonte);
    return fetch(fonte.url).then(function(r){
      if(!r.ok) throw new Error("HTTP "+r.status);
      return r.text();
    }).then(function(text){
      if(!textoPareceCSVVendas(text)) throw new Error("conteúdo não parece CSV de vendas");
      var lista = parseCSVParaVendas(text, fonte.regiao, mesRef);
      var res = mergeVendasImportadas(lista, mesRef);
      fonte.ultimaBusca = new Date().toISOString();
      if(mesRef && !fonte.mesRef) fonte.mesRef = mesRef;
      if(manual){
        renderAll();
        var msg = "\""+fonte.label+"\": "+formatMergeResumo(res)+".";
        if(status) status.textContent = msg;
        toast(fonte.label+": "+formatMergeResumo(res)+".");
      }
      return res;
    }).catch(function(err){
      if(manual && status) status.textContent = "Não consegui buscar \""+fonte.label+"\" — verifique se está publicada na web. Detalhe: "+err.message;
      return {novas:0, atualizadas:0, conflitos:0, erro:err.message};
    });
  }

  function resumoImportacao(res){
    var partes = [formatMergeResumo(res)];
    if(res.linhas != null) partes.push(res.linhas+" linha(s)");
    if(res.regioes && res.regioes.length) partes.push("regiões: "+res.regioes.join(", "));
    if(res.sem_regiao) partes.push(res.sem_regiao+" sem região — escolha o polo abaixo");
    return partes.join(" · ");
  }

  function importarArquivoVendas(){
    var input = document.getElementById("file-vendas");
    var status = document.getElementById("file-import-status");
    var file = input && input.files && input.files[0];
    if(!file){
      if(status) status.textContent = "Escolha um arquivo .csv ou .xlsx.";
      return;
    }
    var regiaoId = document.getElementById("file-regiao").value;
    var substituir = document.getElementById("file-substituir").checked;
    if(substituir && !confirm("Isso apaga as vendas da região escolhida (ou todas, se nenhuma região estiver selecionada) e importa o arquivo no lugar. Continuar?")) return;
    if(status) status.textContent = "Importando…";
    showLoading(true, "Importando planilha…");
    FCNApi.importarArquivo(file, regiaoId, substituir).then(function(res){
      return reloadFromApi().then(function(){
        showLoading(false);
        var msg = resumoImportacao(res)+".";
        if(status) status.textContent = msg;
        toast(msg);
        input.value = "";
      });
    }).catch(function(err){
      showLoading(false);
      if(status) status.textContent = err.message || "Falha na importação.";
    });
  }

  function atribuirRegiaoImportada(){
    var sel = document.getElementById("atribuir-regiao");
    var status = document.getElementById("file-import-status");
    if(!sel || !sel.value){
      if(status) status.textContent = "Escolha a região para as vendas importadas.";
      return;
    }
    showLoading(true, "Definindo região…");
    FCNApi.atribuirRegiao(sel.value).then(function(res){
      return reloadFromApi().then(function(){
        showLoading(false);
        var msg = (res.atualizadas||0)+" venda(s) foram para "+(res.regiao||"a região")+".";
        if(status) status.textContent = msg;
        toast(msg);
      });
    }).catch(function(err){
      showLoading(false);
      if(status) status.textContent = err.message || "Não foi possível definir a região.";
    });
  }

  function limparVendasPainel(){
    if(!confirm("Apagar todas as vendas e vendas perdidas desta organização? Regiões, usuários e configurações permanecem.")) return;
    var status = document.getElementById("file-import-status");
    showLoading(true, "Limpando vendas…");
    FCNApi.limparVendas().then(function(res){
      return reloadFromApi().then(function(){
        showLoading(false);
        var msg = "Removidas "+(res.vendas||0)+" venda(s) e "+(res.perdidas||0)+" venda(s) perdida(s).";
        if(status) status.textContent = msg;
        toast(msg);
      });
    }).catch(function(err){
      showLoading(false);
      if(status) status.textContent = err.message || "Não foi possível limpar.";
    });
  }

  function buscarTodasFontes(manual){
    if(useApi()){
      var status = document.getElementById("csv-status");
      if(manual && status) status.textContent = "Atualizando fontes via API…";
      return FCNApi.syncFontes().then(function(res){
        var t = res.totais || res;
        return reloadFromApi().then(function(){
          var msg = formatMergeResumo(t)+(t.erros? ", "+t.erros+" fonte(s) com erro":"")+".";
          if(status) status.textContent = msg;
          toast("Atualização da planilha: "+msg);
        });
      }).catch(function(err){
        if(status) status.textContent = err.message;
        toast(err.message);
      });
    }
    var fontes = getFontes();
    var status = document.getElementById("csv-status");
    if(!fontes.length){
      if(manual && status) status.textContent = "Nenhuma fonte cadastrada ainda.";
      return Promise.resolve();
    }
    if(manual && status) status.textContent = "Atualizando "+fontes.length+" fonte(s)…";
    return Promise.all(fontes.map(function(f){ return buscarUmaFonte(f.id, false); })).then(function(results){
      var novas=0, atualizadas=0, conflitos=0, erros=0;
      results.forEach(function(r){
        novas+=r.novas||0; atualizadas+=r.atualizadas||0; conflitos+=r.conflitos||0;
        if(r.erro) erros++;
      });
      renderAll();
      var msg = formatMergeResumo({novas:novas,atualizadas:atualizadas,conflitos:conflitos})+(erros? ", "+erros+" fonte(s) com erro":"")+".";
      if(status) status.textContent = msg;
      toast("Atualização da planilha: "+msg);
    });
  }

  function autoAtualizarAoAbrir(){
    if(useApi()){
      if(!podeEscrever()) return;
      var fontes = getFontes().filter(function(f){return f.auto;});
      if(!fontes.length) return;
      FCNApi.syncFontes().then(function(res){
        var t = res.totais || res;
        if((t.novas||0) || (t.atualizadas||0) || (t.conflitos||0)){
          return reloadFromApi().then(function(){
            toast("Planilha sincronizada automaticamente: "+formatMergeResumo(t)+".");
          });
        }
      }).catch(function(){ /* silencioso no boot */ });
      return;
    }
    var fontes = getFontes().filter(function(f){return f.auto;});
    if(!fontes.length) return;
    Promise.all(fontes.map(function(f){ return buscarUmaFonte(f.id, false); })).then(function(results){
      var novas=0, atualizadas=0, conflitos=0;
      results.forEach(function(r){
        novas+=r.novas||0; atualizadas+=r.atualizadas||0; conflitos+=r.conflitos||0;
      });
      if(novas || atualizadas || conflitos){
        renderAll();
        toast("Planilha sincronizada automaticamente: "+formatMergeResumo({novas:novas,atualizadas:atualizadas,conflitos:conflitos})+".");
      }
    });
  }

  /* ============================================================
     MODAL: adicionar/editar venda
     ============================================================ */
  function abrirModalVenda(id, regiaoNomePreselect){
    try {
      if(!podeEscrever()){
        toast("Seu usuário é somente leitura.");
        return;
      }
      editingVendaId = id;
      var v = id ? STATE.vendas.find(function(x){return String(x.id)===String(id);}) : null;
      var backdrop = document.getElementById("modal-venda");
      if(!backdrop){ toast("Erro: modal-venda não encontrado."); return; }
      var form = document.getElementById("form-venda");
      if(!form){ toast("Erro: form-venda não encontrado."); return; }
      form.reset();
      var titleEl = document.getElementById("modal-venda-title");
      if(titleEl) titleEl.textContent = v ? "Editar venda" : "Adicionar venda";
      var subEl = document.getElementById("modal-venda-sub");
      if(subEl) subEl.textContent = v ? "Atualize os campos e salve." : "Preencha os dados — deixe a assinatura em branco se ainda estiver em negociação.";

      var regiaoSel = document.getElementById("f-regiao");
      if(regiaoSel){
        regiaoSel.innerHTML = "";
        if(STATE && STATE.regioes){
          STATE.regioes.forEach(function(r){
            var opt = document.createElement("option");
            opt.value = r.nome;
            opt.textContent = r.nome;
            regiaoSel.appendChild(opt);
          });
        }
      }

      var d = v || {regiao: regiaoNomePreselect || (STATE&&STATE.regioes&&STATE.regioes[0]&&STATE.regioes[0].nome) || ""};
      var fId = document.getElementById("f-id");
      if(fId) fId.value = v ? v.id : "";
      if(regiaoSel){
        var regiaoWanted = (d.regiao||"").toUpperCase();
        var regiaoCanon = "";
        for(var ri=0; ri<regiaoSel.options.length; ri++){
          if((regiaoSel.options[ri].value||"").toUpperCase()===regiaoWanted){
            regiaoCanon = regiaoSel.options[ri].value;
            break;
          }
        }
        regiaoSel.value = regiaoCanon || (STATE&&STATE.regioes&&STATE.regioes[0]&&STATE.regioes[0].nome) || "";
      }
      setFieldValue("f-numero", d.numero);
      setFieldValue("f-cliente", d.cliente);
      setFieldValue("f-telefone", d.telefone);
      setFieldValue("f-construtora", d.construtora || d.empreendimento);
      setFieldValue("f-produto", d.produto);
      setFieldValue("f-bloco", d.blocoQuadra);
      setFieldValue("f-unidade", d.unidade);
      setFieldValue("f-valor", d.valor);
      setFieldValue("f-percentual", d.percentual);
      setFieldValue("f-comissao", d.comissao);
      setFieldValue("f-corretor", d.corretor);
      setFieldValue("f-origem", d.origem);
      setFieldValue("f-financiado", d.financiado);
      setFieldValue("f-dataEntrada", d.dataEntrada);
      setFieldValue("f-dataAssinatura", d.dataAssinatura);

      var delBtn = document.getElementById("btn-delete-venda");
      if(delBtn) delBtn.classList.toggle("skip-hidden", !v);
      backdrop.classList.add("open");
    } catch(e){
      console.error("abrirModalVenda:", e);
      toast("Erro ao abrir o modal: "+e.message);
    }
  }

  /** Ajudante: seta value com segurança. */
  function setFieldValue(id, val){
    var el = document.getElementById(id);
    if(el) el.value = val || "";
  }
  function fecharModalVenda(){ document.getElementById("modal-venda").classList.remove("open"); editingVendaId=null; }

  function salvarVenda(e){
    e.preventDefault();
    var btn = document.getElementById("btn-save-venda");
    setBusy(btn, true, "Salvando…");
    var finishBusy = function(){ setBusy(btn, false); };
    var id = document.getElementById("f-id").value || uid();
    var dataAssinatura = document.getElementById("f-dataAssinatura").value || null;
    var regiaoNome = document.getElementById("f-regiao").value;
    var venda = {
      id:id,
      regiao: regiaoNome,
      numero: document.getElementById("f-numero").value.trim(),
      cliente: document.getElementById("f-cliente").value.trim(),
      telefone: document.getElementById("f-telefone").value.trim(),
      construtora: document.getElementById("f-construtora").value.trim().toUpperCase(),
      produto: document.getElementById("f-produto").value.trim(),
      blocoQuadra: document.getElementById("f-bloco").value.trim(),
      unidade: document.getElementById("f-unidade").value.trim(),
      valor: parseFloat(document.getElementById("f-valor").value)||0,
      percentual: document.getElementById("f-percentual").value? parseFloat(document.getElementById("f-percentual").value):null,
      comissao: parseFloat(document.getElementById("f-comissao").value)||0,
      corretor: document.getElementById("f-corretor").value.trim(),
      origem: document.getElementById("f-origem").value.trim(),
      financiado: document.getElementById("f-financiado").value.trim(),
      dataEntrada: document.getElementById("f-dataEntrada").value || null,
      dataAssinatura: dataAssinatura,
      mes: dataAssinatura ? dataAssinatura.slice(0,7) : null
    };
    // Compat: filtros/tabelas ainda leem "empreendimento" como marca/construtora
    venda.empreendimento = venda.construtora;

    if(useApi()){
      var empId = EMP_ID_BY_NOME[(regiaoNome||"").toUpperCase()];
      if(!empId){
        toast("Região sem id na API.");
        finishBusy();
        return;
      }
      var payload = {
        regiao_id: empId,
        empreendimento_id: empId,
        numero: venda.numero,
        cliente: venda.cliente,
        telefone: venda.telefone,
        construtora: venda.construtora,
        produto: venda.produto,
        bloco_quadra: venda.blocoQuadra,
        unidade: venda.unidade,
        valor: venda.valor,
        percentual: venda.percentual,
        comissao: venda.comissao,
        corretor: venda.corretor,
        origem: venda.origem,
        financiado: venda.financiado,
        dataAssinatura: venda.dataAssinatura,
        dataEntrada: venda.dataEntrada,
        mes: venda.mes
      };
      var apiId = editingVendaId ? Number(editingVendaId) : null;
      // Só considera válido se for número positivo
      if (apiId && (Number.isNaN(apiId) || apiId <= 0)) apiId = null;
      var existing = STATE.vendas.find(function(x){ return String(x.id) === String(id); });
      var promise;
      if (apiId && apiId > 0) {
        // Prioridade: _apiPk se existir, senão apiId
        var pk = (existing && existing._apiPk) || apiId;
        promise = FCNApi.saveVenda(payload, pk);
      } else if (existing && existing._apiPk) {
        promise = FCNApi.saveVenda(payload, existing._apiPk);
      } else {
        promise = FCNApi.saveVenda(payload, null);
      }
      promise.then(function(){
        fecharModalVenda();
        return reloadFromApi();
      }).then(function(){
        toast("Venda salva na API.");
      }).catch(function(err){ toast(err.message); })
      .then(finishBusy);
      return;
    }

    var idx = STATE.vendas.findIndex(function(x){return String(x.id)===String(id);});
    if(idx>-1) STATE.vendas[idx] = Object.assign({}, STATE.vendas[idx], venda);
    else STATE.vendas.push(venda);

    fecharModalVenda();
    markDirty();
    renderAll();
    finishBusy();
    toast("Venda salva.");
  }

  function excluirVenda(){
    if(!editingVendaId) return;
    if(!window.confirm("Excluir esta venda? Essa ação não pode ser desfeita.")) return;
    if(useApi()){
      var existing = STATE.vendas.find(function(x){return String(x.id)===String(editingVendaId);});
      var pk = apiPk(existing) || (/^\d+$/.test(String(editingVendaId)) ? Number(editingVendaId) : null);
      if(!pk){ toast("Venda sem id na API."); return; }
      FCNApi.deleteVenda(pk).then(function(){
        fecharModalVenda();
        return reloadFromApi();
      }).then(function(){
        toast("Venda excluída na API.");
      }).catch(function(err){ toast(err.message); });
      return;
    }
    STATE.vendas = STATE.vendas.filter(function(v){return String(v.id)!==String(editingVendaId);});
    fecharModalVenda();
    markDirty();
    renderAll();
    toast("Venda excluída.");
  }

  /* ============================================================
     MODAL: venda perdida
     ============================================================ */
  var editingPerdidaId = null;
  function abrirModalPerdida(id){
    if(!podeEscrever()){
      toast("Seu usuário é somente leitura.");
      return;
    }
    editingPerdidaId = id;
    var p = id ? STATE.vendasPerdidas.find(function(x){return String(x.id)===String(id);}) : null;
    var form = document.getElementById("form-perdida");
    form.reset();
    document.getElementById("modal-perdida-title").textContent = p ? "Editar venda perdida" : "Registrar venda perdida";
    var d = p || {ano:new Date().getFullYear()};
    document.getElementById("p-id").value = p ? p.id : "";
    document.getElementById("p-mes").value = d.mes || "Janeiro";
    document.getElementById("p-ano").value = d.ano || new Date().getFullYear();
    document.getElementById("p-cliente").value = d.cliente || "";
    document.getElementById("p-telefone").value = d.telefone || "";
    document.getElementById("p-construtora").value = d.construtora || d.empreendimento || "";
    document.getElementById("p-produto").value = d.produto || "";
    document.getElementById("p-corretor").value = d.corretor || "";
    document.getElementById("p-motivo").value = d.motivo || "";
    document.getElementById("p-estrategia").value = d.estrategia || "";
    document.getElementById("btn-delete-perdida").classList.toggle("skip-hidden", !p);
    document.getElementById("modal-perdida").classList.add("open");
  }
  function fecharModalPerdida(){ document.getElementById("modal-perdida").classList.remove("open"); editingPerdidaId=null; }

  function salvarPerdida(e){
    e.preventDefault();
    var id = document.getElementById("p-id").value || uid();
    var mesNome = document.getElementById("p-mes").value;
    var perdida = {
      id:id,
      mes:mesNome,
      mesNum: MESES_EXT.findIndex(function(m){return m.toUpperCase()===mesNome.toUpperCase();})+1,
      ano: parseInt(document.getElementById("p-ano").value,10)||new Date().getFullYear(),
      cliente: document.getElementById("p-cliente").value.trim(),
      telefone: document.getElementById("p-telefone").value.trim(),
      construtora: document.getElementById("p-construtora").value.trim(),
      produto: document.getElementById("p-produto").value.trim(),
      corretor: document.getElementById("p-corretor").value.trim(),
      motivo: document.getElementById("p-motivo").value.trim(),
      estrategia: document.getElementById("p-estrategia").value.trim()
    };
    perdida.empreendimento = perdida.construtora;

    if(useApi()){
      var existing = STATE.vendasPerdidas.find(function(x){return String(x.id)===String(id);});
      var pk = apiPk(existing);
      var payload = {
        legado_id: existing && existing.legado_id ? existing.legado_id : id,
        mes: perdida.mes,
        mesNum: perdida.mesNum,
        ano: perdida.ano,
        cliente: perdida.cliente,
        telefone: perdida.telefone,
        construtora: perdida.construtora,
        empreendimento: perdida.construtora,
        produto: perdida.produto,
        corretor: perdida.corretor,
        motivo: perdida.motivo,
        estrategia: perdida.estrategia
      };
      FCNApi.savePerdida(payload, pk).then(function(){
        fecharModalPerdida();
        return reloadFromApi();
      }).then(function(){
        toast("Venda perdida salva na API.");
      }).catch(function(err){ toast(err.message); });
      return;
    }

    var idx = STATE.vendasPerdidas.findIndex(function(x){return String(x.id)===String(id);});
    if(idx>-1) STATE.vendasPerdidas[idx] = perdida;
    else STATE.vendasPerdidas.push(perdida);
    fecharModalPerdida();
    markDirty();
    renderAll();
    toast("Venda perdida salva.");
  }
  function excluirPerdida(){
    if(!editingPerdidaId) return;
    if(!window.confirm("Excluir este registro?")) return;
    if(useApi()){
      var existing = STATE.vendasPerdidas.find(function(x){return String(x.id)===String(editingPerdidaId);});
      var pk = apiPk(existing);
      if(!pk){ toast("Registro sem id na API."); return; }
      FCNApi.deletePerdida(pk).then(function(){
        fecharModalPerdida();
        return reloadFromApi();
      }).then(function(){
        toast("Registro excluído na API.");
      }).catch(function(err){ toast(err.message); });
      return;
    }
    STATE.vendasPerdidas = STATE.vendasPerdidas.filter(function(p){return String(p.id)!==String(editingPerdidaId);});
    fecharModalPerdida();
    markDirty();
    renderAll();
    toast("Registro excluído.");
  }

  /* ============================================================
     CHARTS
     ============================================================ */
  function destroyChart(id){
    if(CHARTS[id]){ CHARTS[id].destroy(); delete CHARTS[id]; }
  }

  var PALETTE = ["#ab5236","#b8892e","#3d6b5a","#1e3348","#8c422c","#6a6258","#c9bba8","#d98f57"];

  function renderChartMonths(canvasId, vendas){
    var canvas = document.getElementById(canvasId);
    if(!canvas) return;
    destroyChart(canvasId);
    var byMonth = {};
    vendas.forEach(function(v){
      if(!v.mes) return;
      byMonth[v.mes] = byMonth[v.mes] || {vgv:0,n:0};
      byMonth[v.mes].vgv += Number(v.valor)||0;
      byMonth[v.mes].n += 1;
    });
    var meses = Object.keys(byMonth).sort();
    var labels = meses.map(mesLabel);
    var vgvData = meses.map(function(m){return Math.round(byMonth[m].vgv);});
    var nData = meses.map(function(m){return byMonth[m].n;});

    if(!meses.length){
      var ctx0 = canvas.getContext("2d");
      ctx0.clearRect(0,0,canvas.width,canvas.height);
      return;
    }

    CHARTS[canvasId] = new Chart(canvas.getContext("2d"), {
      data:{
        labels:labels,
        datasets:[
          {type:"bar", label:"VGV (R$)", data:vgvData, backgroundColor:"#ab5236", borderRadius:6, yAxisID:"y", order:2},
          {type:"line", label:"Nº de vendas", data:nData, borderColor:"#3d6b5a", backgroundColor:"#3d6b5a", tension:.35, yAxisID:"y1", order:1, pointRadius:4, pointBackgroundColor:"#3d6b5a"}
        ]
      },
      options:{
        responsive:true,
        interaction:{mode:"index", intersect:false},
        plugins:{
          legend:{labels:{color:"#152433", font:{family:"Inter", size:12}}},
          tooltip:{callbacks:{label:function(ctx){
            if(ctx.dataset.yAxisID==="y") return " "+ctx.dataset.label+": "+fmtBRL(ctx.raw);
            return " "+ctx.dataset.label+": "+ctx.raw;
          }}}
        },
        scales:{
          x:{ticks:{color:"#6a6258"}, grid:{display:false}},
          y:{position:"left", ticks:{color:"#6a6258", callback:function(v){return fmtBRL(v);}}, grid:{color:"#e0d2bc"}},
          y1:{position:"right", ticks:{color:"#6a6258", precision:0}, grid:{display:false}}
        }
      }
    });
  }

  function renderChartEmpreendimento(canvasId, vendas, campo){
    var canvas = document.getElementById(canvasId);
    if(!canvas) return;
    destroyChart(canvasId);
    campo = campo || "construtora";
    var byEmp = {};
    vendas.forEach(function(v){
      var k = (campo==="construtora" || campo==="empreendimento")
        ? (construtoraDaVenda(v) || "Outros")
        : (v[campo] || "Outros");
      byEmp[k] = (byEmp[k]||0) + (Number(v.valor)||0);
    });
    var keys = Object.keys(byEmp).sort(function(a,b){return byEmp[b]-byEmp[a];});
    if(!keys.length) return;
    var data = keys.map(function(k){return Math.round(byEmp[k]);});

    CHARTS[canvasId] = new Chart(canvas.getContext("2d"), {
      type:"doughnut",
      data:{labels:keys, datasets:[{data:data, backgroundColor:keys.map(function(_,i){return PALETTE[i%PALETTE.length];}), borderColor:"#f7f0e6", borderWidth:2}]},
      options:{
        responsive:true,
        plugins:{
          legend:{position:"bottom", labels:{color:"#152433", boxWidth:12, font:{family:"Inter", size:11}}},
          tooltip:{callbacks:{label:function(ctx){ return " "+ctx.label+": "+fmtBRL(ctx.raw); }}}
        },
        cutout:"58%"
      }
    });
  }

  /* ============================================================
     ALERTAS (lista genérica)
     ============================================================ */
  function renderAlertsInto(container, alertas){
    if(!alertas.length){
      container.innerHTML = '<div class="alert-empty">🟢 Nenhum alerta no momento. Tudo em dia!</div>';
      return;
    }
    container.innerHTML = alertas.map(function(a){
      return '<div class="alert-item sev-'+a.sev+'" data-vid="'+(a.vendaId||"")+'">'+
        '<div class="alert-icon">'+(a.tipo==="assinatura"?"⏳":"⚠")+'</div>'+
        '<div class="alert-body"><strong>'+escapeHTML(a.titulo)+'</strong><span>'+escapeHTML(a.detalhe)+'</span></div>'+
      '</div>';
    }).join("");
    container.querySelectorAll("[data-vid]").forEach(function(node){
      if(!node.dataset.vid) return;
      node.style.cursor = "pointer";
      node.addEventListener("click", function(){ abrirModalVenda(node.dataset.vid); });
    });
  }

  function escapeHTML(s){
    return String(s==null? "":s).replace(/[&<>"']/g, function(c){
      return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];
    });
  }

  /* ============================================================
     CABEÇALHO / RELÓGIO
     ============================================================ */
  function renderMasthead(){
    var logoBox = document.getElementById("brand-logo-box");
    logoBox.textContent = "";
    var logoSrc = sanitizeLogoSrc(STATE.logoDataUrl) || "logo-feliz-casa-nova.png";
    var img = document.createElement("img");
    img.src = logoSrc;
    img.alt = "Logo Feliz Casa Nova";
    logoBox.appendChild(img);
    document.getElementById("brand-name").textContent = STATE.empresa || "Feliz Casa Nova";
    updateDirtyChip();
  }
  function tickClock(){
    var now = new Date();
    var el2 = document.getElementById("clock-text");
    if(el2) el2.textContent = now.toLocaleDateString("pt-BR",{weekday:"long", day:"2-digit", month:"long"}) + " · " + now.toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"});
  }

  /* ============================================================
     BOOT
     ============================================================ */
  function renderAll(){
    renderMasthead();
    renderTabs();
    setView(CURRENT_VIEW);
    applyRoleUI();
  }

  function wireModals(){
    document.getElementById("form-venda").addEventListener("submit", salvarVenda);
    document.getElementById("btn-cancel-venda").addEventListener("click", fecharModalVenda);
    document.getElementById("btn-delete-venda").addEventListener("click", excluirVenda);
    document.getElementById("modal-venda").addEventListener("click", function(e){ if(e.target.id==="modal-venda") fecharModalVenda(); });

    document.getElementById("form-perdida").addEventListener("submit", salvarPerdida);
    document.getElementById("btn-cancel-perdida").addEventListener("click", fecharModalPerdida);
    document.getElementById("btn-delete-perdida").addEventListener("click", excluirPerdida);
    document.getElementById("modal-perdida").addEventListener("click", function(e){ if(e.target.id==="modal-perdida") fecharModalPerdida(); });

    document.getElementById("btn-global-add-venda").addEventListener("click", function(){ abrirModalVenda(null); });
    document.getElementById("btn-global-refresh").addEventListener("click", function(){
      if(!requireApi()) return;
      if(!podeEscrever()){ toast("Sem permissão para sincronizar."); return; }
      var btn = document.getElementById("btn-global-refresh");
      setBusy(btn, true, "Sincronizando…");
      showLoading(true, "Sincronizando planilha…");
      FCNApi.syncFontes().then(function(res){
        var t = res.totais || res;
        var parts = [];
        parts.push((t.novas||0)+" novas");
        parts.push((t.atualizadas||0)+" atualizadas");
        if(t.conflitos) parts.push(t.conflitos+" conflitos");
        if(t.erros) parts.push(t.erros+" fonte(s) com erro");
        toast("Sync: "+parts.join(" / "));
        if(t.erros){
          var dets = (res.resultados||[]).filter(function(r){ return r.erro; })
            .map(function(r){ return (r.label||r.id)+": "+r.erro; }).slice(0,3);
          if(dets.length) toast(dets.join(" · "));
        }
        return reloadFromApi();
      }).catch(function(err){ toast(err.message); showApiBanner(err.message); })
      .then(function(){ setBusy(btn, false); showLoading(false); });
    });
  }

  document.addEventListener("DOMContentLoaded", function(){
    clearLegacyLocalState();
    wireLogin();
    if(!window.FCNApi){
      document.body.innerHTML = "<p style='padding:2rem;font-family:sans-serif'>api.js não carregou. Suba o stack com <code>docker compose up</code>.</p>";
      return;
    }
    if(FCNApi.isLoggedIn()){
      bootWithApi();
      return;
    }
    showApp(false);
  });

})();
