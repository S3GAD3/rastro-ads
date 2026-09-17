// src/lib/vtErrors.js
// Clasificación centralizada y diferenciada de respuestas y errores de VirusTotal.
// Lógica pura: no realiza peticiones de red, solo interpreta su resultado.

/**
 * @typedef {Object} VtOutcome
 * @property {string} code               Código corto estable (p.ej. "VT_UNAUTHORIZED").
 * @property {string} category           Categoría amplia ("success"|"client_error"|"server_error"|"network"|"other").
 * @property {boolean} retryable         Si tiene sentido reintentar la consulta.
 * @property {string} userMessage        Mensaje en español apto para mostrar al investigador.
 * @property {string} technicalMessage   Mensaje técnico, sin secretos.
 * @property {number|null} httpStatus    Código HTTP, si lo hay.
 * @property {number|null} retryAfter    Segundos indicados por Retry-After, si existen.
 * @property {string|null} cause         Causa de bajo nivel (nombre de excepción), sin datos sensibles.
 */

const SENSITIVE_HEADER_NAMES = new Set(["authorization", "proxy-authorization", "cookie", "set-cookie", "x-apikey", "x-api-key"]);

/**
 * Elimina cabeceras sensibles de un objeto de cabeceras plano antes de registrarlas o exportarlas.
 * @param {Record<string,string>|Headers|null|undefined} headers
 * @returns {Record<string,string>}
 */
export function redactHeaders(headers) {
  const out = {};
  if (!headers) return out;
  const entries = typeof headers.entries === "function" ? [...headers.entries()] : Object.entries(headers);
  for (const [key, value] of entries) {
    out[key] = SENSITIVE_HEADER_NAMES.has(String(key).toLowerCase()) ? "[REDACTADO]" : value;
  }
  return out;
}

function parseRetryAfter(headers) {
  const raw = headers && typeof headers.get === "function" ? headers.get("retry-after") : headers?.["retry-after"];
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds;
  const dateMs = Date.parse(raw);
  if (!Number.isNaN(dateMs)) return Math.max(0, Math.round((dateMs - Date.now()) / 1000));
  return null;
}

function base(overrides) {
  return {
    code: "VT_UNKNOWN",
    category: "other",
    retryable: false,
    userMessage: "No se pudo interpretar la respuesta de VirusTotal.",
    technicalMessage: "",
    httpStatus: null,
    retryAfter: null,
    cause: null,
    ...overrides
  };
}

/**
 * Clasifica el resultado de una llamada a la API de VirusTotal.
 *
 * @param {Object} input
 * @param {number|null} [input.status]        Código HTTP recibido, si la petición llegó a completarse.
 * @param {any} [input.body]                   Cuerpo ya parseado (objeto) o null si no se pudo parsear.
 * @param {boolean} [input.bodyParseFailed]    true si la respuesta no era JSON válido.
 * @param {Headers|Record<string,string>} [input.headers] Cabeceras de la respuesta.
 * @param {"network"|"timeout"|"abort"|null} [input.transportError] Tipo de fallo de transporte, si lo hubo.
 * @param {string} [input.causeName]           Nombre de la excepción de bajo nivel (e.name), si existe.
 * @returns {VtOutcome}
 */
export function classifyVtOutcome(input = {}) {
  const { status = null, body = null, bodyParseFailed = false, headers = null, transportError = null, causeName = null } = input;
  const retryAfter = parseRetryAfter(headers);

  if (transportError === "abort") {
    return base({ code: "VT_ABORTED", category: "network", retryable: true, userMessage: "La consulta se canceló antes de completarse.", technicalMessage: "AbortError", cause: causeName || "AbortError" });
  }
  if (transportError === "timeout") {
    return base({ code: "VT_TIMEOUT", category: "network", retryable: true, userMessage: "VirusTotal no respondió a tiempo. Puede reintentarlo.", technicalMessage: "Timeout esperando respuesta.", cause: causeName || "TimeoutError" });
  }
  if (transportError === "network") {
    return base({ code: "VT_NETWORK_ERROR", category: "network", retryable: true, userMessage: "No se pudo contactar con VirusTotal. Compruebe la conexión.", technicalMessage: "Fallo de red antes de recibir respuesta.", cause: causeName || "NetworkError" });
  }

  if (status === null) {
    return base({ code: "VT_NO_RESPONSE", category: "network", retryable: true, userMessage: "No se recibió respuesta de VirusTotal.", technicalMessage: "Estado HTTP ausente." });
  }

  const httpStatus = status;

  if (status === 200) {
    if (bodyParseFailed) {
      return base({ code: "VT_NON_JSON_RESPONSE", category: "other", retryable: false, httpStatus, userMessage: "VirusTotal respondió con un formato inesperado.", technicalMessage: "HTTP 200 pero el cuerpo no es JSON válido." });
    }
    if (body && typeof body === "object" && ("data" in body)) {
      return base({ code: "VT_OK", category: "success", retryable: false, httpStatus, userMessage: "Consulta completada.", technicalMessage: "HTTP 200 con esquema esperado." });
    }
    return base({ code: "VT_UNEXPECTED_SCHEMA", category: "other", retryable: false, httpStatus, userMessage: "VirusTotal respondió correctamente, pero con un contenido no reconocido.", technicalMessage: "HTTP 200 sin el campo 'data' esperado." });
  }

  if (status === 204) {
    return base({ code: "VT_NO_CONTENT", category: "success", retryable: false, httpStatus, userMessage: "VirusTotal confirmó la operación sin contenido adicional.", technicalMessage: "HTTP 204." });
  }

  if (status === 400) {
    return base({ code: "VT_BAD_REQUEST", category: "client_error", retryable: false, httpStatus, userMessage: "La consulta enviada no es válida (dominio mal formado u otro parámetro incorrecto).", technicalMessage: bodyErrorText(body) || "HTTP 400." });
  }
  if (status === 401) {
    return base({ code: "VT_UNAUTHORIZED", category: "client_error", retryable: false, httpStatus, userMessage: "La clave de API de VirusTotal falta, es inválida o no está autorizada.", technicalMessage: "HTTP 401." });
  }
  if (status === 403) {
    return base({ code: "VT_FORBIDDEN", category: "client_error", retryable: false, httpStatus, userMessage: "Acceso denegado por VirusTotal: el recurso puede requerir una suscripción distinta.", technicalMessage: bodyErrorText(body) || "HTTP 403." });
  }
  if (status === 404) {
    return base({ code: "VT_NOT_FOUND", category: "client_error", retryable: false, httpStatus, userMessage: "VirusTotal no tiene información sobre este dominio (aún no analizado).", technicalMessage: "HTTP 404." });
  }
  if (status === 409) {
    return base({ code: "VT_CONFLICT", category: "client_error", retryable: false, httpStatus, userMessage: "Conflicto al procesar la solicitud en VirusTotal.", technicalMessage: "HTTP 409." });
  }
  if (status === 429) {
    return base({ code: "VT_RATE_LIMITED", category: "client_error", retryable: true, httpStatus, retryAfter, userMessage: retryAfter ? `Cuota de VirusTotal agotada. Podrá reintentar en unos ${retryAfter}s.` : "Cuota de VirusTotal agotada por ahora.", technicalMessage: "HTTP 429." });
  }
  if (status >= 500 && status <= 599) {
    return base({ code: "VT_SERVER_ERROR", category: "server_error", retryable: true, httpStatus, retryAfter, userMessage: "VirusTotal tiene un problema temporal. Puede reintentarlo más tarde.", technicalMessage: `HTTP ${status}.` });
  }
  if (status >= 400 && status <= 499) {
    return base({ code: "VT_CLIENT_ERROR", category: "client_error", retryable: false, httpStatus, userMessage: `VirusTotal rechazó la solicitud (HTTP ${status}).`, technicalMessage: `HTTP ${status}.` });
  }

  return base({ code: "VT_UNEXPECTED_STATUS", category: "other", retryable: false, httpStatus, userMessage: `Respuesta inesperada de VirusTotal (HTTP ${status}).`, technicalMessage: `HTTP ${status}.` });
}

function bodyErrorText(body) {
  const msg = body?.error?.message;
  return typeof msg === "string" ? msg.slice(0, 300) : "";
}

/**
 * Redacta tokens/API keys que puedan aparecer en cadenas de consulta antes de registrarlas o exportarlas.
 * @param {string} url
 * @returns {string}
 */
export function redactQueryString(url) {
  try {
    const u = new URL(url);
    const sensitive = ["apikey", "api_key", "key", "token", "access_token", "auth"];
    let touched = false;
    for (const name of sensitive) {
      if (u.searchParams.has(name)) { u.searchParams.set(name, "[REDACTADO]"); touched = true; }
    }
    return touched ? u.toString() : url;
  } catch {
    return url;
  }
}
