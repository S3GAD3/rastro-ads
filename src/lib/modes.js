// src/lib/modes.js
// Gestión de los modos de trabajo EFÍMERO y SESIÓN, con una interfaz de almacenamiento
// inyectable para poder probar la lógica sin las APIs reales de chrome.storage.

export const MODE_EPHEMERAL = "ephemeral";
export const MODE_SESSION = "session";

/**
 * Interfaz mínima de almacenamiento que debe implementar cualquier backend inyectado:
 *   async get(key) -> any | undefined
 *   async set(key, value) -> void
 *   async remove(key) -> void
 *   async clear() -> void
 * `createMemoryStorage()` ofrece una implementación en memoria válida para "efímero" y para tests.
 */
export function createMemoryStorage() {
  const map = new Map();
  return {
    kind: "memory",
    async get(key) { return map.has(key) ? map.get(key) : undefined; },
    async set(key, value) { map.set(key, value); },
    async remove(key) { map.delete(key); },
    async clear() { map.clear(); },
    _debugSize() { return map.size; }
  };
}

/**
 * Envuelve chrome.storage.session (u otro backend con la misma forma callback/promesa)
 * en la interfaz get/set/remove/clear basada en promesas.
 * @param {*} chromeStorageArea  p.ej. chrome.storage.session
 */
export function wrapChromeStorageArea(chromeStorageArea) {
  return {
    kind: "chrome.storage.session",
    async get(key) {
      const result = await chromeStorageArea.get(key);
      return result ? result[key] : undefined;
    },
    async set(key, value) { await chromeStorageArea.set({ [key]: value }); },
    async remove(key) { await chromeStorageArea.remove(key); },
    async clear() { await chromeStorageArea.clear(); }
  };
}

/**
 * Controlador de modo de trabajo. No decide por sí mismo qué backend usar: en modo EFÍMERO
 * fuerza el uso de almacenamiento en memoria (nunca persistente) y en modo SESIÓN usa
 * exclusivamente el backend de sesión inyectado (nunca almacenamiento persistente/local).
 *
 * Esto hace que "el modo efímero no llama a almacenamiento persistente" y "el modo sesión
 * usa exclusivamente chrome.storage.session" sean propiedades comprobables por construcción.
 */
export class WorkModeController {
  /**
   * @param {Object} opts
   * @param {"ephemeral"|"session"} [opts.mode]
   * @param {*} opts.sessionStorage  backend get/set/remove/clear para el modo SESIÓN (p.ej. wrapChromeStorageArea(chrome.storage.session))
   * @param {*} [opts.memoryStorageFactory]  fábrica de almacenamiento en memoria para el modo EFÍMERO
   */
  constructor({ mode = MODE_EPHEMERAL, sessionStorage, memoryStorageFactory = createMemoryStorage } = {}) {
    if (!sessionStorage) throw new Error("WorkModeController requiere un backend de almacenamiento de sesión inyectado.");
    this._sessionStorage = sessionStorage;
    this._memoryStorageFactory = memoryStorageFactory;
    this._memoryStorage = memoryStorageFactory();
    this.mode = mode;
  }

  get storage() {
    return this.mode === MODE_SESSION ? this._sessionStorage : this._memoryStorage;
  }

  /**
   * Cambia de modo. Al cambiar, borra explícitamente el estado del modo anterior para
   * que no queden copias residuales (ninguna persistencia silenciosa entre modos).
   * @param {"ephemeral"|"session"} newMode
   */
  async setMode(newMode) {
    if (newMode !== MODE_EPHEMERAL && newMode !== MODE_SESSION) throw new Error(`Modo desconocido: ${newMode}`);
    await this.clearAll();
    this.mode = newMode;
  }

  async get(key) { return this.storage.get(key); }
  async set(key, value) { return this.storage.set(key, value); }
  async remove(key) { return this.storage.remove(key); }

  /** Borra el estado del modo actual ("Borrar datos ahora" / "Nueva investigación"). */
  async clearCurrent() { return this.storage.clear(); }

  /** Borra tanto el almacenamiento en memoria como el de sesión, sin dejar residuos al cambiar de modo. */
  async clearAll() {
    await this._memoryStorage.clear();
    await this._sessionStorage.clear();
  }
}

/**
 * Claves sensibles que en modo EFÍMERO o SESIÓN nunca deben escribirse en almacenamiento
 * persistente (chrome.storage.local, localStorage, IndexedDB). Se usa como lista de
 * comprobación en los tests y en la capa de integración con Chrome.
 */
export const NEVER_PERSISTENT_KEYS = Object.freeze(["vtApiKey", "lastReport", "investigatorNotes", "evidenceDraft"]);
