// src/lib/zipWriter.js
// Escritor ZIP mínimo, propio y sin dependencias externas ni CDN, suficiente para empaquetar
// un paquete de evidencia. Usa el método STORE (sin compresión) para mantener la implementación
// pequeña, auditable y determinista: el énfasis del paquete de evidencia es la integridad
// verificable (SHA-256), no el tamaño del archivo.
//
// Formato: ZIP local file headers + directorio central + EOCD, según la especificación PKZIP.
// Todas las fechas se fijan a un valor constante (1980-01-01, el mínimo representable en DOS
// date/time) para que el ZIP resultante sea reproducible byte a byte dado el mismo contenido.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * Calcula el CRC-32 (estándar ZIP/PKZIP) de unos bytes.
 * @param {Uint8Array} bytes
 * @returns {number} entero sin signo de 32 bits
 */
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(n) { return [n & 0xff, (n >>> 8) & 0xff]; }
function u32(n) { return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]; }

// 1980-01-01 00:00:00 en formato DOS date/time (constante, para reproducibilidad).
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1; // día=1, mes=1, año=1980 (año-1980=0)

/**
 * Construye un archivo ZIP (Uint8Array) a partir de una lista de entradas {path, bytes}.
 * No comprime (método STORE): prioriza simplicidad, auditabilidad y ausencia de dependencias.
 *
 * @param {Array<{path:string, bytes:Uint8Array}>} entries  rutas ya sanitizadas, únicas y en el orden deseado
 * @returns {Uint8Array}
 */
export function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const { path, bytes } of entries) {
    const nameBytes = new TextEncoder().encode(path);
    const crc = crc32(bytes);
    const size = bytes.length;

    const localHeader = new Uint8Array([
      0x50, 0x4b, 0x03, 0x04, // local file header signature
      20, 0,                  // version needed to extract
      0x00, 0x08,             // general purpose flag: bit 11 = UTF-8 filenames
      0, 0,                   // compression method: 0 = STORE
      ...u16(DOS_TIME), ...u16(DOS_DATE),
      ...u32(crc),
      ...u32(size),           // compressed size == size (STORE)
      ...u32(size),           // uncompressed size
      ...u16(nameBytes.length),
      ...u16(0)                // extra field length
    ]);

    localParts.push(localHeader, nameBytes, bytes);

    const centralHeader = new Uint8Array([
      0x50, 0x4b, 0x01, 0x02, // central directory header signature
      20, 0,                  // version made by
      20, 0,                  // version needed to extract
      0x00, 0x08,
      0, 0,
      ...u16(DOS_TIME), ...u16(DOS_DATE),
      ...u32(crc),
      ...u32(size),
      ...u32(size),
      ...u16(nameBytes.length),
      ...u16(0),               // extra field length
      ...u16(0),               // comment length
      ...u16(0),               // disk number start
      ...u16(0),               // internal file attributes
      ...u32(0),                // external file attributes
      ...u32(offset)            // relative offset of local header
    ]);
    centralParts.push(centralHeader, nameBytes);

    offset += localHeader.length + nameBytes.length + bytes.length;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const p of centralParts) centralSize += p.length;

  const eocd = new Uint8Array([
    0x50, 0x4b, 0x05, 0x06, // end of central directory signature
    ...u16(0), ...u16(0),   // disk numbers
    ...u16(entries.length), ...u16(entries.length),
    ...u32(centralSize),
    ...u32(centralStart),
    ...u16(0)                // comment length
  ]);

  const totalSize = offset + centralSize + eocd.length;
  const out = new Uint8Array(totalSize);
  let cursor = 0;
  for (const part of [...localParts, ...centralParts, eocd]) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

/**
 * Relee un ZIP generado por `createZip` (método STORE, sin compresión) devolviendo sus
 * entradas {path, bytes, crc32Header}. Solo entiende ZIPs STORE simples como los que produce
 * este mismo módulo; no es un lector ZIP general (no soporta DEFLATE, ZIP64 ni cifrado).
 * Pensado para el verificador local de paquetes de evidencia.
 *
 * @param {Uint8Array} zipBytes
 * @returns {Array<{path:string, bytes:Uint8Array, crc32Header:number}>}
 */
export function readZipEntries(zipBytes) {
  if (!(zipBytes instanceof Uint8Array)) throw new TypeError("El ZIP debe proporcionarse como Uint8Array.");
  if (zipBytes.length > 50 * 1024 * 1024) throw new Error("El ZIP supera el límite de verificación de 50 MB.");
  const dv = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  const entries = [];
  let offset = 0;
  while (offset + 4 <= zipBytes.length) {
    if (entries.length >= 500) throw new Error("El ZIP contiene demasiadas entradas.");
    const sig = dv.getUint32(offset, true);
    if (sig !== 0x04034b50) break; // fin de los local file headers (comienza el directorio central)
    if (offset + 30 > zipBytes.length) throw new Error("Cabecera ZIP truncada.");
    const method = dv.getUint16(offset + 8, true);
    if (method !== 0) throw new Error("readZipEntries solo admite el método STORE (sin compresión).");
    const compSize = dv.getUint32(offset + 18, true);
    const nameLen = dv.getUint16(offset + 26, true);
    const extraLen = dv.getUint16(offset + 28, true);
    const crcHeader = dv.getUint32(offset + 14, true);
    const nameStart = offset + 30;
    if (nameStart + nameLen + extraLen > zipBytes.length) throw new Error("Nombre o campo extra ZIP truncado.");
    const path = new TextDecoder().decode(zipBytes.slice(nameStart, nameStart + nameLen));
    const dataStart = nameStart + nameLen + extraLen;
    if (dataStart + compSize > zipBytes.length) throw new Error("Entrada ZIP truncada.");
    if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").includes("..")) throw new Error("El ZIP contiene una ruta no segura.");
    if (entries.some(e => e.path === path)) throw new Error("El ZIP contiene rutas duplicadas.");
    const bytes = zipBytes.slice(dataStart, dataStart + compSize);
    if (crc32(bytes) !== (crcHeader >>> 0)) throw new Error(`CRC-32 incorrecto en ${path}.`);
    entries.push({ path, bytes, crc32Header: crcHeader >>> 0 });
    offset = dataStart + compSize;
  }
  return entries;
}
