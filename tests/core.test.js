import test from "node:test";
import assert from "node:assert/strict";
import { parseAdsTxt } from "../src/lib/adsTxt.js";
import { redactUrl, normalizeTrafficList } from "../src/lib/trafficNormalize.js";
import { buildProviderFindings } from "../src/lib/providerFindings.js";
import { createZip, readZipEntries } from "../src/lib/zipWriter.js";
import { utf8Bytes } from "../src/lib/sha256.js";

test("ads.txt valida relaciones y descarta duplicados", () => {
  const parsed = parseAdsTxt("google.com, pub-1234567890123456, DIRECT, f08c47fec0942fa0\ninvalid\ngoogle.com, pub-1234567890123456, DIRECT, f08c47fec0942fa0\nfoo.com, 2, OTHER");
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].relationship, "DIRECT");
  assert.equal(parsed.warnings.length, 3);
});

test("redacta parámetros sensibles conservando identificadores publicitarios", () => {
  const value = redactUrl("https://example.test/tr?id=123456789&token=secret&sdkid=ABC1234567");
  assert.match(value, /id=123456789/);
  assert.match(value, /sdkid=ABC1234567/);
  assert.doesNotMatch(value, /secret/);
});

test("normaliza tráfico sin exponer cabeceras", () => {
  const [record] = normalizeTrafficList([{ url: "https://example.test/?key=secret", requestHeaders: [{ name: "Cookie", value: "x=y" }] }]);
  assert.equal(Object.hasOwn(record, "headers"), false);
  assert.doesNotMatch(record.url, /secret/);
});

test("correlaciona Meta, TikTok, Analytics y pub-ID con procedencia", () => {
  const findings = buildProviderFindings({
    page: { html: `<meta name="google-adsense-account" content="ca-pub-1234567890123456"><script>fbq('init','12345678901');ttq.load('CABCDEF12345');gtag('config','G-ABCDEF1234')</script>`, scripts: [], resources: [] },
    traffic: [{ method: "GET", url: "https://www.facebook.com/tr?id=12345678901" }],
    adsRows: [{ line: 1, system: "google.com", sellerId: "pub-1234567890123456", relationship: "DIRECT" }]
  });
  assert.ok(findings.some(f => f.provider === "Meta" && f.value === "12345678901" && f.confidence === "high"));
  assert.ok(findings.some(f => f.provider === "TikTok" && f.value === "CABCDEF12345"));
  assert.ok(findings.some(f => f.type === "analytics-ga4" && f.value === "G-ABCDEF1234"));
  assert.ok(findings.some(f => f.type === "publisher" && f.sources.some(s => s.kind === "ads.txt")));
});

test("no eleva confianza por repetir una misma clase de fuente", () => {
  const findings = buildProviderFindings({ page: { html: "", scripts: [], resources: ["https://a.test/?id=G-ABCDEF1234", "https://b.test/?id=G-ABCDEF1234"] } });
  const ga = findings.find(f => f.value === "G-ABCDEF1234");
  assert.equal(ga.confidence, "medium");
});

test("excluye RESELLER puros y conserva conflictos DIRECT/RESELLER", () => {
  const findings = buildProviderFindings({ adsRows: [
    { line: 1, system: "google.com", sellerId: "pub-1111111111111111", relationship: "RESELLER" },
    { line: 2, system: "google.com", sellerId: "pub-2222222222222222", relationship: "DIRECT" },
    { line: 3, system: "google.com", sellerId: "pub-2222222222222222", relationship: "RESELLER" }
  ] });
  assert.equal(findings.some(f => f.value === "pub-1111111111111111"), false);
  const conflict = findings.find(f => f.value === "pub-2222222222222222");
  assert.equal(conflict.relationshipConflict, true);
  assert.equal(conflict.confidence, "medium");
});

test("ZIP propio se relee y rechaza corrupción CRC", () => {
  const zip = createZip([{ path: "evidencia/a.txt", bytes: utf8Bytes("hola") }]);
  assert.equal(new TextDecoder().decode(readZipEntries(zip)[0].bytes), "hola");
  const corrupt = zip.slice();
  corrupt[corrupt.indexOf("h".charCodeAt(0), 30)] ^= 1;
  assert.throws(() => readZipEntries(corrupt), /CRC-32/);
});
