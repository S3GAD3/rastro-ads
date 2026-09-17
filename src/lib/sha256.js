// src/lib/sha256.js
// Cálculo de SHA-256 mediante Web Crypto API (crypto.subtle), disponible tanto en el
// service worker de la extensión (Manifest V3) como en Node.js >= 20 para los tests.

function getSubtle() {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("Web Crypto API (crypto.subtle) no está disponible en este entorno.");
  return subtle;
}

/**
 * Convierte un ArrayBuffer/Uint8Array a una cadena hexadecimal en minúsculas.
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {string}
 */
export function bufferToHex(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

/**
 * Calcula el SHA-256, en hexadecimal minúsculo, de una cadena (bytes UTF-8 exactos) o de bytes binarios.
 * @param {string|Uint8Array|ArrayBuffer} data
 * @returns {Promise<string>}
 */
export async function sha256Hex(data) {
  const subtle = getSubtle();
  let bytes;
  if (typeof data === "string") {
    bytes = new TextEncoder().encode(data);
  } else if (data instanceof Uint8Array) {
    bytes = data;
  } else if (data instanceof ArrayBuffer) {
    bytes = new Uint8Array(data);
  } else {
    throw new TypeError("sha256Hex admite string, Uint8Array o ArrayBuffer.");
  }
  const digest = await subtle.digest("SHA-256", bytes);
  return bufferToHex(digest);
}

/**
 * Devuelve los bytes UTF-8 exactos de una cadena, tal y como deben incorporarse a un ZIP de evidencia.
 * @param {string} text
 * @returns {Uint8Array}
 */
export function utf8Bytes(text) {
  return new TextEncoder().encode(text);
}
