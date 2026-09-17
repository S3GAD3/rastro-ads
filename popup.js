// popup.js — RASTRO-ADS (módulo ES)
import { WorkModeController, wrapChromeStorageArea, MODE_EPHEMERAL, MODE_SESSION } from "./src/lib/modes.js";
import { hashEvidenceFiles, buildEvidenceManifest, finalizeManifest, generateEvidenceId, verifyEvidenceFiles } from "./src/lib/evidenceManifest.js";
import { createZip, readZipEntries } from "./src/lib/zipWriter.js";
import { timestampedFileName } from "./src/lib/sanitizePath.js";
import { sha256Hex, utf8Bytes } from "./src/lib/sha256.js";
import { extractOsintSignals, hasAnyOsintSignal } from "./src/lib/osintExtract.js";
import { buildProviderFindings, PROVIDER_GUIDANCE } from "./src/lib/providerFindings.js";

const EXT_VERSION = chrome.runtime.getManifest().version;

let report = null, vtApiKey = "", rowsShown = 80, appAdsResult = null, techWarnings = [];
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const send = msg => new Promise(resolve => chrome.runtime.sendMessage(msg, resolve));
const tabMsg = (id, msg) => new Promise((resolve, reject) => chrome.tabs.sendMessage(id, msg, { frameId: 0 }, r => chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(r)));
const norm = x => String(x || "").replace(/^(?:ca-)?(?:host-)?/i, "");
const uniq = a => [...new Set(a.filter(Boolean).map(norm))];
function state(t, c = "") { $("state").textContent = t; $("state").className = `notice ${c}`; }

// Se ejecuta de forma puntual en el mundo principal para leer APIs públicas creadas por la
// propia página. No modifica variables, no evalúa texto y devuelve únicamente datos acotados.
function probePublicAdRuntime() {
  const result = { gptSlots: [], technologies: [] };
  try {
    const slots = globalThis.googletag?.pubads?.().getSlots?.() || [];
    result.gptSlots = slots.slice(0, 100).map(slot => ({
      path: String(slot.getAdUnitPath?.() || "").slice(0, 500),
      sizes: (slot.getSizes?.() || []).slice(0, 30).map(x => String(x).slice(0, 80))
    }));
    if (result.gptSlots.length) result.technologies.push("Google Ad Manager / GPT");
  } catch { /* API ausente o no accesible */ }
  try {
    if (globalThis.pbjs && (Array.isArray(globalThis.pbjs.adUnits) || typeof globalThis.pbjs.getAdserverTargeting === "function")) result.technologies.push("Prebid.js");
  } catch { /* variable protegida */ }
  return result;
}

async function readPublicAdRuntime(tabId) {
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: probePublicAdRuntime });
    return results?.[0]?.result || { gptSlots: [], technologies: [] };
  } catch { return { gptSlots: [], technologies: [] }; }
}

function compactReportForSession(source) {
  if (!source) return source;
  const page = { ...(source.page || {}) };
  delete page.html;
  page.elements = (page.elements || []).slice(0, 100);
  page.scripts = (page.scripts || []).slice(0, 100);
  page.resources = (page.resources || []).slice(0, 150);
  page.gptSlots = (page.gptSlots || []).slice(0, 100);
  return { ...source, page, traffic: (source.traffic || []).slice(-250) };
}

document.querySelectorAll(".tab").forEach(b => b.onclick = () => {
  document.querySelectorAll(".tab,.view").forEach(x => x.classList.remove("active"));
  b.classList.add("active"); $(b.dataset.view).classList.add("active");
});

// ---------------------------------------------------------------------------
// Modo de trabajo (efímero / sesión) — Fase 5
// ---------------------------------------------------------------------------
const sessionArea = wrapChromeStorageArea(chrome.storage.session);
const modeController = new WorkModeController({ mode: MODE_EPHEMERAL, sessionStorage: sessionArea });

async function initMode() {
  let pref = MODE_EPHEMERAL;
  try {
    const r = await chrome.storage.session.get("workModePreference");
    if (r.workModePreference === MODE_SESSION) pref = MODE_SESSION;
  } catch { /* si storage.session no está disponible, se mantiene efímero */ }
  modeController.mode = pref;
  $("workMode").value = pref;
  await restoreFromMode();
}

$("workMode").onchange = async () => {
  const newMode = $("workMode").value === "session" ? MODE_SESSION : MODE_EPHEMERAL;
  await modeController.setMode(newMode);
  try { await chrome.storage.session.set({ workModePreference: newMode }); } catch { /* no crítico */ }
  report = null; vtApiKey = ""; appAdsResult = null; techWarnings = [];
  resetUiAfterClear();
  state(newMode === MODE_SESSION
    ? "Modo SESIÓN: los datos pueden restaurarse mientras el navegador siga abierto."
    : "Modo EFÍMERO: nada se conserva al cerrar el popup. Recomendado para investigaciones sensibles.");
};

$("newInvestigation").onclick = async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) await send({ type: "STOP_CAPTURE", tabId: tab.id });
  } catch { /* el borrado local continúa aunque la pestaña ya no exista */ }
  await modeController.clearCurrent();
  report = null; vtApiKey = ""; appAdsResult = null; techWarnings = [];
  resetUiAfterClear();
  state("Datos borrados. Lista para una nueva investigación.");
};

function resetUiAfterClear() {
  $("target").textContent = "—";
  $("assessment").innerHTML = ""; $("assessment").className = "empty"; $("assessment").textContent = "Análisis pendiente.";
  $("exportTxt").disabled = $("exportHtml").disabled = true;
  $("vtKey").value = ""; $("clearKey").disabled = true; $("queryVt").disabled = true;
  setVtStatus("Modo opcional desactivado.", "neutral");
  $("evidenceStatus").textContent = "Sin generar."; $("evidenceStatus").className = "status neutral";
  $("osintNotice").textContent = "No analizado."; $("osintNotice").className = "empty";
  for (const id of ["providerFindings", "providerRequests", "monetizationLeads"]) { $(id).innerHTML = ""; $(id).className = "empty"; $(id).textContent = "No analizado."; }
  for (const id of ["osintAnalytics", "osintWallets", "osintContactsHigh", "osintContactsPattern"]) { $(id).innerHTML = ""; $(id).className = "empty"; $(id).textContent = "No analizado."; }
}

async function restoreFromMode() {
  try {
    const key = await modeController.get("vtApiKey");
    if (key) { vtApiKey = key; $("clearKey").disabled = false; setVtStatus("Clave activa.", "ok"); }
  } catch { /* nada guardado */ }
  try {
    const saved = await modeController.get("lastReport");
    if (saved) { report = saved; render(); state("Mostrando el último análisis de esta sesión. Pulse Analizar para actualizar."); }
  } catch { /* nada guardado */ }
  $("queryVt").disabled = !(vtApiKey && report);
}

// ---------------------------------------------------------------------------
// Clasificación y fusión de marcos (lógica heredada de 0.4.1, sin cambios de comportamiento)
// ---------------------------------------------------------------------------
function classifications() {
  const rows = report?.ads?.parsed?.rows || [], google = rows.filter(r => /(^|\.)google\.com$/i.test(r.system));
  const page = uniq(report?.page?.publisherIds || []), traffic = uniq((report?.traffic || []).flatMap(x => [...x.url.matchAll(/(?:ca-)?(?:host-)?pub-\d{10,20}/gi)].map(m => m[0])));
  return { rows, google, page, traffic, observed: uniq([...page, ...traffic]), direct: uniq(google.filter(r => r.relationship === "DIRECT").map(r => r.sellerId)), reseller: uniq(google.filter(r => r.relationship === "RESELLER").map(r => r.sellerId)) };
}
function monetizationLeads() {
  const c = classifications();
  const primary = c.observed.filter(id => c.direct.includes(id));
  const observedOnly = c.observed.filter(id => !c.direct.includes(id));
  const declaredOnly = c.direct.filter(id => !c.observed.includes(id));
  const declaredResolved = declaredOnly.filter(id => sellerFor(id));
  const declaredUnresolved = declaredOnly.filter(id => !sellerFor(id));
  const conflicts = (report?.providerFindings || []).filter(f => f.provider === "Google" && f.type === "publisher" && f.relationshipConflict).map(f => f.value);
  return { primary, observedOnly, declaredResolved, declaredUnresolved, conflicts };
}
function sourceKinds(finding) {
  const labels = { dom: "DOM", resource: "recursos", network: "tráfico", "ads.txt": "ads.txt" };
  return [...new Set((finding.sources || []).map(s => labels[s.kind] || s.kind))];
}
function mergeFrames(top, items) {
  const list = (items || []).map(x => x?.data ? x : { frameId: null, url: x?.url || "", data: x }).filter(x => x?.data && x.frameId !== 0 && x.data.url !== top.url);
  const excluded = /recaptcha|\/consent|consent\.|cmp\.|privacy|accounts\.google|\/signin|\/login/i, adframe = /doubleclick|googlesyndication|googleadservices|adservice\.|amazon-adsystem|criteo|rubiconproject|openx|pubmatic|adnxs|smartadserver|adform|taboola|outbrain|yieldmo|triplelift|sharethrough/i;
  const findings = list.map(x => { const url = x.url || x.data.url || "", category = excluded.test(url) ? "DESCARTADO_TECNICO" : adframe.test(url) ? "IFRAME_PUBLICITARIO" : "TERCERO_NO_ATRIBUIBLE"; return { frameId: x.frameId, url, category, publisherIds: uniq(x.data.publisherIds || []) }; });
  const accepted = findings.filter(x => x.category === "IFRAME_PUBLICITARIO").flatMap(x => x.publisherIds);
  const data = list.map(x => x.data);
  return { ...top, publisherIds: uniq([...(top.publisherIds || []), ...accepted]), elements: [...(top.elements || []), ...data.flatMap(x => x.elements || [])].slice(0, 250), scripts: [...new Set([...(top.scripts || []), ...data.flatMap(x => x.scripts || [])])].slice(0, 250), resources: [...new Set([...(top.resources || []), ...data.flatMap(x => x.resources || [])])].slice(0, 350), technologies: [...new Set([...(top.technologies || []), ...data.flatMap(x => x.technologies || [])])], gptSlots: [...(top.gptSlots || []), ...data.flatMap(x => x.gptSlots || [])].slice(0, 150), frameFindings: findings, frameCount: 1 + list.length };
}
function sellerFor(id) { return (report?.sellers?.matches || []).find(s => norm(s.sellerId) === norm(id)); }
function sellerLine(id, source) { const s = sellerFor(id), observed = classifications().observed.includes(norm(id)); return `<div class="seller ${s?.confidential ? "conf" : ""}"><b><code>${esc(norm(id))}</code>${observed ? '<span class="badge observed">OBSERVADO</span>' : ""}</b><span>${s ? `${esc(s.confidential ? "Titular confidencial" : s.name)} · ${esc(s.domain)} · ${esc(s.sellerType)}` : "Titular no resuelto públicamente"}${source ? ` · ${esc(source)}` : ""}</span></div>`; }
/**
 * Calcula el nivel de confianza como datos estructurados (no HTML), para que tanto el popup
 * como los informes TXT/HTML puedan presentarlo sin depender de "adivinar" separaciones a
 * partir de texto ya renderizado (eso causaba que ALTA/MEDIA-ALTA, cuyos párrafos empiezan por
 * un número, quedaran pegados a la etiqueta al exportar: "CONFIANZA MEDIA-ALTA1 cuenta(s)...").
 */
function assessConfidence() {
  const c = classifications(), host = new URL(report.page.url).hostname.replace(/^www\./, ""), strong = c.observed.filter(id => c.direct.includes(id) && sellerFor(id));
  const domainMatch = strong.filter(id => (sellerFor(id)?.domain || "").replace(/^www\./, "").includes(host));
  if (domainMatch.length) return {
    className: "high", label: "CONFIANZA ALTA",
    paragraphs: [`Identificadores observados, declarados como DIRECT y con titular público relacionado con el dominio: ${domainMatch.map(norm).join(", ")}.`],
    caution: "Acredita una relación técnica sólida; no acredita por sí sola el beneficiario bancario ni el importe recibido."
  };
  if (strong.length) return {
    className: "mediumhigh", label: "CONFIANZA MEDIA-ALTA",
    paragraphs: [`Identificadores observados que coinciden con declaraciones DIRECT y tienen titular público: ${strong.map(norm).join(", ")}. El dominio declarado no coincide claramente con el objetivo; compruebe si es gestor o sociedad relacionada.`]
  };
  if (c.observed.length) return {
    className: "medium", label: "CONFIANZA MEDIA",
    paragraphs: [`Identificadores Google observados: ${c.observed.join(", ")}. Falta una coincidencia completa entre observación, declaración DIRECT y titular público relacionado.`]
  };
  if (c.direct.length) return {
    className: "limited", label: "ATRIBUCIÓN LIMITADA",
    paragraphs: [`El dominio declara ${c.direct.length} identificador(es) Google como DIRECT, pero ninguno fue observado en esta carga. Use «Recargar y capturar» y compruebe consentimiento, bloqueadores y carga efectiva de anuncios.`]
  };
  return { className: "none", label: "SIN ATRIBUCIÓN", paragraphs: ["No se localizaron identificadores suficientes."] };
}
function conclusion() {
  const a = assessConfidence();
  const codifyIds = s => esc(s).replace(/pub-\d{6,}/g, m => `<code>${m}</code>`);
  const body = a.paragraphs.map(p => `<p>${codifyIds(p)}</p>`).join("");
  const caution = a.caution ? `<p class="caution">${esc(a.caution)}</p>` : "";
  return `<div class="confidence ${a.className}">${esc(a.label)}</div>${body}${caution}`;
}

// ---------------------------------------------------------------------------
// Análisis principal
// ---------------------------------------------------------------------------
async function analyze() {
  let analyzedTabId = null;
  $("analyze").disabled = true; state("Analizando código, tráfico y declaraciones públicas…", "busy");
  techWarnings = [];
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:/.test(tab.url || "")) throw new Error("Abra una página HTTP o HTTPS.");
    analyzedTabId = tab.id;
    let page;
    try { page = await tabMsg(tab.id, { type: "SCAN_PAGE" }); }
    catch { throw new Error('Use «Recargar y capturar», espere a LISTO y vuelva a abrir la extensión.'); }
    const [net, frameData, runtimeProbe, captureStatus] = await Promise.all([send({ type: "GET_TRAFFIC", tabId: tab.id }), send({ type: "GET_FRAMES", tabId: tab.id }), readPublicAdRuntime(tab.id), send({ type: "CAPTURE_STATUS", tabId: tab.id })]);
    page = mergeFrames(page, frameData?.items || []);
    page.gptSlots = [...(page.gptSlots || []), ...(runtimeProbe.gptSlots || [])].slice(0, 150);
    page.technologies = [...new Set([...(page.technologies || []), ...(runtimeProbe.technologies || [])])];
    const u = new URL(tab.url);
    const ads = await send({ type: "FETCH_ADSTXT", domain: u.hostname });
    if (!ads.ok) techWarnings.push(`No se pudo obtener ads.txt: ${ads.error || `HTTP ${ads.status}`}`);
    const traffic = net?.items || [];
    report = { page, traffic, ads, sellers: { matches: [] }, osint: extractOsintSignals(page.html || ""), providerFindings: buildProviderFindings({ page, traffic, adsRows: ads?.parsed?.rows || [] }), acquisitionMode: captureStatus?.active ? "reload_capture" : "immediate", analyzedAt: new Date().toISOString(), version: EXT_VERSION, virusTotal: null, tabId: tab.id };
    if (!captureStatus?.active) techWarnings.push("Análisis inmediato: no se inició una captura con recarga; el tráfico previo no estaba disponible.");
    else if (!traffic.length) techWarnings.push("Captura con recarga activa, pero no se registraron peticiones publicitarias. Compruebe consentimiento, bloqueadores y carga efectiva de anuncios.");
    if (ads?.truncated) techWarnings.push("ads.txt superó el límite de 2,5 MB y fue truncado de forma segura.");
    if (ads?.parsed?.warnings?.length) techWarnings.push(...ads.parsed.warnings.slice(0, 100).map(w => `ads.txt: ${w}`));
    appAdsResult = null; $("appAdsResult").className = "empty"; $("appAdsResult").textContent = "No consultado.";
    render();
    const c = classifications(), lookup = uniq([...c.observed, ...c.direct]);
    if (lookup.length) {
      state("Resultados disponibles. Resolviendo titulares prioritarios…", "busy");
      const sellers = await send({ type: "LOOKUP_SELLERS", ids: lookup });
      report.sellers = sellers || { matches: [] };
      if (sellers?.warnings?.length) techWarnings.push(...sellers.warnings.map(w => `sellers.json: ${w}`));
      if (sellers?.note) techWarnings.push(sellers.note);
      render();
    }
    try { await modeController.set("lastReport", compactReportForSession(report)); }
    catch (e) { techWarnings.push(`No se pudo conservar el informe en modo sesión: ${e.message}`); }
    state(`Análisis finalizado: ${page.frameCount || 1} marco(s) y ${report.traffic.length} petición(es) publicitarias examinadas.`);
  } catch (e) { state(e.message, "error"); }
  finally {
    if (analyzedTabId) try { await send({ type: "CAPTURE_READ", tabId: analyzedTabId }); } catch { /* no crítico */ }
    $("analyze").disabled = false;
  }
}
async function prepareCapture() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:/.test(tab.url || "")) throw new Error("Abra una página HTTP o HTTPS.");
    state("La página se recargará y el popup se cerrará: es normal. Espere a LISTO, vuelva a abrir RASTRO-ADS y pulse Analizar.", "busy");
    setTimeout(async () => {
      await send({ type: "RELOAD_CAPTURE", tabId: tab.id });
      window.close();
    }, 600);
  } catch (e) { state(e.message, "error"); }
}
async function fetchAppAds() {
  if (!report) { $("appAdsResult").textContent = "Analice primero una página."; return; }
  $("fetchAppAds").disabled = true;
  try {
    const host = new URL(report.page.url).hostname;
    const r = await send({ type: "FETCH_APPADSTXT", domain: host });
    appAdsResult = r;
    if (!r.ok) { $("appAdsResult").className = "empty"; $("appAdsResult").textContent = `No disponible (${r.error || "HTTP " + r.status}).`; }
    else {
      if (r.truncated) techWarnings.push("app-ads.txt superó el límite de 2,5 MB y fue truncado.");
      if (r.parsed?.warnings?.length) techWarnings.push(...r.parsed.warnings.slice(0, 100).map(w => `app-ads.txt: ${w}`));
      const rows = r.parsed?.rows || [];
      $("appAdsResult").className = ""; $("appAdsResult").innerHTML = rows.length
        ? `<div class="row"><b>${rows.length} relación(es) declaradas</b></div>` + rows.slice(0, 30).map(row => `<div class="row"><code>${esc(row.system)}, ${esc(row.sellerId)}, ${esc(row.relationship)}</code></div>`).join("")
        : '<span class="empty">app-ads.txt disponible pero sin relaciones interpretables.</span>';
    }
  } finally { $("fetchAppAds").disabled = false; }
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
function render() {
  if (!report) return;
  const p = report.page, c = classifications();
  $("target").textContent = p.url;
  $("mObserved").textContent = c.observed.length; $("mDirect").textContent = c.direct.length; $("mReseller").textContent = c.reseller.length;
  $("mRows").textContent = c.rows.length; $("mAllDirect").textContent = c.rows.filter(r => r.relationship === "DIRECT").length; $("mAllReseller").textContent = c.rows.filter(r => r.relationship === "RESELLER").length;
  $("assessment").innerHTML = conclusion();
  const leads = monetizationLeads();
  const leadRows = [];
  for (const id of leads.primary) leadRows.push(`<div class="row"><b><span class="badge direct">PRIORIDAD 1</span> OBSERVADO + DIRECT</b><code>${esc(id)}</code><span>${esc(sellerFor(id)?.name || "Titular no publicado")} · ID idónea para pedir cuenta, beneficiario y pagos a Google.</span></div>`);
  for (const id of leads.observedOnly) leadRows.push(`<div class="row"><b><span class="badge observed">PRIORIDAD 2</span> OBSERVADO, NO DIRECT</b><code>${esc(id)}</code><span>Incluir con su evidencia de origen y pedir a Google que determine la cuenta y su relación con el dominio.</span></div>`);
  for (const id of leads.declaredResolved) leadRows.push(`<div class="row"><b><span class="badge reseller">PRIORIDAD 3</span> DIRECT, NO OBSERVADO</b><code>${esc(id)}</code><span>${esc(sellerFor(id)?.name || "Titular no publicado")} · Declarado por el dominio; solicitar solo si resulta pertinente al periodo investigado.</span></div>`);
  $("monetizationLeads").className = leadRows.length ? "" : "empty";
  $("monetizationLeads").innerHTML = leadRows.length ? leadRows.join("") + (leads.declaredUnresolved.length ? `<p class="caution">Otros DIRECT no observados y sin titular público: ${leads.declaredUnresolved.length}. Se conservan en el informe/anexo.</p>` : "") + (leads.conflicts.length ? `<p class="caution">Inconsistencia: ${esc(leads.conflicts.join(", "))} aparece como DIRECT y RESELLER en ads.txt.</p>` : "") : "No se localizaron pub-ID prioritarias.";
  $("tech").className = "chips"; $("tech").innerHTML = p.technologies.length ? p.technologies.map(x => `<span class="chip">${esc(x)}</span>`).join("") : '<span class="empty">No detectadas.</span>';
  $("observedIds").innerHTML = c.observed.length ? c.observed.map(id => sellerLine(id, c.page.includes(id) ? (c.traffic.includes(id) ? "HTML y tráfico" : "HTML") : "Tráfico")).join("") : '<span class="empty">Ninguno. Recargue la página con la extensión activa.</span>';
  $("directIds").innerHTML = c.direct.length ? c.direct.map(id => sellerLine(id, "ads.txt DIRECT")).join("") : '<span class="empty">Ninguno.</span>';
  const relevant = uniq([...c.observed, ...c.direct]); $("sellers").innerHTML = relevant.length ? relevant.map(id => sellerLine(id, "sellers.json")).join("") : '<span class="empty">Sin identificadores prioritarios.</span>';
  const ev = [...p.elements.map(x => ({ n: "Elemento " + x.tag, d: [x.client, x.host, x.slot].filter(Boolean).join(" · ") })), ...p.gptSlots.map(x => ({ n: "Unidad GPT", d: x.path + " · " + x.sizes.join(", ") })), ...p.scripts.map(x => ({ n: "Script publicitario", d: x }))];
  $("evidenceList").innerHTML = ev.length ? ev.map(x => `<div class="row"><b>${esc(x.n)}</b><code>${esc(x.d)}</code></div>`).join("") : '<span class="empty">Sin evidencias directas.</span>';
  $("traffic").innerHTML = report.traffic.length ? report.traffic.map(x => `<div class="row"><b>${esc(x.type)}</b><code>${esc(x.url)}</code></div>`).join("") : '<span class="empty">Sin captura.</span>';
  const discarded = (p.frameFindings || []).filter(x => x.category !== "IFRAME_PUBLICITARIO");
  $("discardedFrames").innerHTML = discarded.length ? discarded.map(x => `<div class="row"><b>${x.category === "DESCARTADO_TECNICO" ? "Técnico excluido" : "Tercero no atribuible"}</b><code>${esc(x.url)}</code>${x.publisherIds.length ? `<span>${esc(x.publisherIds.join(", "))} — no atribuidos</span>` : ""}</div>`).join("") : '<span class="empty">Ninguno.</span>';
  const meta = Object.entries(report.ads?.parsed?.meta || {}); $("adsMeta").innerHTML = meta.length ? meta.map(([k, v]) => `<div class="row"><b>${esc(k)}</b> ${esc(v)}</div>`).join("") : '<span class="empty">No se declararon OWNERDOMAIN o MANAGERDOMAIN.</span>';
  $("googleDirectRows").innerHTML = c.direct.length ? c.direct.map(id => sellerLine(id, "Cuenta directa autorizada")).join("") : '<span class="empty">No hay cuentas Google DIRECT.</span>';
  renderAdsRows(); renderOfficial(); renderVt(); renderOsint();
  $("exportTxt").disabled = $("exportHtml").disabled = false; $("queryVt").disabled = !vtApiKey;
}
function renderOsint() {
  if (!report) return;
  const o = report.osint || extractOsintSignals("");
  const found = hasAnyOsintSignal(o);
  const findings = report.providerFindings || buildProviderFindings({ page: report.page, traffic: report.traffic, adsRows: report.ads?.parsed?.rows || [] });
  $("providerFindings").className = findings.length ? "" : "empty";
  $("providerFindings").innerHTML = findings.length ? findings.map(f => `<div class="row"><b>${esc(f.provider)} · ${esc(f.type)} <span class="badge ${f.confidence === "high" ? "direct" : "reseller"}">${f.confidence === "high" ? "ALTA" : "MEDIA"}</span></b><code>${esc(f.value)}</code><span>${esc(sourceKinds(f).join(" + "))}${f.relationshipConflict ? " · INCONSISTENCIA DIRECT/RESELLER" : ""}</span></div>`).join("") : "Sin identificadores de proveedor.";
  $("osintNotice").className = found ? "" : "empty";
  $("osintNotice").textContent = found
    ? "Se encontraron indicios adicionales. Úselos como pivote: busque el mismo ID/wallet/contacto en otras webs sospechosas."
    : "No se encontraron indicios adicionales en el documento principal de esta página.";

  const analyticsRows = [
    ["Google Analytics 4", o.analytics.ga4], ["Universal Analytics", o.analytics.universalAnalytics],
    ["Google Tag Manager", o.analytics.gtm], ["Meta/Facebook Pixel", o.analytics.metaPixel],
    ["TikTok Pixel", o.analytics.tiktokPixel], ["Bing UET", o.analytics.bingUet],
    ["Hotjar", o.analytics.hotjar], ["Yandex Metrica", o.analytics.yandexMetrica],
    ["Google Site Verification", o.analytics.googleSiteVerification]
  ].filter(([, list]) => list.length);
  $("osintAnalytics").innerHTML = analyticsRows.length
    ? analyticsRows.map(([name, list]) => `<div class="row"><b>${esc(name)}</b>${list.map(v => `<code>${esc(v)}</code>`).join("")}</div>`).join("")
    : '<span class="empty">No se detectaron IDs de analítica o seguimiento.</span>';

  const walletRows = [];
  if (o.wallets.bitcoin.length) walletRows.push(["Bitcoin", o.wallets.bitcoin]);
  if (o.wallets.ethereum.length) walletRows.push(["Ethereum", o.wallets.ethereum]);
  if (o.ibans.length) walletRows.push(["IBAN (validado)", o.ibans]);
  $("osintWallets").innerHTML = walletRows.length
    ? walletRows.map(([name, list]) => `<div class="row"><b>${esc(name)}</b>${list.map(v => `<code>${esc(v)}</code>`).join("")}</div>`).join("")
    : '<span class="empty">No se detectaron direcciones de criptomonedas ni IBAN.</span>';

  const hc = o.contacts.highConfidence;
  const hcRows = [["Email (mailto:)", hc.emails], ["Teléfono (tel:)", hc.phones], ["WhatsApp (wa.me)", hc.whatsapp], ["Telegram (t.me)", hc.telegram]].filter(([, l]) => l.length);
  $("osintContactsHigh").innerHTML = hcRows.length
    ? hcRows.map(([name, list]) => `<div class="row"><b>${esc(name)}</b>${list.map(v => `<code>${esc(v)}</code>`).join("")}</div>`).join("")
    : '<span class="empty">Sin enlaces de contacto explícitos (mailto/tel/wa.me/t.me).</span>';

  const pm = o.contacts.patternMatched;
  const pmRows = [["Email (patrón)", pm.emails], ["Teléfono (patrón)", pm.phones]].filter(([, l]) => l.length);
  $("osintContactsPattern").innerHTML = pmRows.length
    ? pmRows.map(([name, list]) => `<div class="row"><b>${esc(name)}</b>${list.map(v => `<code>${esc(v)}</code>`).join("")}</div>`).join("")
    : '<span class="empty">Sin coincidencias de patrón adicionales.</span>';
}
function renderAdsRows() {
  if (!report) return;
  let rows = classifications().rows, q = $("adsSearch").value.trim().toLowerCase(), f = $("adsFilter").value;
  if (f === "DIRECT" || f === "RESELLER") rows = rows.filter(r => r.relationship === f);
  if (f === "GOOGLE") rows = rows.filter(r => /(^|\.)google\.com$/i.test(r.system));
  if (q) rows = rows.filter(r => (r.system + " " + r.sellerId).toLowerCase().includes(q));
  const visible = rows.slice(0, rowsShown);
  $("adsRows").innerHTML = visible.length ? visible.map(r => `<div class="row"><b>${esc(r.system)} <span class="badge ${r.relationship.toLowerCase()}">${r.relationship}</span></b><code>${esc(r.sellerId)}${r.certId ? " · " + esc(r.certId) : ""}</code></div>`).join("") : '<span class="empty">Sin coincidencias.</span>';
  $("moreRows").hidden = visible.length >= rows.length; $("moreRows").textContent = `Mostrar más (${visible.length} de ${rows.length})`;
}
/**
 * Traduce los indicios OSINT (analítica, wallets, IBAN, contactos) a la lista de identificadores
 * que podrían acompañar solicitudes oficiales a OTROS proveedores distintos de Google (Meta,
 * TikTok, Microsoft, entidad bancaria, etc.). Cada entrada indica a quién dirigirse y qué prueba
 * (y qué no prueba) ese identificador concreto — mismo principio de cautela que con pub-ID.
 */
function officialOsintTargets() {
  const o = report?.osint;
  if (!o) return [];
  const targets = [];
  const findings = report?.providerFindings || [];
  const values = (provider, types) => [...new Set(findings.filter(f => f.provider === provider && types.includes(f.type)).map(f => f.value))];
  const ga = values("Google", ["analytics-ga4", "analytics-ua"]);
  const gtm = values("Google", ["tag-manager"]);
  const siteVerification = values("Google", ["site-verification"]);
  const metaPixels = values("Meta", ["pixel"]);
  const tiktokPixels = values("TikTok", ["pixel"]);
  const bingUet = values("Microsoft", ["uet"]);
  const hotjar = values("Hotjar", ["site-id"]);
  const yandex = values("Yandex", ["metrica"]);
  if (ga.length) targets.push({ label: "Google Analytics (GA4/UA)", provider: "Google", values: ga, note: "Referencia una propiedad o flujo de Analytics. Google puede determinar las cuentas, usuarios o roles relacionados si los datos existen y se conservan." });
  if (gtm.length) targets.push({ label: "Google Tag Manager", provider: "Google", values: gtm, note: "Referencia un contenedor de GTM; no demuestra por sí solo quién lo administra actualmente." });
  if (siteVerification.length) targets.push({ label: "Google Site Verification", provider: "Google", values: siteVerification, note: "Es un token técnico de verificación. Su presencia debe corroborarse y no identifica públicamente a la cuenta." });
  if (metaPixels.length) targets.push({ label: "Meta/Facebook Pixel", provider: "Meta Platforms (no Google)", values: metaPixels, note: "Referencia un píxel/dataset de Meta que puede compartirse entre organizaciones y cuentas publicitarias. Es un pivote de administración, no una ID del beneficiario de la monetización." });
  if (tiktokPixels.length) targets.push({ label: "TikTok Pixel", provider: "TikTok/ByteDance (no Google)", values: tiktokPixels, note: "Referencia un recurso de medición relacionado con un Business Center o varias cuentas; no identifica directamente al receptor de ingresos de la web." });
  if (bingUet.length) targets.push({ label: "Bing UET", provider: "Microsoft Advertising (no Google)", values: bingUet, note: "Referencia una etiqueta de medición de Microsoft Advertising y sirve como pivote de administración." });
  if (hotjar.length) targets.push({ label: "Hotjar", provider: "Hotjar/Contentsquare (no Google)", values: hotjar, note: "Referencia un recurso de analítica asociado al sitio; no identifica al beneficiario de monetización." });
  if (yandex.length) targets.push({ label: "Yandex Metrica", provider: "Yandex (no Google)", values: yandex, note: "Referencia una propiedad de medición; la cooperación queda sujeta al cauce y jurisdicción aplicables." });
  if (o.wallets.bitcoin.length || o.wallets.ethereum.length) targets.push({ label: "Direcciones de criptomonedas", provider: "Análisis de blockchain / exchange con KYC", values: [...o.wallets.bitcoin, ...o.wallets.ethereum], note: "No hay un proveedor único que identifique al titular: requiere análisis de la cadena de bloques y, si los fondos pasaron por un exchange con verificación de identidad, solicitud a ese exchange." });
  if (o.ibans.length) targets.push({ label: "IBAN", provider: "Entidad bancaria emisora", values: o.ibans, note: "El código de banco tras el país identifica la entidad; la solicitud de titularidad se dirige a ella." });
  const hc = o.contacts.highConfidence;
  if (hc.whatsapp.length) targets.push({ label: "WhatsApp (enlace explícito)", provider: "Meta Platforms (no Google)", values: hc.whatsapp, note: "WhatsApp pertenece a Meta; sigue el cauce de solicitud de Meta." });
  if (hc.telegram.length) targets.push({ label: "Telegram (enlace explícito)", provider: "Telegram FZ-LLC (no Google)", values: hc.telegram, note: "Telegram tiene un historial de cooperación muy limitada con autoridades; valore la utilidad real de la solicitud." });
  if (hc.emails.length) targets.push({ label: "Email de contacto (enlace explícito)", provider: "Según el dominio tras el @", values: hc.emails, note: "La solicitud se dirige al proveedor de correo de ese dominio (Google Workspace, Microsoft 365, hosting propio, etc.)." });
  if (hc.phones.length) targets.push({ label: "Teléfono (enlace explícito)", provider: "Operador de telecomunicaciones", values: hc.phones, note: "La titularidad de la línea se solicita al operador correspondiente al prefijo." });
  return targets;
}
function renderOfficial() {
  const c = classifications(), refs = [`Dominio: ${new URL(report.page.url).hostname}`, `URL exacta: ${report.page.url}`, `Fecha y hora UTC: ${report.analyzedAt}`, `ID observados: ${c.observed.join(", ") || "Ninguno"}`, `Google DIRECT: ${c.direct.join(", ") || "Ninguno"}`, `Google RESELLER: ${c.reseller.length} cuentas (no atribuir como titulares)`];
  $("officialRefs").innerHTML = refs.map(x => `<div class="refline">${esc(x)}</div>`).join("");
  const osintTargets = officialOsintTargets();
  $("officialOsint").className = osintTargets.length ? "" : "empty";
  $("officialOsint").innerHTML = osintTargets.length
    ? osintTargets.map(t => `<div class="row"><b>${esc(t.label)}</b><span class="badge">${esc(t.provider)}</span>${t.values.map(v => `<code>${esc(v)}</code>`).join("")}<span class="note">${esc(t.note)}</span></div>`).join("")
    : "No se localizaron indicios OSINT adicionales en esta página (o aún no se ha analizado).";
  const providers = [...new Set((report.providerFindings || []).map(f => f.provider))].filter(p => PROVIDER_GUIDANCE[p]);
  $("providerRequests").className = providers.length ? "" : "empty";
  $("providerRequests").innerHTML = providers.length ? providers.map(provider => {
    const guide = PROVIDER_GUIDANCE[provider];
    const ids = report.providerFindings.filter(f => f.provider === provider).map(f => `${f.type}: ${f.value}`);
    return `<div class="card"><h2>${esc(provider)}</h2><p class="caution">${esc(guide.caution)}</p><div class="row"><b>Referencias</b><code>${esc(ids.join(" · "))}</code></div><ul class="request-list">${guide.request.map(x => `<li>${esc(x)}</li>`).join("")}</ul></div>`;
  }).join("") : "No se detectaron proveedores con ficha específica.";
}

// ---------------------------------------------------------------------------
// VirusTotal — clasificación centralizada de errores (Fase 4)
// ---------------------------------------------------------------------------
function vtRelationId(x) { return x?.attributes?.url || x?.attributes?.host_name || x?.attributes?.ip_address || x?.id || "Elemento sin identificador"; }
function renderVt() {
  const v = report?.virusTotal;
  if (!v) { $("vtSummary").innerHTML = `<span class="empty">${vtApiKey ? "Clave activa. Pulse «Consultar dominio»." : "Puede utilizar RASTRO-ADS sin VirusTotal."}</span>`; $("vtRelations").innerHTML = '<span class="empty">Sin consulta.</span>'; return; }
  if (!v.ok) {
    const retryHint = v.retryable ? (v.retryAfter ? ` Reintente en unos ${v.retryAfter}s.` : " Puede reintentarlo más tarde.") : "";
    $("vtSummary").innerHTML = `<span class="danger">${esc(v.userMessage || v.error || "Consulta fallida")}${esc(retryHint)}</span><div class="row"><b>Código</b> <code>${esc(v.code || "N/D")}</code></div>`;
    $("vtRelations").innerHTML = '<span class="empty">Sin datos por el error anterior.</span>';
    return;
  }
  const a = v.attributes || {}, st = a.lastAnalysisStats || {}, cats = [...new Set(Object.values(a.categories || {}))];
  $("vtSummary").innerHTML = `<div class="vt-kpis"><div><b class="${(st.malicious || 0) > 0 ? "danger" : ""}">${st.malicious || 0}</b><span>Maliciosos</span></div><div><b>${st.suspicious || 0}</b><span>Sospechosos</span></div><div><b>${a.reputation ?? "—"}</b><span>Reputación</span></div></div><div class="row"><b>Registrador</b> ${esc(a.registrar || "No disponible")}</div><div class="row"><b>Categorías</b> ${esc(cats.join(", ") || "No disponibles")}</div>`;
  const labels = { resolutions: "Resoluciones", subdomains: "Subdominios", urls: "URLs", communicating_files: "Archivos comunicantes", downloaded_files: "Archivos descargados" };
  $("vtRelations").innerHTML = Object.entries(v.relations || {}).map(([k, list]) => `<div class="relation-title">${labels[k] || esc(k)} (${list.length})</div><div class="relation-items">${list.length ? list.map(x => `<code>${esc(vtRelationId(x))}</code>`).join("") : '<span class="empty">Sin resultados</span>'}</div>`).join("");
}
async function queryVt() {
  if (!report) { setVtStatus("Analice primero una página.", "bad"); return; }
  const domain = new URL(report.page.url).hostname;
  $("queryVt").disabled = true; setVtStatus(`Consultando ${domain}…`, "neutral");
  const r = await send({ type: "VT_ENRICH", domain, apiKey: vtApiKey });
  report.virusTotal = r;
  if (r?.ok) {
    setVtStatus("Consulta completada.", "ok");
    try { await modeController.set("lastReport", compactReportForSession(report)); }
    catch (e) { techWarnings.push(`No se pudo conservar la consulta en modo sesión: ${e.message}`); }
  }
  else setVtStatus(r?.userMessage || r?.error || "Consulta fallida.", "bad");
  $("queryVt").disabled = !vtApiKey; renderVt();
}
function setVtStatus(t, c) { $("vtStatus").textContent = t; $("vtStatus").className = `status ${c}`; }
async function activateKey() {
  const k = $("vtKey").value.trim();
  if (k.length < 40) return setVtStatus("La clave parece incompleta.", "bad");
  vtApiKey = k;
  await modeController.set("vtApiKey", k);
  $("vtKey").value = ""; $("clearKey").disabled = false; $("queryVt").disabled = !report;
  setVtStatus(modeController.mode === MODE_SESSION ? "Clave activa durante esta sesión del navegador." : "Clave activa solo en memoria mientras este popup permanezca abierto.", "ok");
}
async function clearKey() {
  vtApiKey = ""; await modeController.remove("vtApiKey");
  $("queryVt").disabled = $("clearKey").disabled = true; setVtStatus("Clave eliminada.", "neutral");
}

// ---------------------------------------------------------------------------
// Informes TXT/HTML orientados a identificar cuentas y posibles beneficiarios de monetización
// ---------------------------------------------------------------------------
function investigatorReport() {
  const c = classifications(), a = report.ads?.parsed || { rows: [], meta: {} }, v = report.virusTotal;
  const o = report.osint || extractOsintSignals("");
  const formatOsintList = (label, list) => list.length ? `  ${label}: ${list.join(", ")}\n` : "";
  const hasAnyAnalytics = Object.values(o.analytics).some(l => l.length);
  const hasAnyWallet = o.wallets.bitcoin.length || o.wallets.ethereum.length || o.ibans.length;
  const hasAnyHighConfidenceContact = Object.values(o.contacts.highConfidence).some(l => l.length);
  const hasAnyPatternContact = Object.values(o.contacts.patternMatched).some(l => l.length);
  const osintTargets = officialOsintTargets();
  const findings = report.providerFindings || [];
  const leads = monetizationLeads();
  const acquisitionLabel = report.acquisitionMode === "reload_capture" ? "Captura con recarga iniciada por el investigador" : "Análisis inmediato sin captura previa de tráfico";
  const trafficWarning = report.traffic.length ? "" : (report.acquisitionMode === "reload_capture" ? "ADVERTENCIA: no se registró tráfico publicitario pese a la recarga. Revise consentimiento, bloqueadores y carga efectiva de anuncios." : "ADVERTENCIA: no se inició «Recargar y capturar»; no puede descartarse tráfico publicitario anterior al análisis.");
  const trackingByType = type => findings.filter(f => f.type === type).map(f => f.value);
  const providerSections = [...new Set(findings.map(f => f.provider))].map(provider => {
    const items = findings.filter(f => f.provider === provider);
    const guide = PROVIDER_GUIDANCE[provider];
    return `${provider}\n${items.map(f => `- ${f.type}: ${f.value} | confianza técnica ${f.confidence === "high" ? "ALTA" : "MEDIA"} | fuentes independientes: ${sourceKinds(f).join(", ")}${f.relationshipConflict ? " | INCONSISTENCIA: figura como DIRECT y RESELLER" : ""}`).join("\n")}${provider !== "Google" || items.some(f => f.type !== "publisher") ? "\nNota: los identificadores de medición/analítica ayudan a identificar administradores o cuentas relacionadas, pero no son por sí solos IDs del receptor de ingresos." : ""}${guide ? `\nCautela: ${guide.caution}\nDatos que cabría valorar solicitar, si existen, se conservan y hay habilitación legal:\n${guide.request.map(x => `- ${x}`).join("\n")}` : ""}`;
  }).join("\n\n");
  const host = new URL(report.page.url).hostname;
  const directGoogle = c.rows.filter(r => /(^|\.)google\.com$/i.test(r.system) && r.relationship === "DIRECT");
  const directLines = directGoogle.map(r => `${r.system}, ${r.sellerId}, DIRECT${r.certId ? ", " + r.certId : ""}`);
  const idLines = uniq([...c.observed, ...c.direct]).map(id => {
    const origins = []; if (c.page.includes(id)) origins.push("HTML/marco publicitario aceptado"); if (c.traffic.includes(id)) origins.push("tráfico capturado"); if (c.direct.includes(id)) origins.push("ads.txt DIRECT");
    const seller = sellerFor(id), status = c.observed.includes(id) && c.direct.includes(id) ? "OBSERVADO + DIRECT" : c.observed.includes(id) ? "OBSERVADO (no DIRECT en ads.txt)" : "SOLO DECLARADO DIRECT (no observado en esta carga)";
    const finding = findings.find(f => f.provider === "Google" && f.type === "publisher" && norm(f.value) === norm(id));
    const details = [...new Set((finding?.sources || []).filter(s => s.kind !== "ads.txt").map(s => s.detail))].slice(0, 3);
    return `${id} | ${status} | Origen: ${origins.join("; ") || "no determinado"}${details.length ? ` | Contexto: ${details.join(" ; ")}` : ""} | sellers.json: ${seller?.name || "sin nombre publicado"}${seller?.domain ? " / " + seller.domain : ""}${finding?.relationshipConflict ? " | ADVERTENCIA: aparece como DIRECT y RESELLER" : ""}`;
  });
  const discarded = (report.page.frameFindings || []).filter(x => x.category !== "IFRAME_PUBLICITARIO");
  const conf = assessConfidence();
  const assessment = [conf.label, ...conf.paragraphs, ...(conf.caution ? [conf.caution] : [])].join("\n");
  return `RASTRO-ADS — INFORME INTERPRETADO PARA INVESTIGACIÓN
Versión: ${report.version}
Fecha y hora de captura (UTC): ${report.analyzedAt}
Dominio analizado: ${host}
URL exacta: ${report.page.url}
Título: ${report.page.title || "No disponible"}
Marcos examinados: ${report.page.frameCount || 1}
Peticiones publicitarias registradas: ${report.traffic.length}
Modo de adquisición: ${acquisitionLabel}
${trafficWarning}

1. CONCLUSIÓN
${assessment}

IDs CON MAYOR UTILIDAD PARA IDENTIFICAR AL BENEFICIARIO DE LA MONETIZACIÓN
Prioridad 1 — observadas y DIRECT: ${leads.primary.join(", ") || "Ninguna"}
Prioridad 2 — observadas pero no DIRECT: ${leads.observedOnly.join(", ") || "Ninguna"}
Prioridad 3 — DIRECT no observadas con titular público: ${leads.declaredResolved.map(id => `${id} (${sellerFor(id)?.name || "sin nombre"})`).join(", ") || "Ninguna"}
Otros DIRECT no observados y sin titular público: ${leads.declaredUnresolved.length}
${leads.conflicts.length ? `Inconsistencias DIRECT/RESELLER: ${leads.conflicts.join(", ")}` : ""}

Uso recomendado: las pub-ID anteriores son las referencias que Google puede emplear para localizar cuentas de AdSense/Ad Manager y, con habilitación legal, determinar titular, perfil de pagos, beneficiario, medio de abono e historial del periodo. Los RESELLER, Analytics, GTM y píxeles de Meta/TikTok son datos de apoyo y no identifican directamente al receptor del pago.

2. CÓMO INTERPRETAR LOS TÉRMINOS
pub-ID: identificador técnico de una cuenta de editor de Google. Permite a Google localizar una cuenta, pero por sí solo no identifica a una persona, una cuenta bancaria, un pagador o un beneficiario.
OBSERVADO: el identificador apareció en el HTML, en un marco publicitario aceptado o en el tráfico de esta carga concreta. Tiene más valor técnico que una mera autorización en ads.txt.
DIRECT: el ads.txt del dominio declara una relación directa con esa cuenta vendedora. No demuestra por sí solo que la cuenta sirviera un anuncio en esta visita ni quién recibió un pago concreto.
RESELLER: cuenta de un intermediario autorizado para vender el inventario. No equivale al propietario de la web, al editor investigado ni al beneficiario final del pago.
sellers.json: registro público mantenido por la plataforma publicitaria que puede asociar un seller-ID con un nombre, dominio y tipo de vendedor declarados. La ausencia de nombre puede obedecer a confidencialidad o falta de publicación.
OWNERDOMAIN: dominio empresarial que el propio ads.txt declara como propietario del inventario.
MANAGERDOMAIN: dominio de la entidad que declara gestionar las cuentas publicitarias del sitio.

3. IDENTIFICADORES PRIORITARIOS Y PROCEDENCIA
${idLines.join("\n") || "No se localizaron identificadores Google prioritarios."}

Lectura: priorice los marcados «OBSERVADO + DIRECT». Un ID «SOLO DECLARADO DIRECT» estaba autorizado públicamente, pero no se verificó su uso en esta carga. Un observado sin DIRECT requiere corroboración adicional.

4. CADENA ADS.TXT
URL consultada: ${report.ads?.url || `https://${host}/ads.txt`}
Relaciones totales: ${c.rows.length}
DIRECT totales: ${c.rows.filter(r => r.relationship === "DIRECT").length}
RESELLER totales: ${c.rows.filter(r => r.relationship === "RESELLER").length}
Google DIRECT: ${c.direct.length}
Google RESELLER: ${c.reseller.length}
OWNERDOMAIN: ${a.meta?.OWNERDOMAIN || "No declarado"}
MANAGERDOMAIN: ${a.meta?.MANAGERDOMAIN || "No declarado"}

Interpretación de RESELLER: estas ${c.reseller.length} cuenta(s) Google figuran como canales de reventa autorizados. Su presencia describe la cadena comercial posible, pero no permite atribuir la web ni el cobro a sus titulares.

5. MARCOS DESCARTADOS Y CONTROL DE FALSOS POSITIVOS
${discarded.map(x => `${x.category} | ${x.url}${x.publisherIds?.length ? ` | IDs vistos pero NO atribuidos: ${x.publisherIds.join(", ")}` : ""}`).join("\n") || "No se descartaron marcos técnicos o de terceros."}

Los marcos de captcha, autenticación, consentimiento y terceros no publicitarios se conservan para trazabilidad, pero sus IDs no se atribuyen al dominio investigado.

6. INDICIOS OSINT ADICIONALES (más allá de la monetización publicitaria)
Estos indicios se extraen del documento principal, recursos y tráfico disponible. Sirven como puntos de pivote hacia otras webs, incluso cuando no hay monetización publicitaria. La reutilización de un identificador es una correlación técnica compatible con administración o infraestructura común, pero también puede deberse a una agencia, plantilla, tercero o configuración antigua; siempre requiere corroboración.

IDs de analítica y seguimiento:
${formatOsintList("Google Analytics 4", trackingByType("analytics-ga4"))}${formatOsintList("Universal Analytics", trackingByType("analytics-ua"))}${formatOsintList("Google Tag Manager", trackingByType("tag-manager"))}${formatOsintList("Meta/Facebook Pixel", findings.filter(f => f.provider === "Meta" && f.type === "pixel").map(f => f.value))}${formatOsintList("TikTok Pixel", findings.filter(f => f.provider === "TikTok" && f.type === "pixel").map(f => f.value))}${formatOsintList("Bing UET", trackingByType("uet"))}${formatOsintList("Hotjar", trackingByType("site-id"))}${formatOsintList("Yandex Metrica", trackingByType("metrica"))}${formatOsintList("Google Site Verification", trackingByType("site-verification"))}${!findings.some(f => f.type !== "publisher") ? "  Ninguno detectado.\n" : ""}
Direcciones de criptomonedas e IBAN:
${formatOsintList("Bitcoin", o.wallets.bitcoin)}${formatOsintList("Ethereum", o.wallets.ethereum)}${formatOsintList("IBAN (validado, dígito de control correcto)", o.ibans)}${!hasAnyWallet ? "  Ninguna detectada.\n" : ""}
Contactos — alta confianza (enlaces explícitos mailto:/tel:/wa.me/t.me, declarados por el propio sitio):
${formatOsintList("Email", o.contacts.highConfidence.emails)}${formatOsintList("Teléfono", o.contacts.highConfidence.phones)}${formatOsintList("WhatsApp", o.contacts.highConfidence.whatsapp)}${formatOsintList("Telegram", o.contacts.highConfidence.telegram)}${!hasAnyHighConfidenceContact ? "  Ninguno detectado.\n" : ""}
Contactos — por patrón en texto libre (menor confianza, requiere corroborar que no sea un ejemplo o dato de terceros):
${formatOsintList("Email", o.contacts.patternMatched.emails)}${formatOsintList("Teléfono", o.contacts.patternMatched.phones)}${!hasAnyPatternContact ? "  Ninguno detectado.\n" : ""}

6.1 MATRIZ POR PROVEEDOR Y ORIENTACIÓN PARA SOLICITUDES
${providerSections || "No se localizaron identificadores susceptibles de clasificación por proveedor."}

7. VIRUSTOTAL
${v?.ok ? `Consulta realizada. Reputación: ${v.attributes?.reputation ?? "N/D"}; detecciones maliciosas: ${v.attributes?.lastAnalysisStats?.malicious || 0}; sospechosas: ${v.attributes?.lastAnalysisStats?.suspicious || 0}.` : (v ? `No disponible: ${v.userMessage || v.error || "consulta fallida"}.` : "No utilizado. VirusTotal es opcional y no afecta al análisis de ads.txt.")}

8. FICHA DE IDENTIFICACIÓN PARA UNA SOLICITUD OFICIAL A GOOGLE
Uso exclusivo de autoridades policiales o judiciales mediante el cauce legal aplicable. Esta sección no constituye un requerimiento jurídico.

Objeto técnico aportado por RASTRO-ADS:
- Producto a comprobar internamente por Google: AdSense, Google Ad Manager o ambos.
- Dominio: ${host}
- URL exacta: ${report.page.url}
- Fecha/hora UTC de la evidencia: ${report.analyzedAt}
- Identificadores observados: ${c.observed.join(", ") || "Ninguno"}
- Identificadores Google DIRECT: ${c.direct.join(", ") || "Ninguno"}
- Identificadores Google RESELLER: ${c.reseller.length} (intermediarios; no se enumeran en la ficha porque no identifican al beneficiario)
- URL ads.txt: ${report.ads?.url || `https://${host}/ads.txt`}
- Líneas Google DIRECT exactas:
${directLines.map(x => "  " + x).join("\n") || "  Ninguna"}

Otros identificadores de administración, medición o contacto. Son pivotes de atribución y cada proveedor requiere su propio cauce; no identifican directamente al receptor de los ingresos publicitarios.
${osintTargets.map(t => `- ${t.label} [${t.provider}]: ${t.values.join(", ")}\n  ${t.note}`).join("\n") || "  Ninguno detectado."}

Datos que la autoridad debe añadir para que Google pueda tramitar e identificar correctamente la petición:
- Número de procedimiento o referencia de expediente.
- Autoridad y unidad requirentes, funcionario responsable y contacto oficial verificable.
- Base jurídica, instrumento procesal y jurisdicción aplicables.
- Cada pub-ID completo, dominio y URL; adjuntar la evidencia preservada y explicar el origen de cada ID.
- Periodo temporal exacto solicitado, con fecha inicial, final y zona horaria; no confundirlo con la fecha de esta captura.
- Relación concreta entre cada cuenta/dato y los hechos investigados.
- Categorías de datos solicitadas y justificación de necesidad y proporcionalidad.
- Requisitos de confidencialidad o no notificación, únicamente cuando estén legalmente autorizados.

Categorías que cabría interesar, únicamente si existen, se conservan y existe habilitación legal:
- Titular de la cuenta, datos de alta, estado, contactos e identificadores internos o cuentas vinculadas.
- Perfil de pagos, beneficiario, datos fiscales, medio de abono e historial de pagos del periodo delimitado.
- Dominios, sitios y unidades publicitarias vinculados a la cuenta durante el periodo.
- Administradores, roles, vinculaciones y cambios relevantes.
- Registros de acceso disponibles: IP, fecha/hora, dispositivo y agente de usuario.
- Preservación de datos mediante petición separada cuando sea jurídicamente procedente.

9. LIMITACIONES PROBATORIAS
Este informe contiene indicios OSINT y evidencia técnica de una carga concreta. No acredita por sí solo identidad civil, propiedad del medio, titularidad bancaria, percepción efectiva de pagos ni importes. ads.txt declara relaciones autorizadas; no es un registro de impresiones o pagos. Los indicios OSINT adicionales (analítica, wallets, contactos) son puntos de pivote, no prueba de titularidad: un ID de analítica puede compartirse entre una agencia y varios clientes distintos, y un contacto puede pertenecer a un intermediario. Los resultados deben preservarse, documentarse y corroborarse por otras fuentes o por respuesta oficial del proveedor.

10. ANEXO RESUMIDO — ADS.TXT RELEVANTE
El ads.txt completo contiene ${c.rows.length} relaciones y se conserva como archivo independiente dentro del paquete de evidencia. Este informe muestra únicamente las líneas Google DIRECT y las líneas correspondientes a pub-ID observadas.

${c.rows.filter(r => r.relationship === "DIRECT" && /(^|\.)google\.com$/i.test(r.system) || c.observed.includes(norm(r.sellerId))).map(r => `${r.system}, ${r.sellerId}, ${r.relationship}${r.certId ? ", " + r.certId : ""}`).join("\n") || "Sin líneas prioritarias"}
`;
}
function investigatorHtmlReport() { return `<!doctype html><html lang="es"><meta charset="utf-8"><title>Informe RASTRO-ADS</title><style>body{font:14px/1.55 Arial;max-width:1050px;margin:35px auto;color:#162b3b;padding:0 22px}h1{background:#082440;color:white;padding:20px;border-bottom:4px solid #2787be}pre{background:#f1f5f8;padding:18px;white-space:pre-wrap;word-break:break-word;border-radius:8px}.warn{border-left:5px solid #ae720d;padding:12px;background:#fff5dc}</style><h1>RASTRO-ADS<br><small>Informe interpretado para investigación</small></h1><pre>${esc(investigatorReport())}</pre><p class="warn">Indicios OSINT sujetos a corroboración. Las solicitudes oficiales requieren habilitación legal y el cauce correspondiente.</p></html>`; }
function download(data, name, type) { const u = URL.createObjectURL(new Blob([data], { type })), a = document.createElement("a"); a.href = u; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(u), 1000); }

// ---------------------------------------------------------------------------
// Perfil España/UE (Fase 8)
// ---------------------------------------------------------------------------
const ES_DISCLAIMER = "Esta exportación pretende facilitar la documentación técnica y la comprobación posterior de la integridad de los archivos generados. Los valores SHA-256 permiten detectar modificaciones posteriores, pero no acreditan por sí solos la autoría, la autenticidad del contenido, la licitud de la obtención ni la fecha real de adquisición.";
const ES_LERS_NOTE = "La documentación generada puede servir como material técnico auxiliar para una incorporación posterior a los sistemas y procedimientos oficiales que resulten aplicables, incluido LERS cuando corresponda. RASTRO-ADS no está integrado con LERS ni sustituye los procedimientos, diligencias, validaciones o requisitos establecidos por la organización competente.";
$("esProfile").onchange = () => {
  const on = $("esProfile").checked;
  $("esFields").hidden = !on;
  $("esText").textContent = on ? `${ES_DISCLAIMER}\n\n${ES_LERS_NOTE}` : "";
};

// ---------------------------------------------------------------------------
// Exportación probatoria — Fase 6 y 7
// ---------------------------------------------------------------------------
function setEvidenceStatus(t, c) { $("evidenceStatus").textContent = t; $("evidenceStatus").className = `status ${c}`; }

async function captureDomFromPage() {
  if (!report?.tabId) throw new Error("No hay pestaña asociada al análisis actual.");
  const capture = await tabMsg(report.tabId, { type: "CAPTURE_DOM" });
  if (capture?.url !== report.page.url) throw new Error("La pestaña cambió de URL desde el análisis. Repita la captura para evitar mezclar objetivos.");
  return capture;
}

async function generateEvidence() {
  if (!report) { setEvidenceStatus("Analice primero una página.", "bad"); return; }
  $("genEvidence").disabled = true; setEvidenceStatus("Generando paquete de evidencia…", "busy");
  try {
    const selected = {
      dom: $("artDom").checked, meta: $("artMeta").checked, traffic: $("artTraffic").checked,
      adsTxt: $("artAdsTxt").checked, appAdsTxt: $("artAppAdsTxt").checked, sellers: $("artSellers").checked,
      osint: $("artOsint").checked, results: $("artResults").checked, notes: $("artNotes").checked, warnings: $("artWarnings").checked
    };
    const selectedArtifacts = Object.entries(selected).filter(([, v]) => v).map(([k]) => k);
    const files = [];
    const host = new URL(report.page.url).hostname;

    if (selected.dom) {
      let domCapture;
      try { domCapture = await captureDomFromPage(); }
      catch (e) { techWarnings.push(`No se pudo capturar el DOM: ${e.message}`); domCapture = null; }
      if (domCapture?.html) {
        files.push({ path: "captura/dom.html", content: domCapture.html, mediaType: "text/html", description: "DOM serializado de la página investigada (document.documentElement.outerHTML). Tratar como evidencia capturada, no abrir como HTML de confianza." });
        files.push({ path: "captura/dom-metadatos.json", content: JSON.stringify({ url: domCapture.url, title: domCapture.title, charset: domCapture.charset, doctype: domCapture.doctype, capturedAtUtc: domCapture.capturedAtUtc }, null, 2), mediaType: "application/json", description: "Metadatos de la captura de DOM." });
      }
    }
    if (selected.meta) {
      files.push({ path: "captura/pagina-metadatos.json", content: JSON.stringify({ url: report.page.url, title: report.page.title, technologies: report.page.technologies, frameCount: report.page.frameCount, analyzedAtUtc: report.analyzedAt }, null, 2), mediaType: "application/json", description: "Metadatos de la página investigada." });
    }
    if (selected.traffic) {
      files.push({ path: "captura/trafico.json", content: JSON.stringify(report.traffic, null, 2), mediaType: "application/json", description: "Tráfico HTTP observado durante la captura. No se recogen cabeceras ni cookies; los parámetros sensibles de URL se sustituyen por [REDACTADO]." });
    }
    if (selected.adsTxt && report.ads?.text) {
      files.push({ path: "fuentes/ads.txt", content: report.ads.text, mediaType: "text/plain", description: `ads.txt descargado de ${report.ads.url || host + "/ads.txt"}.` });
      const c = classifications();
      const relevantRows = c.rows.filter(r => (r.relationship === "DIRECT" && /(^|\.)google\.com$/i.test(r.system)) || c.observed.includes(norm(r.sellerId)));
      files.push({ path: "resultados/ads-prioritarios.txt", content: relevantRows.map(r => `${r.system}, ${r.sellerId}, ${r.relationship}${r.certId ? ", " + r.certId : ""}`).join("\n") || "(sin líneas prioritarias)", mediaType: "text/plain", description: "Subconjunto operativo: Google DIRECT y líneas correspondientes a pub-ID observadas. El ads.txt íntegro se conserva por separado." });
    }
    if (selected.appAdsTxt && appAdsResult?.text) {
      files.push({ path: "fuentes/app-ads.txt", content: appAdsResult.text, mediaType: "text/plain", description: "app-ads.txt descargado bajo demanda." });
    }
    if (selected.sellers) {
      files.push({ path: "fuentes/sellers-relevantes.json", content: JSON.stringify(report.sellers?.matches || [], null, 2), mediaType: "application/json", description: "Subconjunto relevante de sellers.json (solo identificadores observados o declarados DIRECT para este dominio)." });
    }
    if (selected.osint) {
      files.push({ path: "fuentes/osint-adicional.json", content: JSON.stringify(report.osint || {}, null, 2), mediaType: "application/json", description: "IDs de analítica/seguimiento, direcciones de criptomonedas, IBAN y contactos extraídos del documento principal. Los contactos 'highConfidence' proceden de enlaces explícitos (mailto:/tel:/wa.me/t.me); 'patternMatched' son coincidencias de patrón en texto libre y requieren corroboración adicional." });
    }
    if (selected.results) {
      files.push({ path: "resultados/informe.txt", content: investigatorReport(), mediaType: "text/plain", description: "Informe interpretado en texto plano." });
      files.push({ path: "resultados/informe.html", content: investigatorHtmlReport(), mediaType: "text/html", description: "Informe interpretado en HTML." });
      files.push({ path: "resultados/resultados.json", content: JSON.stringify({ classifications: classifications(), monetizationLeads: monetizationLeads(), acquisitionMode: report.acquisitionMode || "unknown", conclusionHtml: $("assessment").innerHTML, providerFindings: report.providerFindings || [], osint: report.osint || null, virusTotal: report.virusTotal || null }, null, 2), mediaType: "application/json", description: "Resultados estructurados, IDs prioritarias para investigar al beneficiario, matriz por proveedor y conclusión." });
    }
    if (selected.notes) {
      const notes = $("investigatorNotes").value.trim();
      files.push({ path: "notas/notas.txt", content: notes || "(sin notas)", mediaType: "text/plain", description: "Notas del investigador." });
    }
    if (selected.warnings) {
      files.push({ path: "resultados/advertencias-tecnicas.txt", content: techWarnings.length ? techWarnings.join("\n") : "(sin advertencias técnicas registradas)", mediaType: "text/plain", description: "Registro técnico de advertencias y errores no sensibles generados durante el análisis." });
    }

    const esOn = $("esProfile").checked;
    const readmeLines = [
      "RASTRO-ADS — PAQUETE DE EVIDENCIA", "",
      ES_DISCLAIMER, "",
      "Verifique la integridad recalculando el SHA-256 de cada archivo listado en manifest.json y",
      "comparándolo con el valor declarado. Puede usar el verificador local incluido en la extensión",
      "(pestaña Evidencia → Verificador local), o cualquier herramienta de hash de su elección.", ""
    ];
    if (esOn) readmeLines.push(ES_LERS_NOTE, "");
    files.push({ path: "README-EVIDENCIA.txt", content: readmeLines.join("\n"), mediaType: "text/plain", description: "Explicación del paquete y alcance de la verificación de integridad." });

    const hashedFiles = await hashEvidenceFiles(files);

    const manifestFields = {
      toolVersion: EXT_VERSION,
      evidenceId: generateEvidenceId(),
      createdAt: new Date().toISOString(),
      target: host,
      captureMode: modeController.mode,
      timezone: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return null; } })(),
      acquisitionMethod: `Extensión de navegador RASTRO-ADS ${EXT_VERSION}, análisis pasivo iniciado por el investigador en su propio navegador.`,
      extensionVersion: EXT_VERSION,
      selectedArtifacts,
      redactionPolicy: "No se capturan cabeceras HTTP ni cookies. Los parámetros de consulta sensibles (token, apikey, session, etc.) se redactan antes de mostrar o exportar el tráfico. La clave de VirusTotal nunca se incluye.",
      warnings: [...techWarnings]
    };
    if (esOn) {
      manifestFields.warnings.push(ES_DISCLAIMER);
      const esExtra = { referencia: $("esRef").value.trim(), unidad: $("esUnit").value.trim(), investigador: $("esInvestigator").value.trim(), fechaDeclarada: $("esDate").value.trim(), observacionesAdquisicion: $("esObs").value.trim() };
      if (esExtra.investigador) manifestFields.investigator = esExtra.investigador;
      manifestFields.esProfile = { activo: true, ...esExtra, notaLers: ES_LERS_NOTE };
    }

    const manifest = buildEvidenceManifest({ ...manifestFields, hashedFiles });
    const { manifestText, manifestBytes, manifestSha256Text } = await finalizeManifest(manifest);

    const entries = hashedFiles.map(f => ({ path: `evidencia/${f.path}`, bytes: f.bytes }));
    entries.push({ path: "evidencia/manifest.json", bytes: manifestBytes });
    entries.push({ path: "evidencia/manifest.sha256", bytes: utf8Bytes(manifestSha256Text) });

    const zipBytes = createZip(entries);
    const zipHash = await sha256Hex(zipBytes);
    const fileName = timestampedFileName(`RASTRO-ADS-evidencia_${host}`, "zip", new Date());
    download(zipBytes, fileName, "application/zip");

    setEvidenceStatus(`Paquete generado: ${fileName}. SHA-256 del ZIP: ${zipHash.slice(0, 16)}…`, "ok");
    void manifestText; // el texto también queda embebido en el ZIP (evidencia/manifest.json)
  } catch (e) {
    setEvidenceStatus(`No se pudo generar el paquete: ${e.message}`, "bad");
  } finally { $("genEvidence").disabled = false; }
}

// ---------------------------------------------------------------------------
// Verificador local — Fase 7
// ---------------------------------------------------------------------------
async function runVerification() {
  const input = $("verifyFiles");
  const fileList = [...(input.files || [])];
  if (!fileList.length) { $("verifyResult").innerHTML = '<span class="empty">Seleccione un ZIP o los archivos extraídos.</span>'; return; }
  $("runVerify").disabled = true;
  try {
    let manifest = null, manifestPrefix = "", actualFiles = [], manifestBytesRead = null, declaredManifestHash = null;

    const zipFile = fileList.find(f => /\.zip$/i.test(f.name));
    if (zipFile) {
      const buf = new Uint8Array(await zipFile.arrayBuffer());
      let entries;
      try { entries = readZipEntries(buf); }
      catch (e) { $("verifyResult").innerHTML = `<span class="danger">No se pudo leer el ZIP: ${esc(e.message)}</span>`; return; }
      const manifestEntry = entries.find(e => /(^|\/)manifest\.json$/i.test(e.path));
      if (!manifestEntry) { $("verifyResult").innerHTML = '<span class="danger">El ZIP no contiene manifest.json.</span>'; return; }
      manifestPrefix = manifestEntry.path.slice(0, manifestEntry.path.length - "manifest.json".length);
      manifestBytesRead = manifestEntry.bytes;
      manifest = JSON.parse(new TextDecoder().decode(manifestEntry.bytes));
      const shaEntry = entries.find(e => /(^|\/)manifest\.sha256$/i.test(e.path));
      if (shaEntry) declaredManifestHash = new TextDecoder().decode(shaEntry.bytes).trim().split(/\s+/)[0];
      actualFiles = entries.filter(e => e !== manifestEntry && e !== shaEntry && e.path.startsWith(manifestPrefix))
        .map(e => ({ path: e.path.slice(manifestPrefix.length), bytes: e.bytes }));
    } else {
      const manifestFile = fileList.find(f => /^manifest\.json$/i.test(f.name));
      if (!manifestFile) { $("verifyResult").innerHTML = '<span class="danger">Incluya manifest.json entre los archivos seleccionados (o seleccione el ZIP exportado).</span>'; return; }
      manifestBytesRead = new Uint8Array(await manifestFile.arrayBuffer());
      manifest = JSON.parse(new TextDecoder().decode(manifestBytesRead));
      const shaFile = fileList.find(f => /^manifest\.sha256$/i.test(f.name));
      if (shaFile) declaredManifestHash = (await shaFile.text()).trim().split(/\s+/)[0];

      const others = fileList.filter(f => f !== manifestFile && f !== shaFile);
      const byBaseName = new Map();
      for (const mf of manifest.files || []) {
        const base = mf.path.split("/").pop();
        if (!byBaseName.has(base)) byBaseName.set(base, []); byBaseName.get(base).push(mf.path);
      }
      const ambiguous = [];
      for (const f of others) {
        const candidates = byBaseName.get(f.name) || [];
        if (candidates.length === 1) actualFiles.push({ path: candidates[0], bytes: new Uint8Array(await f.arrayBuffer()) });
        else if (candidates.length === 0) actualFiles.push({ path: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }); // se reportará como "adicional"
        else ambiguous.push(f.name);
      }
      if (ambiguous.length) techWarnings.push(`Verificador: nombre ambiguo, no se pudo emparejar con una única ruta del manifiesto: ${ambiguous.join(", ")}`);
    }

    const result = await verifyEvidenceFiles(manifest, actualFiles);
    let manifestIntegrityLine = "";
    if (declaredManifestHash && manifestBytesRead) {
      const actualManifestHash = await sha256Hex(manifestBytesRead);
      manifestIntegrityLine = actualManifestHash === declaredManifestHash
        ? '<div class="row"><b>manifest.json</b> <span class="badge direct">VERIFICADO</span> coincide con manifest.sha256</div>'
        : `<div class="row"><b>manifest.json</b> <span class="badge">MODIFICADO</span> no coincide con manifest.sha256 declarado</div>`;
    }

    const parts = [];
    parts.push(manifestIntegrityLine);
    parts.push(`<div class="row"><b>Verificados</b> ${result.verified.length}</div>`);
    if (result.modified.length) parts.push(`<div class="row"><b class="danger">Modificados</b> ${result.modified.map(m => esc(m.path)).join(", ")}</div>`);
    if (result.missing.length) parts.push(`<div class="row"><b class="danger">Ausentes</b> ${result.missing.map(esc).join(", ")}</div>`);
    if (result.unexpected.length) parts.push(`<div class="row"><b>Adicionales (no manifestados)</b> ${result.unexpected.map(esc).join(", ")}</div>`);
    if (!result.modified.length && !result.missing.length) parts.push('<p class="caution">Verificación local de integridad únicamente: no acredita autoría, licitud de la obtención ni fecha real de adquisición.</p>');
    $("verifyResult").innerHTML = parts.filter(Boolean).join("");
  } catch (e) {
    $("verifyResult").innerHTML = `<span class="danger">Error al verificar: ${esc(e.message)}</span>`;
  } finally { $("runVerify").disabled = false; }
}

// ---------------------------------------------------------------------------
// Cableado de eventos
// ---------------------------------------------------------------------------
$("capture").onclick = prepareCapture;
$("analyze").onclick = analyze;
$("adsFilter").onchange = () => { rowsShown = 80; renderAdsRows(); };
$("adsSearch").oninput = () => { rowsShown = 80; renderAdsRows(); };
$("moreRows").onclick = () => { rowsShown += 100; renderAdsRows(); };
$("fetchAppAds").onclick = fetchAppAds;
$("saveKey").onclick = activateKey;
$("clearKey").onclick = clearKey;
$("queryVt").onclick = queryVt;
$("genEvidence").onclick = generateEvidence;
$("runVerify").onclick = runVerification;
$("exportTxt").onclick = () => download(investigatorReport(), "RASTRO-ADS-informe.txt", "text/plain;charset=utf-8");
$("exportHtml").onclick = () => download(investigatorHtmlReport(), "RASTRO-ADS-informe.html", "text/html;charset=utf-8");

initMode();
