// src/lib/trafficNormalize.js
// Normalización de registros de tráfico capturados con chrome.webRequest. RASTRO-ADS 0.7
// no solicita cabeceras HTTP; esta capa redacta además los parámetros sensibles de URL.

const SENSITIVE_QUERY_PARAM_NAMES = ["token", "access_token", "auth", "apikey", "api_key", "key", "session", "sid", "jwt"];

/**
 * Redacta parámetros de consulta sensibles de una URL, conservando el resto intacto.
 * Si la URL no es parseable, se devuelve tal cual (no se inventan datos).
 * @param {string} url
 * @returns {string}
 */
export function redactUrl(url) {
  try {
    const u = new URL(url);
    let touched = false;
    for (const name of SENSITIVE_QUERY_PARAM_NAMES) {
      if (u.searchParams.has(name)) { u.searchParams.set(name, "[REDACTADO]"); touched = true; }
    }
    return touched ? u.toString() : url;
  } catch {
    return url;
  }
}

/**
 * Normaliza un evento crudo de chrome.webRequest.onBeforeRequest (o similar) a un registro
 * de tráfico estable para mostrar y exportar, aplicando redacción de datos sensibles.
 *
 * @param {Object} raw
 * @param {string} raw.url
 * @param {string} [raw.method]
 * @param {string} [raw.type]
 * @param {number} [raw.statusCode]
 * @param {string} [raw.initiator]
 * @param {string|number} [raw.requestId]
 * @param {number} [raw.timeStamp]
 * @param {number} [raw.size]
 * @returns {Object} registro normalizado y seguro para exportar
 */
export function normalizeTrafficRecord(raw = {}) {
  if (!raw || typeof raw.url !== "string") throw new TypeError("Un registro de tráfico requiere una URL.");
  const dateUtc = Number.isFinite(raw.timeStamp) ? new Date(raw.timeStamp).toISOString() : new Date().toISOString();
  return {
    dateUtc,
    method: raw.method || "GET",
    url: redactUrl(raw.url),
    type: raw.type || "other",
    status: Number.isFinite(raw.statusCode) ? raw.statusCode : null,
    initiator: raw.initiator || null,
    requestId: raw.requestId !== undefined ? String(raw.requestId) : null,
    size: Number.isFinite(raw.size) ? raw.size : null
  };
}

/**
 * Normaliza y deduplica (por URL+método) una lista de registros de tráfico crudos.
 * @param {Array<Object>} rawList
 * @returns {Array<Object>}
 */
export function normalizeTrafficList(rawList = []) {
  const seen = new Set();
  const out = [];
  for (const raw of rawList) {
    let rec;
    try { rec = normalizeTrafficRecord(raw); } catch { continue; }
    const key = `${rec.method} ${rec.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rec);
  }
  return out;
}
