// src/lib/sellersParser.js
//
// Parser JSON incremental REAL para documentos sellers.json (IAB Tech Lab / seller-id.txt spec).
// No usa response.json() sobre el documento completo, no usa regex sobre el JSON entero y no
// asume que el fichero sea NDJSON: procesa un ReadableStream<Uint8Array> (o texto) carácter a
// carácter mediante una máquina de estados consciente de cadenas, escapes y anidamiento, y solo
// materializa en memoria el objeto "sellers[i]" que está siendo procesado en cada momento.
//
// Estrategia: se recorre estructuralmente todo el documento (para saber en qué profundidad y
// bajo qué clave nos encontramos) sin construir un árbol JS completo. Únicamente se acumula texto
// para: (a) las claves de objeto, que son cortas, y (b) cada elemento del array de nivel superior
// "sellers", que se aísla como texto y se interpreta con JSON.parse una vez completo (nunca se
// llama a JSON.parse sobre el documento entero).

export class SellersParseError extends Error {
  constructor(message) {
    super(message);
    this.name = "SellersParseError";
  }
}

function byteLengthUtf8(str) {
  return new TextEncoder().encode(str).length;
}

const NUMBER_CHARS = /[0-9+\-.eE]/;
const LITERAL_CHARS = /[a-z]/;

/**
 * Parser incremental de bajo nivel. Uso típico:
 *
 *   const parser = new SellersJsonStreamParser({ onSeller: (s) => ..., maxSellers: 500 });
 *   parser.pushBytes(chunk1);
 *   parser.pushBytes(chunk2);
 *   const result = parser.end();
 */
export class SellersJsonStreamParser {
  /**
   * @param {Object} [opts]
   * @param {(seller: object, meta: {index:number}) => void} [opts.onSeller]
   * @param {number} [opts.maxSellers]
   * @param {AbortSignal} [opts.signal]
   */
  constructor({ onSeller, maxSellers = Infinity, signal = null } = {}) {
    this.onSeller = typeof onSeller === "function" ? onSeller : null;
    this.maxSellers = Number.isFinite(maxSellers) && maxSellers > 0 ? maxSellers : Infinity;
    this.signal = signal;

    this.buf = "";
    this.pos = 0;
    this._decoder = null;

    this.stack = [];
    this.topLevelSeen = false;
    this.sellersArrayFound = false;
    this.sellersArrayClosed = false;

    this.capture = null;

    this.done = false;
    this.stopped = false;
    this.fatalError = null;
    this.truncated = false;
    this.warnings = [];

    this.validCount = 0;
    this.invalidCount = 0;
    this.emittedCount = 0;
    this.bytesProcessed = 0;
  }

  get aborted() {
    return !!(this.signal && this.signal.aborted);
  }

  _checkAbort() {
    if (this.aborted && !this.stopped) {
      this.stopped = true;
      this.warnings.push("Análisis cancelado mediante AbortSignal.");
    }
  }

  /** Alimenta un fragmento de texto ya decodificado. */
  pushText(chunkStr) {
    if (this.done || this.stopped || !chunkStr) return;
    this.bytesProcessed += byteLengthUtf8(chunkStr);
    this.buf += chunkStr;
    this._consume(false);
  }

  /** Alimenta bytes crudos (Uint8Array); decodifica de forma incremental respetando secuencias UTF-8 partidas. */
  pushBytes(bytes) {
    if (this.done || this.stopped || !bytes || !bytes.length) return;
    if (!this._decoder) this._decoder = new TextDecoder("utf-8", { fatal: false });
    this.bytesProcessed += bytes.byteLength ?? bytes.length;
    const text = this._decoder.decode(bytes, { stream: true });
    if (text) this.buf += text;
    this._consume(false);
  }

  /** Señala el final del flujo de entrada y devuelve el resultado final. */
  end() {
    if (this.done) return this._result();
    if (this._decoder) {
      const tail = this._decoder.decode();
      if (tail) this.buf += tail;
    }
    if (!this.stopped) {
      this._consume(true);
      if (this.capture) {
        if (this.capture.role === "value-sellers") {
          this.invalidCount++;
          this.truncated = true;
          this.warnings.push('Se descartó un registro de "sellers" incompleto: el documento se truncó.');
        } else if (this.capture.role === "key") {
          this.truncated = true;
          this.warnings.push("El documento JSON está truncado dentro de una clave de objeto.");
        } else {
          this.truncated = true;
          this.warnings.push("El documento JSON está truncado dentro de un valor.");
        }
        this.capture = null;
      }
      if (!this.fatalError) {
        if (!this.sellersArrayFound) {
          this.fatalError = new SellersParseError('El documento no contiene un array "sellers" válido en su nivel superior.');
        } else if (this.stack.length > 0) {
          this.truncated = true;
          this.warnings.push("El documento JSON parece truncado: no se alcanzó el cierre completo de la estructura.");
        }
      }
    }
    this.done = true;
    return this._result();
  }

  _result() {
    return {
      ok: !this.fatalError,
      fatalError: this.fatalError ? this.fatalError.message : null,
      validCount: this.validCount,
      invalidCount: this.invalidCount,
      emittedCount: this.emittedCount,
      bytesProcessed: this.bytesProcessed,
      warnings: [...this.warnings],
      aborted: this.aborted,
      truncated: this.truncated
    };
  }

  _fatal(message) {
    if (!this.fatalError) this.fatalError = new SellersParseError(message);
  }

  _skipWs() {
    while (this.pos < this.buf.length) {
      const ch = this.buf[this.pos];
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") { this.pos++; continue; }
      return this.pos;
    }
    return -1;
  }

  _advance(n) { this.pos += n; }

  _popFrame() {
    const frame = this.stack.pop();
    if (frame && frame.kind === "array" && frame.isSellersArray) this.sellersArrayClosed = true;
  }

  _beginCapture(ch, { role, frame }) {
    let kind;
    if (role === "key") {
      if (ch !== '"') { this._fatal(`Se esperaba una clave de cadena y se encontró "${ch}".`); return; }
      kind = "string";
    } else if (ch === "{" || ch === "[") {
      kind = "container";
    } else if (ch === '"') {
      kind = "string";
    } else if (ch === "-" || (ch >= "0" && ch <= "9")) {
      kind = "number";
    } else if (ch === "t" || ch === "f" || ch === "n") {
      kind = "literal";
    } else {
      this._fatal(`Valor JSON no válido: carácter inesperado "${ch}".`);
      return;
    }
    this.capture = {
      kind, role, frame,
      text: "",
      depth: 0,
      inString: false,
      escape: false,
      started: false,
      discard: role === "value-generic"
    };
  }

  _advanceCapture(atEnd) {
    const cap = this.capture;
    const segStart = this.pos;

    if (cap.kind === "container") {
      while (this.pos < this.buf.length) {
        const ch = this.buf[this.pos];
        if (cap.inString) {
          if (cap.escape) cap.escape = false;
          else if (ch === "\\") cap.escape = true;
          else if (ch === '"') cap.inString = false;
          this.pos++;
          continue;
        }
        if (ch === '"') { cap.inString = true; this.pos++; continue; }
        if (ch === "{" || ch === "[") { cap.depth++; this.pos++; continue; }
        if (ch === "}" || ch === "]") {
          cap.depth--;
          this.pos++;
          if (cap.depth === 0) {
            if (!cap.discard) cap.text += this.buf.slice(segStart, this.pos);
            this._finishCapture();
            return "done";
          }
          continue;
        }
        this.pos++;
      }
      if (!cap.discard) cap.text += this.buf.slice(segStart, this.pos);
      return "need-more";
    }

    if (cap.kind === "string") {
      while (this.pos < this.buf.length) {
        const ch = this.buf[this.pos];
        if (!cap.started) { cap.started = true; this.pos++; continue; } // consume opening quote
        if (cap.escape) { cap.escape = false; this.pos++; continue; }
        if (ch === "\\") { cap.escape = true; this.pos++; continue; }
        if (ch === '"') {
          this.pos++;
          if (!cap.discard) cap.text += this.buf.slice(segStart, this.pos);
          this._finishCapture();
          return "done";
        }
        this.pos++;
      }
      if (!cap.discard) cap.text += this.buf.slice(segStart, this.pos);
      return "need-more";
    }

    // number / literal (true|false|null): consumir mientras el carácter pertenezca al token.
    const re = cap.kind === "number" ? NUMBER_CHARS : LITERAL_CHARS;
    while (this.pos < this.buf.length) {
      const ch = this.buf[this.pos];
      if (!re.test(ch)) {
        if (!cap.discard) cap.text += this.buf.slice(segStart, this.pos);
        this._finishCapture();
        return "done";
      }
      this.pos++;
    }
    if (!cap.discard) cap.text += this.buf.slice(segStart, this.pos);
    if (atEnd) { this._finishCapture(); return "done"; }
    return "need-more";
  }

  _finishCapture() {
    const cap = this.capture;
    this.capture = null;

    if (cap.role === "key") {
      let keyStr;
      try { keyStr = JSON.parse(cap.text); } catch (e) { this._fatal(`Clave de objeto no válida: ${e.message}`); return; }
      cap.frame.lastKey = keyStr;
      cap.frame.state = "AFTER_KEY";
      return;
    }

    if (cap.role === "value-sellers") {
      let parsed;
      try { parsed = JSON.parse(cap.text); }
      catch (e) {
        this.invalidCount++;
        this.warnings.push(`Registro de "sellers" no interpretable como JSON: ${e.message}`);
        return;
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        this.invalidCount++;
        this.warnings.push('Se encontró un elemento en "sellers" que no es un objeto; se descarta.');
        return;
      }
      this.validCount++;
      this.emittedCount++;
      if (this.onSeller) {
        try { this.onSeller(parsed, { index: this.emittedCount - 1 }); }
        catch (e) { this.warnings.push(`El callback onSeller lanzó un error: ${e.message}`); }
      }
      if (this.emittedCount >= this.maxSellers) {
        this.stopped = true;
        this.warnings.push(`Límite máximo de ${this.maxSellers} vendedor(es) alcanzado.`);
      }
      return;
    }
    // role === "value-generic": valor ajeno a "sellers", se descarta intencionadamente.
  }

  _stepObject(frame) {
    switch (frame.state) {
      case "BEFORE_KEY": {
        const idx = this._skipWs(); if (idx === -1) return false;
        const ch = this.buf[this.pos];
        if (ch === "}") { this._advance(1); this._popFrame(); return true; }
        if (ch !== '"') { this._fatal(`Se esperaba una clave de cadena o "}" y se encontró "${ch}".`); return false; }
        this._beginCapture(ch, { role: "key", frame });
        return !this.fatalError;
      }
      case "AFTER_KEY": {
        const idx = this._skipWs(); if (idx === -1) return false;
        const ch = this.buf[this.pos];
        if (ch !== ":") { this._fatal(`Se esperaba ":" tras la clave y se encontró "${ch}".`); return false; }
        this._advance(1);
        frame.state = "BEFORE_VALUE";
        return true;
      }
      case "BEFORE_VALUE": {
        const idx = this._skipWs(); if (idx === -1) return false;
        const ch = this.buf[this.pos];
        const isSellersKey = frame.isTop && frame.lastKey === "sellers";
        if (ch === "{") {
          this._advance(1);
          this.stack.push({ kind: "object", state: "BEFORE_KEY", isTop: false, isSellersArray: false, lastKey: null });
          frame.state = "AFTER_VALUE";
          return true;
        }
        if (ch === "[") {
          this._advance(1);
          this.stack.push({ kind: "array", state: "BEFORE_VALUE", isSellersArray: !!isSellersKey });
          if (isSellersKey) this.sellersArrayFound = true;
          frame.state = "AFTER_VALUE";
          return true;
        }
        this._beginCapture(ch, { role: "value-generic", frame });
        if (this.fatalError) return false;
        frame.state = "AFTER_VALUE";
        return true;
      }
      case "AFTER_VALUE": {
        const idx = this._skipWs(); if (idx === -1) return false;
        const ch = this.buf[this.pos];
        if (ch === ",") { this._advance(1); frame.state = "BEFORE_KEY"; return true; }
        if (ch === "}") { this._advance(1); this._popFrame(); return true; }
        this._fatal(`Se esperaba "," o "}" y se encontró "${ch}".`);
        return false;
      }
      default:
        this._fatal("Estado interno de objeto no reconocido.");
        return false;
    }
  }

  _stepArray(frame) {
    switch (frame.state) {
      case "BEFORE_VALUE": {
        const idx = this._skipWs(); if (idx === -1) return false;
        const ch = this.buf[this.pos];
        if (ch === "]") { this._advance(1); this._popFrame(); return true; }
        if (frame.isSellersArray) {
          this._beginCapture(ch, { role: "value-sellers", frame });
          if (this.fatalError) return false;
          frame.state = "AFTER_VALUE";
          return true;
        }
        if (ch === "{") {
          this._advance(1);
          this.stack.push({ kind: "object", state: "BEFORE_KEY", isTop: false, isSellersArray: false, lastKey: null });
          frame.state = "AFTER_VALUE";
          return true;
        }
        if (ch === "[") {
          this._advance(1);
          this.stack.push({ kind: "array", state: "BEFORE_VALUE", isSellersArray: false });
          frame.state = "AFTER_VALUE";
          return true;
        }
        this._beginCapture(ch, { role: "value-generic", frame });
        if (this.fatalError) return false;
        frame.state = "AFTER_VALUE";
        return true;
      }
      case "AFTER_VALUE": {
        const idx = this._skipWs(); if (idx === -1) return false;
        const ch = this.buf[this.pos];
        if (ch === ",") { this._advance(1); frame.state = "BEFORE_VALUE"; return true; }
        if (ch === "]") { this._advance(1); this._popFrame(); return true; }
        this._fatal(`Se esperaba "," o "]" dentro del array y se encontró "${ch}".`);
        return false;
      }
      default:
        this._fatal("Estado interno de array no reconocido.");
        return false;
    }
  }

  _consume(atEnd) {
    while (true) {
      if (this.stopped) break;
      this._checkAbort();
      if (this.stopped) break;

      if (this.capture) {
        const r = this._advanceCapture(atEnd);
        if (this.fatalError) break;
        if (r === "need-more") break;
        continue;
      }

      if (this.stack.length === 0) {
        if (this.topLevelSeen) break; // documento de nivel superior ya cerrado; se ignora cualquier resto
        const idx = this._skipWs(); if (idx === -1) break;
        const ch = this.buf[this.pos];
        if (ch !== "{") { this._fatal(`Se esperaba "{" al inicio del documento JSON y se encontró "${ch}".`); break; }
        this._advance(1);
        this.topLevelSeen = true;
        this.stack.push({ kind: "object", state: "BEFORE_KEY", isTop: true, isSellersArray: false, lastKey: null });
        continue;
      }

      const frame = this.stack[this.stack.length - 1];
      const progressed = frame.kind === "object" ? this._stepObject(frame) : this._stepArray(frame);
      if (this.fatalError) break;
      if (!progressed) break;
    }
    this.buf = this.buf.slice(this.pos);
    this.pos = 0;
  }
}

/**
 * Ejecuta el parser incremental sobre un ReadableStream<Uint8Array> (p.ej. response.body),
 * un iterable asíncrono de Uint8Array/cadenas, o directamente una cadena de texto.
 * Si no se proporciona `onSeller`, los vendedores encontrados (hasta `maxSellers`) se devuelven
 * en `result.sellers`.
 *
 * @param {ReadableStream<Uint8Array>|AsyncIterable<Uint8Array|string>|string} source
 * @param {Object} [options]  mismas opciones que SellersJsonStreamParser
 * @returns {Promise<Object>}
 */
export async function parseSellersJsonStream(source, options = {}) {
  const collected = [];
  const userOnSeller = options.onSeller;
  const parser = new SellersJsonStreamParser({
    ...options,
    onSeller: (seller, meta) => {
      if (userOnSeller) userOnSeller(seller, meta);
      else collected.push(seller);
    }
  });

  if (source && typeof source.getReader === "function") {
    const reader = source.getReader();
    try {
      while (true) {
        if (parser.stopped || options.signal?.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;
        parser.pushBytes(value);
      }
    } finally {
      try { await reader.cancel(); } catch { /* ya cerrado o cancelado */ }
      try { reader.releaseLock(); } catch { /* nada que liberar */ }
    }
  } else if (source && typeof source[Symbol.asyncIterator] === "function") {
    for await (const chunk of source) {
      if (parser.stopped) break;
      if (typeof chunk === "string") parser.pushText(chunk); else parser.pushBytes(chunk);
    }
  } else if (typeof source === "string") {
    parser.pushText(source);
  } else {
    throw new TypeError("source debe ser un ReadableStream, un iterable asíncrono o una cadena.");
  }

  const result = parser.end();
  if (!userOnSeller) result.sellers = collected;
  return result;
}
