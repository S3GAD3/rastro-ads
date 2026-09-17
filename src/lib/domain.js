// src/lib/domain.js
// Normalización y validación de dominios y URLs. Lógica pura, sin dependencias de Chrome.

/**
 * Normaliza un dominio o una URL a un nombre de host en minúsculas, sin "www.".
 * Lanza un Error legible si la entrada no puede interpretarse como dominio.
 * @param {string} input
 * @returns {string}
 */
export function normalizeDomain(input) {
  if (typeof input !== "string") throw new TypeError("El dominio debe ser una cadena de texto.");
  let s = input.trim().toLowerCase();
  if (!s) throw new Error("El dominio está vacío.");
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = "http://" + s;
  let url;
  try {
    url = new URL(s);
  } catch {
    throw new Error(`Dominio no válido: "${input}"`);
  }
  let host = url.hostname.replace(/\.$/, "");
  if (host.startsWith("www.")) host = host.slice(4);
  if (!host || !/^[a-z0-9.-]+$/i.test(host) || !host.includes(".") || host.startsWith(".") || host.endsWith(".") || host.includes("..")) {
    throw new Error(`Dominio no válido: "${input}"`);
  }
  return host;
}

/**
 * Indica si una cadena es una URL http(s) sintácticamente válida.
 * @param {string} input
 * @returns {boolean}
 */
export function isValidHttpUrl(input) {
  if (typeof input !== "string" || !input) return false;
  try {
    const u = new URL(input);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Devuelve el origen https:// para un dominio normalizado, útil para construir
 * rutas como /ads.txt o /app-ads.txt.
 * @param {string} domain
 * @returns {string}
 */
export function originForDomain(domain) {
  return `https://${normalizeDomain(domain)}`;
}

/**
 * Comprueba si `candidate` es el mismo dominio que `reference`, o un subdominio directo de éste.
 * Útil para contrastar OWNERDOMAIN/MANAGERDOMAIN de ads.txt contra el dominio investigado.
 * @param {string} candidate
 * @param {string} reference
 * @returns {boolean}
 */
export function isSameOrSubdomain(candidate, reference) {
  try {
    const c = normalizeDomain(candidate);
    const r = normalizeDomain(reference);
    return c === r || c.endsWith("." + r) || r.endsWith("." + c);
  } catch {
    return false;
  }
}
