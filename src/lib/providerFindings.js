import { extractAnalyticsIds } from "./osintExtract.js";

const uniq = values => [...new Set(values.filter(Boolean).map(String))];
const cleanPub = value => String(value).replace(/^(?:ca-)?(?:host-)?/i, "");

function matches(text, regex, group = 0) {
  return uniq([...String(text || "").matchAll(regex)].map(m => m[group]));
}

function add(map, provider, type, value, source) {
  if (!value) return;
  const normalized = type === "publisher" ? cleanPub(value) : String(value);
  const key = `${provider}|${type}|${normalized}`;
  const item = map.get(key) || { provider, type, value: normalized, observed: true, confidence: "medium", sources: [] };
  const sourceKey = `${source.kind}|${source.detail}`;
  if (!item.sources.some(s => `${s.kind}|${s.detail}` === sourceKey)) item.sources.push(source);
  const independentKinds = new Set(item.sources.map(s => s.kind));
  item.confidence = independentKinds.size >= 2 || independentKinds.has("network") ? "high" : "medium";
  map.set(key, item);
}

function scanText(map, text, sourceKind, detail) {
  const source = { kind: sourceKind, detail };
  for (const value of matches(text, /(?:ca-)?(?:host-)?pub-\d{10,20}/gi)) add(map, "Google", "publisher", value, source);
  const analytics = extractAnalyticsIds(text);
  for (const value of analytics.ga4) add(map, "Google", "analytics-ga4", value, source);
  for (const value of analytics.universalAnalytics) add(map, "Google", "analytics-ua", value, source);
  for (const value of analytics.gtm) add(map, "Google", "tag-manager", value, source);
  for (const value of analytics.googleSiteVerification) add(map, "Google", "site-verification", value, source);
  for (const value of analytics.metaPixel) add(map, "Meta", "pixel", value, source);
  for (const value of analytics.tiktokPixel) add(map, "TikTok", "pixel", value, source);
  for (const value of analytics.bingUet) add(map, "Microsoft", "uet", value, source);
  for (const value of analytics.hotjar) add(map, "Hotjar", "site-id", value, source);
  for (const value of analytics.yandexMetrica) add(map, "Yandex", "metrica", value, source);

  for (const value of matches(text, /(?:facebook\.com\/tr|facebook\.net\/tr)[^\s"']*[?&](?:id|pixel_id)=(\d{8,20})/gi, 1)) add(map, "Meta", "pixel", value, source);
  for (const value of matches(text, /analytics\.tiktok\.com[^\s"']*[?&](?:sdkid|pixel_code)=([A-Za-z0-9]{8,32})/gi, 1)) add(map, "TikTok", "pixel", value, source);
  for (const value of matches(text, /bat\.bing\.com[^\s"']*[?&]ti=(\d{5,12})/gi, 1)) add(map, "Microsoft", "uet", value, source);
  for (const value of matches(text, /(?:google-analytics\.com|googletagmanager\.com)[^\s"']*[?&](?:tid|id)=(G-[A-Z0-9]{6,14}|UA-\d{4,10}-\d{1,4})/gi, 1)) add(map, "Google", /^G-/i.test(value) ? "analytics-ga4" : "analytics-ua", value.toUpperCase(), source);
}

export function buildProviderFindings({ page = {}, traffic = [], adsRows = [] } = {}) {
  const map = new Map();
  scanText(map, page.html || "", "dom", "Documento principal");
  for (const element of page.elements || []) {
    const detail = `Elemento <${element.tag || "desconocido"}>${element.slot ? ` · slot ${element.slot}` : ""}`;
    for (const value of matches(`${element.client || ""} ${element.host || ""}`, /(?:ca-)?(?:host-)?pub-\d{10,20}/gi)) add(map, "Google", "publisher", value, { kind: "dom", detail });
  }
  for (const url of uniq([...(page.scripts || []), ...(page.resources || [])])) scanText(map, url, "resource", url.slice(0, 500));
  for (const record of traffic || []) scanText(map, record.url || "", "network", `${record.method || "GET"} ${(record.url || "").slice(0, 500)}`);
  const relations = new Map();
  for (const row of adsRows || []) {
    if (!/(^|\.)google\.com$/i.test(row.system) || !/^(?:ca-)?(?:host-)?pub-\d{10,20}$/i.test(row.sellerId)) continue;
    const id = cleanPub(row.sellerId), rel = relations.get(id) || { direct: [], reseller: [] };
    (row.relationship === "DIRECT" ? rel.direct : rel.reseller).push(row.line);
    relations.set(id, rel);
    // Los RESELLER no entran por sí solos en la matriz operativa: describen intermediación,
    // no al beneficiario. Sí se conservan si el ID también fue observado o figura como DIRECT.
    if (row.relationship === "DIRECT") add(map, "Google", "publisher", id, { kind: "ads.txt", detail: `Línea ${row.line}: DIRECT` });
  }
  for (const [id, rel] of relations) {
    const item = map.get(`Google|publisher|${id}`);
    if (!item) continue;
    item.adsRelations = { directLines: rel.direct, resellerLines: rel.reseller };
    item.direct = rel.direct.length > 0;
    item.reseller = rel.reseller.length > 0;
    item.relationshipConflict = item.direct && item.reseller;
  }
  return [...map.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.type.localeCompare(b.type) || a.value.localeCompare(b.value));
}

export const PROVIDER_GUIDANCE = Object.freeze({
  Google: {
    caution: "Solo las pub-ID de AdSense/Ad Manager son referencias directas para investigar al posible receptor de ingresos. Analytics, GTM y Site Verification sirven para atribuir administración, no pagos.",
    request: ["para cada pub-ID: producto, cuenta y recurso interno vinculado", "titular, datos de alta, contacto, usuarios y administradores", "para AdSense/Ad Manager: perfil de pagos, beneficiario, datos fiscales, medio de abono e historial del periodo delimitado", "dominios, sitios y unidades publicitarias vinculados", "historial de cambios y registros de acceso disponibles", "para Analytics/GTM: propiedad o contenedor, usuarios, roles y vinculaciones, sin presumir datos de pagos", "preservación de datos cuando proceda"]
  },
  Meta: {
    caution: "Un píxel/dataset identifica medición o publicidad y puede compartirse. Normalmente permite investigar quién administra o anuncia, no quién recibe la monetización de la web.",
    request: ["píxel/dataset y Business Portfolio relacionado", "cuentas publicitarias con acceso", "usuarios, administradores, roles y fechas", "dominios y activos vinculados", "historial de cambios y registros de acceso disponibles", "datos de facturación solo para identificar al anunciante o pagador, sin tratarlos como beneficiario de la web", "preservación de datos cuando proceda"]
  },
  TikTok: {
    caution: "El píxel identifica medición y puede relacionarse con varias cuentas. Es un pivote de administración o publicidad, no una ID directa del receptor de monetización.",
    request: ["píxel y Business Center relacionado", "cuentas publicitarias que lo utilizan", "usuarios, administradores, roles y fechas", "dominios y activos relacionados", "datos de alta y registros de acceso disponibles", "facturación solo para identificar al anunciante o pagador, sin presumir que recibe ingresos de la web", "preservación de datos cuando proceda"]
  },
  Microsoft: {
    caution: "La etiqueta UET es un identificador técnico de medición y requiere corroboración.",
    request: ["cuenta de Microsoft Advertising vinculada", "usuarios, administradores y roles", "datos de registro y facturación del periodo delimitado", "dominios relacionados y registros de acceso disponibles"]
  }
});
