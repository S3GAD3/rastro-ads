// src/lib/evidenceManifest.js
// Generación y verificación de manifiestos de evidencia (Fase 7). Lógica pura: recibe los
// archivos ya preparados (ruta + bytes + metadatos) y calcula SHA-256 sobre sus bytes UTF-8
// exactos mediante Web Crypto. El manifiesto nunca incluye su propio hash de forma
// autorreferencial: si se desea, se genera un archivo externo manifest.sha256.

import { sha256Hex, utf8Bytes } from "./sha256.js";
import { canonicalStringify, sortPathsDeterministically } from "./canonicalJson.js";
import { sanitizeRelativePath } from "./sanitizePath.js";

const SCHEMA_VERSION = "1.0";
const TOOL_NAME = "RASTRO-ADS";

/**
 * Genera un identificador aleatorio de evidencia (no criptográficamente sensible, solo
 * para distinguir paquetes de evidencia entre sí).
 * @returns {string}
 */
export function generateEvidenceId() {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * @typedef {Object} EvidenceFileInput
 * @property {string} path        Ruta relativa dentro del paquete (se sanitiza).
 * @property {Uint8Array|string} content  Bytes o texto (se codifica a UTF-8 exacto).
 * @property {string} mediaType
 * @property {string} [description]
 */

/**
 * Calcula, para cada archivo de entrada, su ruta sanitizada, bytes UTF-8 exactos y SHA-256.
 * @param {EvidenceFileInput[]} files
 * @returns {Promise<Array<{path:string, bytes:Uint8Array, mediaType:string, description:string, byteLength:number, sha256:string}>>}
 */
export async function hashEvidenceFiles(files) {
  const out = [];
  for (const f of files) {
    const path = sanitizeRelativePath(f.path);
    const bytes = typeof f.content === "string" ? utf8Bytes(f.content) : f.content;
    const sha256 = await sha256Hex(bytes);
    out.push({ path, bytes, mediaType: f.mediaType || "application/octet-stream", description: f.description || "", byteLength: bytes.length, sha256 });
  }
  return out;
}

/**
 * Construye el objeto manifest.json (sin serializar todavía) a partir de archivos ya hasheados.
 * No incluye el hash del propio manifest.json (ver `manifest.sha256`, generado aparte).
 *
 * @param {Object} params
 * @param {string} params.toolVersion
 * @param {string} params.evidenceId
 * @param {string} params.createdAt        ISO 8601 UTC
 * @param {string} params.target           dominio o URL investigada
 * @param {"ephemeral"|"session"} params.captureMode
 * @param {string} [params.investigator]   solo si se introduce voluntariamente
 * @param {string} [params.timezone]       zona horaria informativa del investigador (no de la evidencia)
 * @param {string} params.acquisitionMethod
 * @param {string} [params.extensionVersion]
 * @param {string[]} params.selectedArtifacts
 * @param {string} params.redactionPolicy
 * @param {string[]} [params.warnings]
 * @param {Array<{path:string, mediaType:string, byteLength:number, sha256:string, description:string}>} params.hashedFiles
 * @returns {Object}
 */
export function buildEvidenceManifest(params) {
  const {
    toolVersion, evidenceId, createdAt, target, captureMode, investigator, timezone,
    acquisitionMethod, extensionVersion, selectedArtifacts, redactionPolicy, warnings = [], hashedFiles
  } = params;

  if (!toolVersion) throw new Error("toolVersion es obligatorio.");
  if (!evidenceId) throw new Error("evidenceId es obligatorio.");
  if (!createdAt) throw new Error("createdAt es obligatorio.");
  if (!Array.isArray(hashedFiles)) throw new Error("hashedFiles debe ser un array.");

  const sortedFiles = sortPathsDeterministically(hashedFiles.map(f => f.path))
    .map(path => hashedFiles.find(f => f.path === path))
    .map(f => ({ path: f.path, mediaType: f.mediaType, byteLength: f.byteLength, sha256: f.sha256, description: f.description || "" }));

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    tool: TOOL_NAME,
    toolVersion,
    evidenceId,
    createdAt,
    target: target || null,
    captureMode: captureMode || "unknown",
    timezone: timezone || null,
    acquisitionMethod: acquisitionMethod || "Extensión de navegador RASTRO-ADS, análisis pasivo iniciado por el investigador.",
    extensionVersion: extensionVersion || toolVersion,
    selectedArtifacts: [...(selectedArtifacts || [])].sort(),
    redactionPolicy: redactionPolicy || "No se capturan cabeceras ni cookies; se redactan parámetros de autenticación/sesión de las URL antes de exportar.",
    warnings: [...warnings],
    files: sortedFiles
  };
  if (investigator) manifest.investigator = investigator;
  return manifest;
}

/**
 * Serializa el manifiesto de forma determinista (claves ordenadas) y calcula un archivo
 * externo manifest.sha256 con el hash de esos bytes exactos.
 * @param {Object} manifest
 * @returns {Promise<{manifestText:string, manifestBytes:Uint8Array, manifestSha256:string, manifestSha256Text:string}>}
 */
export async function finalizeManifest(manifest) {
  // Formato legible (indentado) pero con claves ordenadas de forma determinista antes de indentar,
  // de modo que dos generaciones con el mismo contenido produzcan el mismo texto.
  const canonical = JSON.parse(canonicalStringify(manifest));
  const manifestText = JSON.stringify(canonical, null, 2) + "\n";
  const manifestBytes = utf8Bytes(manifestText);
  const manifestSha256 = await sha256Hex(manifestBytes);
  const manifestSha256Text = `${manifestSha256}  manifest.json\n`;
  return { manifestText, manifestBytes, manifestSha256, manifestSha256Text };
}

/**
 * Verifica un conjunto de archivos ya leídos (path + bytes) contra un manifiesto: recalcula
 * SHA-256 y clasifica cada archivo como verificado, modificado, ausente, o adicional
 * (presente pero no manifestado). Se ejecuta enteramente en local.
 *
 * @param {Object} manifest                     manifest.json ya parseado
 * @param {Array<{path:string, bytes:Uint8Array}>} actualFiles  archivos realmente presentes (excluyendo manifest.json/manifest.sha256)
 * @returns {Promise<{verified:string[], modified:Array<{path:string,expected:string,actual:string}>, missing:string[], unexpected:string[]}>}
 */
export async function verifyEvidenceFiles(manifest, actualFiles) {
  const expected = new Map((manifest.files || []).map(f => [f.path, f.sha256]));
  const actualByPath = new Map(actualFiles.map(f => [sanitizeRelativePath(f.path), f.bytes]));

  const verified = [];
  const modified = [];
  const missing = [];
  for (const [path, expectedHash] of expected) {
    if (!actualByPath.has(path)) { missing.push(path); continue; }
    const actualHash = await sha256Hex(actualByPath.get(path));
    if (actualHash === expectedHash) verified.push(path);
    else modified.push({ path, expected: expectedHash, actual: actualHash });
  }
  const unexpected = [...actualByPath.keys()].filter(p => !expected.has(p));
  return { verified, modified, missing, unexpected };
}
