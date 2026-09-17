// background.js — RASTRO-ADS 0.7.0 (service worker, Manifest V3, ES module)
//
// Cambios relevantes respecto a 0.4.1:
// - El parser de sellers.json ahora es un parser incremental real (src/lib/sellersParser.js),
//   nunca concatena el documento completo ni usa regex sobre el JSON entero.
// - Las respuestas de VirusTotal se clasifican de forma centralizada (src/lib/vtErrors.js),
//   distinguiendo ausencia de resultados de fallos reales del servicio, y redactando la API key.
// - Se añade la descarga de app-ads.txt además de ads.txt.
// - La captura de red y marcos solo permanece activa para las pestañas que el investigador
//   inicia expresamente mediante «Recargar y capturar».
// - No se solicitan ni conservan cabeceras HTTP, cookies o tokens de autenticación.

import { parseAdsTxt } from "./src/lib/adsTxt.js";
import { normalizeDomain } from "./src/lib/domain.js";
import { classifyVtOutcome } from "./src/lib/vtErrors.js";
import { SellersJsonStreamParser } from "./src/lib/sellersParser.js";
import { normalizeTrafficList, redactUrl } from "./src/lib/trafficNormalize.js";

const traffic = new Map();      // tabId -> registros crudos de chrome.webRequest
const frames = new Map();       // tabId -> Map(frameId -> {frameId, parentFrameId, url, data})
const captureSessions = new Set();

const AD_HOSTS = /(?:doubleclick\.net|googlesyndication\.com|googleadservices\.com|googletagservices\.com|google-analytics\.com|googletagmanager\.com|adservice\.google\.|facebook\.com\/tr|connect\.facebook\.net|analytics\.tiktok\.com|business-api\.tiktok\.com|bat\.bing\.com|static\.hotjar\.com|mc\.yandex\.|amazon-adsystem\.com|criteo\.(?:com|net)|rubiconproject\.com|openx\.net|indexww\.com|pubmatic\.com|adnxs\.com|casalemedia\.com|smartadserver\.com|adform\.net|taboola\.com|outbrain\.com|yieldmo\.com|triplelift\.com|lijit\.com|sharethrough\.com)/i;

chrome.webRequest.onBeforeRequest.addListener((d) => {
  if (d.tabId < 0 || !captureSessions.has(d.tabId) || (!AD_HOSTS.test(d.url) && !/(?:ca-)?(?:host-)?pub-\d{10,20}/i.test(d.url))) return;
  const list = traffic.get(d.tabId) || [];
  const safeUrl = redactUrl(d.url);
  if (!list.some(x => x.url === safeUrl)) {
    list.push({ url: safeUrl, method: d.method, type: d.type, statusCode: null, initiator: d.initiator || null, requestId: d.requestId, timeStamp: d.timeStamp || Date.now() });
  }
  traffic.set(d.tabId, list.slice(-250));
}, { urls: ["<all_urls>"] });

// Código de estado HTTP de la respuesta, cuando la petición llega a completarse.
chrome.webRequest.onCompleted.addListener((d) => {
  if (d.tabId < 0 || !captureSessions.has(d.tabId)) return;
  const list = traffic.get(d.tabId);
  const rec = list && list.find(x => x.requestId === d.requestId);
  if (rec) rec.statusCode = d.statusCode;
}, { urls: ["<all_urls>"] });

chrome.tabs.onRemoved.addListener(id => { traffic.delete(id); frames.delete(id); captureSessions.delete(id); });
chrome.tabs.onUpdated.addListener((id, info) => {
  if (info.status === "loading" && captureSessions.has(id)) { traffic.set(id, []); frames.set(id, new Map()); }
  if (info.status === "complete" && captureSessions.has(id)) chrome.action.setBadgeText({ tabId: id, text: "LISTO" });
});

async function safeFetch(url, timeout = 12000, maxBytes = 2500000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store", credentials: "omit", redirect: "follow" });
    const contentType = res.headers.get("content-type") || "";
    const reader = res.body?.getReader();
    if (!reader) return { ok: false, status: res.status, url: res.url, text: "", contentType, error: "Respuesta sin cuerpo legible" };
    const chunks = [];
    let size = 0, truncated = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - size;
      if (remaining <= 0) { truncated = true; break; }
      const chunk = value.length > remaining ? value.slice(0, remaining) : value;
      chunks.push(chunk); size += chunk.length;
      if (value.length > remaining || size >= maxBytes) { truncated = true; break; }
    }
    if (truncated) try { await reader.cancel(); } catch { /* ya cerrado */ }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    return { ok: res.ok, status: res.status, url: res.url, text, contentType, truncated, bytesRead: size };
  } catch (e) {
    return { ok: false, status: 0, url, text: "", error: e.name === "AbortError" ? "Tiempo de espera agotado" : e.message };
  } finally { clearTimeout(timer); }
}

async function fetchDeclarationFile(domain, filename) {
  const origin = `https://${normalizeDomain(domain)}`;
  const r = await safeFetch(`${origin}/${filename}`);
  const parsed = r.ok ? parseAdsTxt(r.text) : { rows: [], meta: {}, warnings: [] };
  if (r.ok && !parsed.rows.length && !Object.keys(parsed.meta || {}).length && /text\/html/i.test(r.contentType || "")) {
    return { ...r, ok: false, error: "El servidor devolvió HTML en lugar de un archivo de declaración", parsed };
  }
  return { ...r, parsed };
}

/**
 * Consulta el sellers.json público de Google usando el parser incremental REAL: nunca se
 * concatena ni se hace JSON.parse() del documento completo. Solo se retienen en memoria los
 * identificadores solicitados (filtrado por la propia app sobre lo que el parser va emitiendo).
 */
async function lookupGoogleSellers(ids, { signal } = {}) {
  if (!ids.length) return { matches: [], note: "Sin identificadores para consultar" };
  const targets = new Set(ids.map(x => x.replace(/^(?:ca-)?(?:host-)?/i, "")));
  const urls = ["https://storage.googleapis.com/adx-rtb-dictionaries/sellers.json", "https://google.com/sellers.json"];

  let response = null;
  for (const url of urls) {
    try {
      const r = await fetch(url, { cache: "force-cache", credentials: "omit", signal });
      if (r.ok && r.body) { response = r; break; }
    } catch { /* probamos el siguiente espejo */ }
  }
  if (!response) return { matches: [], note: "No se pudo consultar el registro público de Google" };

  const matches = new Map();
  const result = await new Promise((resolve) => {
    const parser = new SellersJsonStreamParser({
      signal,
      onSeller: (seller) => {
        const sid = String(seller.seller_id ?? seller.sellerId ?? "").replace(/^(?:ca-)?/i, "");
        if (!sid || !targets.has(sid)) return;
        matches.set(sid, {
          sellerId: seller.seller_id ?? seller.sellerId ?? sid,
          name: seller.is_confidential ? "" : (seller.name || "No publicado"),
          domain: seller.is_confidential ? "" : (seller.domain || "No publicado"),
          sellerType: seller.seller_type || seller.sellerType || "No indicado",
          confidential: seller.is_confidential === 1 || seller.is_confidential === true
        });
      }
    });
    (async () => {
      const reader = response.body.getReader();
      try {
        while (true) {
          if (matches.size >= targets.size) break;
          const { done, value } = await reader.read();
          if (done) break;
          parser.pushBytes(value);
        }
      } catch { /* se resuelve con lo acumulado hasta el fallo */ }
      finally {
        try { await reader.cancel(); } catch { /* ya cerrado */ }
        try { reader.releaseLock(); } catch { /* nada que liberar */ }
      }
      resolve(parser.end());
    })();
  });

  return {
    matches: [...matches.values()],
    bytes: result.bytesProcessed,
    note: !result.ok
      ? "El registro público de Google no pudo interpretarse con garantías."
      : (matches.size < targets.size ? "Sin coincidencias públicas para algún identificador" : ""),
    warnings: result.warnings
  };
}

async function vtRequest(path, apiKey, { signal } = {}) {
  try {
    const res = await fetch(`https://www.virustotal.com/api/v3${path}`, {
      headers: { "x-apikey": apiKey, accept: "application/json" },
      credentials: "omit", signal
    });
    let body = null, bodyParseFailed = false;
    try { body = await res.json(); } catch { bodyParseFailed = true; }
    const outcome = classifyVtOutcome({ status: res.status, body, bodyParseFailed, headers: res.headers });
    return { ...outcome, body };
  } catch (e) {
    const transportError = e.name === "AbortError" ? "abort" : "network";
    const outcome = classifyVtOutcome({ transportError, causeName: e.name });
    return { ...outcome, body: null };
  }
}

async function enrichVirusTotal(domain, apiKey) {
  let host;
  try { host = normalizeDomain(domain); } catch { return { ok: false, error: "Dominio no válido" }; }
  if (!apiKey || apiKey.length < 40) return { ok: false, error: "Clave de API no válida o incompleta" };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const encoded = encodeURIComponent(host);
    const base = await vtRequest(`/domains/${encoded}`, apiKey, { signal: ctrl.signal });
    if (base.category !== "success") return { ok: false, ...base, body: undefined };

    const names = ["resolutions", "subdomains", "urls", "communicating_files", "downloaded_files"];
    const settled = await Promise.all(names.map(async name => [name, await vtRequest(`/domains/${encoded}/${name}?limit=20`, apiKey, { signal: ctrl.signal })]));
    const relations = {};
    for (const [name, r] of settled) relations[name] = r.category === "success" ? (r.body?.data || []) : [];

    const a = base.body?.data?.attributes || {};
    return {
      ok: true, domain: host, queriedAt: new Date().toISOString(), outcome: { code: base.code, category: base.category },
      attributes: {
        reputation: a.reputation ?? null, lastAnalysisStats: a.last_analysis_stats || {}, categories: a.categories || {}, tags: a.tags || [],
        registrar: a.registrar || "", creationDate: a.creation_date || null, lastModificationDate: a.last_modification_date || null,
        lastAnalysisDate: a.last_analysis_date || null, whoisDate: a.whois_date || null, whois: (a.whois || "").slice(0, 12000),
        jarm: a.jarm || "", popularityRanks: a.popularity_ranks || {}
      },
      relations
    };
  } finally { clearTimeout(timer); }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === "IS_CAPTURE_ACTIVE") return sendResponse({ active: sender.tab?.id >= 0 && captureSessions.has(sender.tab.id) });
    if (msg.type === "CAPTURE_STATUS") return sendResponse({ active: Number.isInteger(msg.tabId) && captureSessions.has(msg.tabId) });
    if (msg.type === "GET_TRAFFIC") {
      const items = normalizeTrafficList(traffic.get(msg.tabId) || []);
      return sendResponse({ items });
    }
    if (msg.type === "FRAME_SCAN" && sender.tab?.id >= 0) {
      const tabId = sender.tab.id, tabFrames = frames.get(tabId) || new Map();
      if (!captureSessions.has(tabId)) return sendResponse({ ok: false, ignored: true });
      tabFrames.set(sender.frameId ?? 0, { frameId: sender.frameId ?? 0, parentFrameId: sender.parentFrameId ?? -1, url: sender.url || msg.data?.url || "", data: msg.data });
      frames.set(tabId, tabFrames);
      if (captureSessions.has(tabId)) chrome.action.setBadgeText({ tabId, text: "LISTO" });
      return sendResponse({ ok: true });
    }
    if (msg.type === "GET_FRAMES") return sendResponse({ items: [...(frames.get(msg.tabId)?.values() || [])] });
    if (msg.type === "RELOAD_CAPTURE") {
      traffic.set(msg.tabId, []); frames.set(msg.tabId, new Map()); captureSessions.add(msg.tabId);
      await chrome.action.setBadgeBackgroundColor({ tabId: msg.tabId, color: "#16835d" });
      await chrome.action.setBadgeText({ tabId: msg.tabId, text: "REC" });
      await chrome.tabs.reload(msg.tabId, { bypassCache: true });
      return sendResponse({ ok: true });
    }
    if (msg.type === "CAPTURE_READ") {
      captureSessions.delete(msg.tabId); traffic.delete(msg.tabId); frames.delete(msg.tabId);
      await chrome.action.setBadgeText({ tabId: msg.tabId, text: "" });
      return sendResponse({ ok: true });
    }
    if (msg.type === "STOP_CAPTURE") {
      captureSessions.delete(msg.tabId); traffic.delete(msg.tabId); frames.delete(msg.tabId);
      await chrome.action.setBadgeText({ tabId: msg.tabId, text: "" });
      return sendResponse({ ok: true });
    }
    if (msg.type === "FETCH_ADSTXT") return sendResponse(await fetchDeclarationFile(msg.domain, "ads.txt"));
    if (msg.type === "FETCH_APPADSTXT") return sendResponse(await fetchDeclarationFile(msg.domain, "app-ads.txt"));
    if (msg.type === "LOOKUP_SELLERS") return sendResponse(await lookupGoogleSellers(msg.ids || []));
    if (msg.type === "VT_ENRICH") return sendResponse(await enrichVirusTotal(msg.domain, msg.apiKey));
    sendResponse({ error: "Solicitud desconocida" });
  })().catch(e => sendResponse({ error: e.message, technicalError: String(e?.stack || e.message).slice(0, 500) }));
  return true;
});
