// src/lib/canonicalJson.js
// Canonicalización determinista de JSON: mismas claves y estructura producen siempre
// la misma cadena de salida (claves de objeto ordenadas alfabéticamente, formato estable).
// No reordena arrays, ya que su orden puede ser semánticamente significativo.

/**
 * Serializa un valor a JSON de forma determinista: las claves de cada objeto se ordenan
 * alfabéticamente (comparación Unicode por defecto de String), sin espacios superfluos.
 * @param {*} value
 * @returns {string}
 */
export function canonicalStringify(value) {
  return stringify(value);
}

function stringify(value) {
  if (value === null || value === undefined) return "null";
  const t = typeof value;
  if (t === "number") {
    if (!Number.isFinite(value)) throw new TypeError("No se pueden canonicalizar NaN o Infinity.");
    return JSON.stringify(value);
  }
  if (t === "boolean") return value ? "true" : "false";
  if (t === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(stringify).join(",") + "]";
  }
  if (t === "object") {
    const keys = Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return "{" + keys.map(k => JSON.stringify(k) + ":" + stringify(value[k])).join(",") + "}";
  }
  throw new TypeError(`No se puede canonicalizar un valor de tipo ${t}.`);
}

/**
 * Ordena de forma determinista una lista de rutas de archivo (orden Unicode por punto de código,
 * segmento a segmento), tal y como exige un manifiesto de evidencia verificable.
 * @param {string[]} paths
 * @returns {string[]}
 */
export function sortPathsDeterministically(paths) {
  return [...paths].sort((a, b) => {
    const pa = a.split("/");
    const pb = b.split("/");
    const len = Math.min(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
    }
    return pa.length - pb.length;
  });
}
