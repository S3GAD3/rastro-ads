// src/lib/adsTxt.js
// Parseo puro de ads.txt / app-ads.txt (IAB Tech Lab). Sin dependencias de red ni de Chrome.

/**
 * Analiza el contenido textual de un ads.txt o app-ads.txt.
 * @param {string} text
 * @returns {{rows: Array<{line:number, system:string, sellerId:string, relationship:string, certId:string}>, meta: Record<string,string>}}
 */
export function parseAdsTxt(text) {
  const rows = [];
  const meta = {};
  const warnings = [];
  const seen = new Set();
  String(text || "").split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) return;
    const kv = line.match(/^([A-Z][A-Z0-9_-]*)\s*=\s*(.+)$/i);
    if (kv) { meta[kv[1].toUpperCase()] = kv[2].trim(); return; }
    const p = line.split(",").map(x => x.trim());
    if (p.length < 3) { warnings.push(`Línea ${i + 1}: número insuficiente de campos.`); return; }
    const system = p[0].toLowerCase(), sellerId = p[1], relationship = p[2].toUpperCase(), certId = p[3] || "";
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(system)) { warnings.push(`Línea ${i + 1}: sistema publicitario no válido.`); return; }
    if (!sellerId || sellerId.length > 256) { warnings.push(`Línea ${i + 1}: identificador de vendedor vacío o excesivo.`); return; }
    if (relationship !== "DIRECT" && relationship !== "RESELLER") { warnings.push(`Línea ${i + 1}: relación distinta de DIRECT/RESELLER.`); return; }
    if (certId && !/^[a-z0-9]{6,64}$/i.test(certId)) warnings.push(`Línea ${i + 1}: identificador de certificación inusual.`);
    const key = `${system}\u0000${sellerId}\u0000${relationship}\u0000${certId}`;
    if (seen.has(key)) { warnings.push(`Línea ${i + 1}: relación duplicada.`); return; }
    seen.add(key);
    rows.push({ line: i + 1, system, sellerId, relationship, certId });
  });
  return { rows, meta, warnings };
}
