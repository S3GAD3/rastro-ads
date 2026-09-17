// src/lib/osintExtract.js
// Extracción de indicios OSINT adicionales del HTML/scripts visibles de una página:
// IDs de analítica/seguimiento (que a menudo se reutilizan entre varias webs de un mismo
// actor, aunque no compartan servidor ni monetización publicitaria), direcciones de
// criptomonedas, IBAN, y contactos (email/teléfono/Telegram/WhatsApp).
//
// Principio de diseño, igual que el resto de RASTRO-ADS: separar lo observado con alta
// confianza (enlaces explícitos como mailto:/tel:/wa.me/t.me, que el propio sitio declara
// como su canal de contacto) de lo hallado por coincidencia de patrón en texto libre, que
// requiere corroboración. Nunca se afirma más certeza de la que el dato realmente tiene.

function uniq(arr) { return [...new Set(arr.filter(Boolean))]; }

// ---------------------------------------------------------------------------
// IDs de analítica / seguimiento
// ---------------------------------------------------------------------------

/**
 * Extrae identificadores de plataformas de analítica y seguimiento presentes en el HTML o en
 * el texto de los scripts de una página. Cada categoría se devuelve por separado y ya
 * deduplicada; la ausencia de una plataforma se representa como un array vacío.
 * @param {string} text
 */
export function extractAnalyticsIds(text) {
  const s = String(text || "");
  const ga4 = uniq([...s.matchAll(/\bG-[A-Z0-9]{6,12}\b/g)].map(m => m[0]));
  const universalAnalytics = uniq([...s.matchAll(/\bUA-\d{4,10}-\d{1,4}\b/g)].map(m => m[0]));
  const gtm = uniq([...s.matchAll(/\bGTM-[A-Z0-9]{4,8}\b/g)].map(m => m[0]));

  const metaPixel = uniq([
    ...[...s.matchAll(/fbq\(\s*['"]init['"]\s*,\s*['"](\d{8,20})['"]/gi)].map(m => m[1]),
    ...[...s.matchAll(/<meta[^>]+property=["']fb:pixel_id["'][^>]+content=["'](\d{10,20})["']/gi)].map(m => m[1])
  ]);

  const tiktokPixel = uniq([
    ...[...s.matchAll(/ttq\.load\(\s*['"]([A-Za-z0-9]{8,32})['"]/gi)].map(m => m[1]),
    ...[...s.matchAll(/analytics\.tiktok\.com\/[^"'\s]*[?&]sdkid=([A-Za-z0-9]{10,32})/gi)].map(m => m[1])
  ]);

  const bingUet = s.includes("bat.bing.com")
    ? uniq([...s.matchAll(/ti\s*:\s*["'](\d{5,10})["']/g)].map(m => m[1]))
    : [];

  const hotjar = uniq([
    ...[...s.matchAll(/hotjar-(\d{5,8})\.js/g)].map(m => m[1]),
    ...[...s.matchAll(/hjid\s*[:=]\s*(\d{5,8})/g)].map(m => m[1])
  ]);

  const yandexMetrica = uniq([...s.matchAll(/ym\(\s*(\d{6,9})\s*,\s*["']init["']/g)].map(m => m[1]));

  const googleSiteVerification = uniq(
    [...s.matchAll(/<meta[^>]+name=["']google-site-verification["'][^>]+content=["']([^"']+)["']/gi)].map(m => m[1])
  );

  return { ga4, universalAnalytics, gtm, metaPixel, tiktokPixel, bingUet, hotjar, yandexMetrica, googleSiteVerification };
}

/** @param {ReturnType<typeof extractAnalyticsIds>} analytics */
export function hasAnyAnalyticsId(analytics) {
  return Object.values(analytics).some(list => list.length > 0);
}

// ---------------------------------------------------------------------------
// Direcciones de criptomonedas
// ---------------------------------------------------------------------------

/**
 * Extrae posibles direcciones de Bitcoin y Ethereum por coincidencia de patrón. No valida
 * checksums de Bech32/Base58Check (fuera de alcance de esta librería): son candidatos a
 * corroborar, no direcciones confirmadas.
 * @param {string} text
 */
export function extractWallets(text) {
  const s = String(text || "");
  const bitcoin = uniq([...s.matchAll(/\b(?:bc1[ac-hj-np-z02-9]{25,90}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})\b/g)].map(m => m[0]));
  const ethereum = uniq([...s.matchAll(/\b0x[a-fA-F0-9]{40}\b/g)].map(m => m[0]));
  return { bitcoin, ethereum };
}

// ---------------------------------------------------------------------------
// IBAN (con validación de dígito de control, módulo 97)
// ---------------------------------------------------------------------------

const IBAN_LENGTH_BY_COUNTRY = {
  AD: 24, AT: 20, BE: 16, BG: 22, CH: 21, CY: 28, CZ: 24, DE: 22, DK: 18, EE: 20,
  ES: 24, FI: 18, FR: 27, GB: 22, GR: 27, HR: 21, HU: 28, IE: 22, IS: 26, IT: 27,
  LI: 21, LT: 20, LU: 20, LV: 21, MC: 27, MT: 31, NL: 18, NO: 15, PL: 28, PT: 25,
  RO: 24, SE: 24, SI: 19, SK: 24, SM: 27
};

/**
 * Comprueba el dígito de control de un IBAN mediante el algoritmo estándar módulo 97
 * (ISO 7064 MOD 97-10). No comprueba que la cuenta exista, solo que el número es
 * estructuralmente válido.
 * @param {string} candidate
 * @returns {boolean}
 */
export function isValidIban(candidate) {
  const iban = String(candidate || "").replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(iban)) return false;
  const country = iban.slice(0, 2);
  const expectedLength = IBAN_LENGTH_BY_COUNTRY[country];
  if (expectedLength && iban.length !== expectedLength) return false;
  if (!expectedLength && (iban.length < 15 || iban.length > 34)) return false;

  const rearranged = iban.slice(4) + iban.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, ch => String(ch.charCodeAt(0) - 55));
  // Módulo 97 sobre un número potencialmente muy largo: se calcula por trozos.
  let remainder = 0;
  for (let i = 0; i < numeric.length; i += 7) {
    const chunk = String(remainder) + numeric.slice(i, i + 7);
    remainder = Number(chunk) % 97;
  }
  return remainder === 1;
}

/**
 * Extrae candidatos a IBAN del texto y devuelve solo los que superan la validación de
 * dígito de control (módulo 97), ya normalizados sin espacios.
 * @param {string} text
 */
export function extractIbans(text) {
  const s = String(text || "");
  const candidates = uniq([...s.matchAll(/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}\b/g)].map(m => m[0]));
  return candidates.map(c => c.replace(/\s+/g, "")).filter(isValidIban);
}

// ---------------------------------------------------------------------------
// Contactos: alta confianza (enlaces explícitos) vs. patrón (texto libre)
// ---------------------------------------------------------------------------

function hrefValues(html, scheme) {
  const re = new RegExp(`href\\s*=\\s*["']${scheme}([^"']+)["']`, "gi");
  return [...String(html || "").matchAll(re)].map(m => m[1]);
}

/**
 * Extrae contactos declarados explícitamente por el propio sitio mediante enlaces de acción
 * (mailto:, tel:, wa.me, t.me, tg://resolve). Esta es la categoría de mayor confianza: el
 * propio sitio construyó el enlace para que alguien haga clic y contacte por ese canal.
 * @param {string} html
 */
export function extractContactLinks(html) {
  const s = String(html || "");

  const emails = uniq(hrefValues(s, "mailto:").map(v => v.split("?")[0].trim().toLowerCase()));

  const phones = uniq(hrefValues(s, "tel:").map(v => v.replace(/[^\d+]/g, "")).filter(v => v.length >= 7));

  const whatsapp = uniq([
    ...hrefValues(s, "https://wa\\.me/").map(v => v.split("?")[0]),
    ...hrefValues(s, "http://wa\\.me/").map(v => v.split("?")[0]),
    ...[...s.matchAll(/href\s*=\s*["']https?:\/\/(?:api\.)?whatsapp\.com\/send\?phone=([^"'&]+)/gi)].map(m => m[1])
  ].map(v => v.replace(/[^\d+]/g, "")).filter(v => v.length >= 7));

  const telegram = uniq([
    ...hrefValues(s, "https://t\\.me/").map(v => v.split("?")[0]),
    ...hrefValues(s, "http://t\\.me/").map(v => v.split("?")[0]),
    ...hrefValues(s, "https://telegram\\.me/").map(v => v.split("?")[0]),
    ...[...s.matchAll(/href\s*=\s*["']tg:\/\/resolve\?domain=([^"'&]+)/gi)].map(m => m[1])
  ].filter(v => v && !/^(share|joinchat)/i.test(v)));

  return { emails, phones, whatsapp, telegram };
}

const PLACEHOLDER_EMAILS = new Set([
  "email@example.com", "your-email@example.com", "example@example.com", "test@test.com",
  "name@example.com", "user@example.com", "info@example.com", "you@example.com"
]);

/**
 * Extrae correos y teléfonos por coincidencia de patrón en texto libre (no en un enlace de
 * acción). Confianza menor que `extractContactLinks`: pueden ser ejemplos, datos de terceros
 * citados en el contenido, o falsos positivos, y requieren corroboración.
 * @param {string} text
 */
export function extractLoosePatterns(text) {
  const s = String(text || "");

  const emailRe = /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+/g;
  const emails = uniq([...s.matchAll(emailRe)].map(m => m[0].toLowerCase()))
    .filter(e => !PLACEHOLDER_EMAILS.has(e))
    .filter(e => !/\.(png|jpe?g|gif|svg|webp)$/i.test(e));

  const phoneRe = /\+\d[\d\s().-]{6,16}\d/g;
  const phones = uniq([...s.matchAll(phoneRe)].map(m => m[0].replace(/[\s().-]/g, "")));

  return { emails, phones };
}

// ---------------------------------------------------------------------------
// Combinación de alto nivel
// ---------------------------------------------------------------------------

/**
 * Ejecuta todas las extracciones sobre el HTML/texto de una página y devuelve un objeto
 * estructurado y ya deduplicado, listo para mostrarse o exportarse como evidencia.
 * @param {string} html
 */
export function extractOsintSignals(html) {
  const text = String(html || "");
  return {
    analytics: extractAnalyticsIds(text),
    wallets: extractWallets(text),
    ibans: extractIbans(text),
    contacts: {
      highConfidence: extractContactLinks(text),
      patternMatched: extractLoosePatterns(text)
    }
  };
}

/**
 * Indica si `extractOsintSignals` encontró al menos un indicio en cualquier categoría.
 * @param {ReturnType<typeof extractOsintSignals>} signals
 */
export function hasAnyOsintSignal(signals) {
  if (!signals) return false;
  if (hasAnyAnalyticsId(signals.analytics)) return true;
  if (signals.wallets.bitcoin.length || signals.wallets.ethereum.length) return true;
  if (signals.ibans.length) return true;
  const c = signals.contacts;
  return !!(c.highConfidence.emails.length || c.highConfidence.phones.length || c.highConfidence.whatsapp.length ||
    c.highConfidence.telegram.length || c.patternMatched.emails.length || c.patternMatched.phones.length);
}

/**
 * Fusiona varios resultados de `extractOsintSignals` (p.ej. de distintos marcos de una misma
 * página) en uno solo, deduplicando cada lista.
 * @param {Array<ReturnType<typeof extractOsintSignals>>} signalsList
 */
export function mergeOsintSignals(signalsList) {
  const list = (signalsList || []).filter(Boolean);
  const mergeArr = (key1, key2) => uniq(list.flatMap(s => (key2 ? s[key1][key2] : s[key1]) || []));
  return {
    analytics: {
      ga4: mergeArr("analytics", "ga4"),
      universalAnalytics: mergeArr("analytics", "universalAnalytics"),
      gtm: mergeArr("analytics", "gtm"),
      metaPixel: mergeArr("analytics", "metaPixel"),
      tiktokPixel: mergeArr("analytics", "tiktokPixel"),
      bingUet: mergeArr("analytics", "bingUet"),
      hotjar: mergeArr("analytics", "hotjar"),
      yandexMetrica: mergeArr("analytics", "yandexMetrica"),
      googleSiteVerification: mergeArr("analytics", "googleSiteVerification")
    },
    wallets: { bitcoin: mergeArr("wallets", "bitcoin"), ethereum: mergeArr("wallets", "ethereum") },
    ibans: uniq(list.flatMap(s => s.ibans || [])),
    contacts: {
      highConfidence: {
        emails: uniq(list.flatMap(s => s.contacts.highConfidence.emails || [])),
        phones: uniq(list.flatMap(s => s.contacts.highConfidence.phones || [])),
        whatsapp: uniq(list.flatMap(s => s.contacts.highConfidence.whatsapp || [])),
        telegram: uniq(list.flatMap(s => s.contacts.highConfidence.telegram || []))
      },
      patternMatched: {
        emails: uniq(list.flatMap(s => s.contacts.patternMatched.emails || [])),
        phones: uniq(list.flatMap(s => s.contacts.patternMatched.phones || []))
      }
    }
  };
}
