// src/lib/sanitizePath.js
// Sanitización de nombres de archivo y rutas, compatible con Windows, macOS y Linux,
// para usarse en exportaciones y paquetes de evidencia.

// Nombres reservados en Windows (con o sin extensión).
const WINDOWS_RESERVED = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"
]);

// Caracteres no válidos en nombres de archivo de Windows: < > : " / \ | ? * y controles.
// eslint-disable-next-line no-control-regex
const INVALID_CHARS = /[<>:"/\\|?*\x00-\x1F]/g;

/**
 * Sanitiza un único segmento de nombre de archivo (sin separadores de ruta).
 * @param {string} name
 * @param {string} [fallback]
 * @returns {string}
 */
export function sanitizeFileName(name, fallback = "archivo") {
  let s = String(name ?? "").normalize("NFC").trim();
  s = s.replace(INVALID_CHARS, "_");
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/\.+$/, "");
  s = s.replace(/^\.+/, "");
  if (!s) s = fallback;
  const base = s.split(".")[0].toUpperCase();
  if (WINDOWS_RESERVED.has(base)) s = "_" + s;
  if (s.length > 180) s = s.slice(0, 180);
  return s || fallback;
}

/**
 * Sanitiza una ruta relativa dentro de un paquete de evidencia, segmento a segmento,
 * evitando "..", rutas absolutas y separadores mixtos.
 * @param {string} path
 * @returns {string}
 */
export function sanitizeRelativePath(path) {
  const raw = String(path ?? "").replace(/\\/g, "/");
  const segments = raw.split("/").filter(seg => seg !== "" && seg !== "." && seg !== "..");
  const cleanSegments = segments.map(seg => sanitizeFileName(seg));
  if (!cleanSegments.length) throw new Error("La ruta resultante está vacía tras sanitizar.");
  return cleanSegments.join("/");
}

/**
 * Genera un nombre de archivo con marca de tiempo UTC segura para Windows, p.ej.
 * "RASTRO-ADS-informe_2026-09-14T101500Z.txt".
 * @param {string} baseName
 * @param {string} extension  sin punto, p.ej. "txt"
 * @param {Date} [date]
 * @returns {string}
 */
export function timestampedFileName(baseName, extension, date = new Date()) {
  const iso = date.toISOString().replace(/[:.]/g, "").replace("Z", "Z");
  const stamp = iso.replace(/(\d{4}-\d{2}-\d{2}T\d{6}).*/, "$1Z");
  return `${sanitizeFileName(baseName)}_${stamp}.${extension.replace(/^\./, "")}`;
}
