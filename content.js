function uniq(a) { return [...new Set(a.filter(Boolean))]; }
function redactResourceUrl(value) {
  try {
    const u = new URL(value);
    for (const name of ["token", "access_token", "auth", "apikey", "api_key", "key", "session", "sid", "jwt"]) if (u.searchParams.has(name)) u.searchParams.set(name, "[REDACTADO]");
    return u.toString();
  } catch { return String(value || ""); }
}
function ids(text) {
  return uniq([...String(text || "").matchAll(/(?:ca-)?(?:host-)?pub-\d{10,20}/gi)].map(m => m[0].replace(/^ca-/i, "").replace(/^host-/i, "")));
}
function detect() {
  const html = document.documentElement?.outerHTML || "";
  const scripts = [...document.scripts].map(s => redactResourceUrl(s.src)).filter(Boolean);
  const resources = performance.getEntriesByType("resource").map(r => redactResourceUrl(r.name));
  const elements = [...document.querySelectorAll("[data-ad-client],[data-ad-host],[data-ad-slot],meta[name='google-adsense-account']")];
  const elementEvidence = elements.slice(0, 100).map(el => ({
    tag: el.tagName.toLowerCase(),
    client: el.getAttribute("data-ad-client") || el.getAttribute("content") || "",
    host: el.getAttribute("data-ad-host") || "",
    slot: el.getAttribute("data-ad-slot") || ""
  }));
  const technologies = [];
  const hay = (html + "\n" + scripts.join("\n") + "\n" + resources.join("\n")).toLowerCase();
  const checks = {
    "Google AdSense": ["adsbygoogle", "pagead2.googlesyndication.com"],
    "Google Ad Manager / GPT": ["googletag", "securepubads.g.doubleclick.net"],
    "Google Tag Manager": ["googletagmanager.com/gtm.js"],
    "Google Analytics": ["google-analytics.com", "gtag("],
    "Prebid.js": ["pbjs", "prebid"],
    "Amazon Publisher Services": ["amazon-adsystem.com", "apstag"],
    "Criteo": ["criteo.com", "criteo.net"],
    "Magnite / Rubicon": ["rubiconproject.com"],
    "Index Exchange": ["indexww.com"],
    "OpenX": ["openx.net"],
    "PubMatic": ["pubmatic.com"]
    ,"Meta Pixel": ["facebook.com/tr", "connect.facebook.net"]
    ,"TikTok Pixel": ["analytics.tiktok.com", "ttq.load("]
    ,"Microsoft/Bing UET": ["bat.bing.com"]
    ,"Hotjar": ["static.hotjar.com", "hjid"]
    ,"Yandex Metrica": ["mc.yandex.ru", "ym("]
  };
  for (const [name, needles] of Object.entries(checks)) if (needles.some(n => hay.includes(n))) technologies.push(name);
  let gptSlots = [];
  try {
    const slots = window.googletag?.pubads?.().getSlots?.() || [];
    gptSlots = slots.map(s => ({path: s.getAdUnitPath?.() || "", sizes: s.getSizes?.().map(String) || []}));
  } catch (_e) { /* no se pudo leer window.googletag; se ignora */ }
  return {
    url: location.href, origin: location.origin, title: document.title,
    timestamp: new Date().toISOString(),
    publisherIds: uniq([...ids(html), ...ids(scripts.join(" ")), ...ids(resources.join(" "))]),
    elements: elementEvidence,
    scripts: scripts.filter(x => /google|doubleclick|adservice|facebook|tiktok|bat\.bing|hotjar|yandex|criteo|rubicon|openx|pubmatic|amazon-adsystem|indexww/i.test(x)).slice(0, 100),
    resources: resources.filter(x => /google|doubleclick|adservice|facebook|tiktok|bat\.bing|hotjar|yandex|criteo|rubicon|openx|pubmatic|amazon-adsystem|indexww/i.test(x)).slice(0, 150),
    technologies, gptSlots,
    // El HTML completo solo se incluye para el frame superior (no para cada iframe), tanto por
    // tamaño del mensaje en páginas con decenas de marcos como porque los indicios OSINT
    // adicionales (analítica, wallets, contacto) casi siempre están en el documento principal.
    html: (window.self === window.top) ? html : null,
    signals: {
      googleAdsenseMeta: !!document.querySelector("meta[name='google-adsense-account']"),
      adsbygoogleElements: document.querySelectorAll("ins.adsbygoogle").length,
      adIframes: document.querySelectorAll("iframe[id*='google_ads'],iframe[src*='doubleclick'],iframe[src*='googlesyndication']").length
    }
  };
}
function captureDom() {
  // Captura probatoria del DOM: solo se invoca explícitamente cuando el investigador pulsa
  // "Exportar evidencia". No se ejecuta ningún script del documento durante la captura; se
  // toma tal cual document.documentElement.outerHTML, como texto, no como HTML ejecutable.
  return {
    url: location.href,
    title: document.title,
    charset: document.characterSet || "UTF-8",
    doctype: document.doctype ? `<!DOCTYPE ${document.doctype.name}>` : "",
    capturedAtUtc: new Date().toISOString(),
    html: document.documentElement ? document.documentElement.outerHTML : ""
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === "SCAN_PAGE") { reply(detect()); return; }
  if (msg.type === "CAPTURE_DOM") { reply(captureDom()); return; }
});
// No se examina la página al navegar normalmente. Tras una recarga iniciada expresamente,
// el service worker confirma que esta pestaña tiene una captura activa antes de ejecutar detect().
try {
  chrome.runtime.sendMessage({ type: "IS_CAPTURE_ACTIVE" }, response => {
    if (chrome.runtime.lastError || !response?.active) return;
    try { chrome.runtime.sendMessage({ type: "FRAME_SCAN", data: detect() }); } catch (_e) { /* marco desmontado */ }
  });
} catch (_e) { /* el frame puede haberse desmontado antes de consultar */ }
