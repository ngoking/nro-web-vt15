// Minimal NRO protocol implementation based on the client structure found in
// the supplied build and a public reference client. This is deliberately kept
// separate from rendering/gameplay logic.

export const VT15 = Object.freeze({
  name: "Vũ trụ 15",
  host: "dragon15.teamobi.com",
  port: 14445,
  version: "2.4.6",
});

function u8(v) { return v & 0xff; }
function s8(v) { return (v & 0x80) ? v - 0x100 : v; }

export class ByteWriter {
  constructor() { this.a = []; }
  byte(v) { this.a.push(u8(v)); return this; }
  bool(v) { return this.byte(v ? 1 : 0); }
  short(v) {
    this.a.push(u8(v >> 8), u8(v));
    return this;
  }
  int(v) {
    this.a.push(u8(v >> 24), u8(v >> 16), u8(v >> 8), u8(v));
    return this;
  }
  utf(text) {
    const data = new TextEncoder().encode(String(text));
    if (data.length > 0xffff) throw new Error("UTF field too long");
    this.short(data.length);
    for (const b of data) this.a.push(b);
    return this;
  }
  bytes(data) {
    for (const b of data) this.a.push(u8(b));
    return this;
  }
  finish() { return new Uint8Array(this.a); }
}

export class NroProtocol {
  constructor({ onPacket, onKey, onLog } = {}) {
    this.onPacket = onPacket || (() => {});
    this.onKey = onKey || (() => {});
    this.onLog = onLog || (() => {});
    this.reset();
  }

  reset() {
    this.rx = new Uint8Array(0);
    this.key = null;
    this.curR = 0;
    this.curW = 0;
    this.keyReady = false;
  }

  // Initial request used by Session_ME right after TCP connect.
  handshakeRequest() {
    // cmd=-27 (0xE5), zero payload. Zero length has identical bytes in either endian.
    return new Uint8Array([0xe5, 0x00, 0x00]);
  }

  feed(chunk) {
    const incoming = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    const joined = new Uint8Array(this.rx.length + incoming.length);
    joined.set(this.rx, 0);
    joined.set(incoming, this.rx.length);
    this.rx = joined;

    while (true) {
      const pkt = this.keyReady ? this._tryEncryptedPacket() : this._tryPlainPacket();
      if (!pkt) break;
      if (!this.keyReady && pkt.command === -27) {
        this._acceptKey(pkt.payload);
      } else {
        this.onPacket(pkt);
      }
    }
  }

  _tryPlainPacket() {
    if (this.rx.length < 3) return null;
    const command = s8(this.rx[0]);

    // Classic NRO framing is command + 2-byte size. The reference C# build is
    // decompiled around this area, so for the handshake response we accept the
    // standard big-endian interpretation and a little-endian fallback.
    const be = (this.rx[1] << 8) | this.rx[2];
    const le = this.rx[1] | (this.rx[2] << 8);
    let len = be;
    if (3 + len > this.rx.length && 3 + le <= this.rx.length) len = le;
    if (len < 0 || len > 8 * 1024 * 1024) throw new Error(`Invalid plain packet length ${len}`);
    if (this.rx.length < 3 + len) return null;

    const payload = this.rx.slice(3, 3 + len);
    this.rx = this.rx.slice(3 + len);
    return { command, payload };
  }

  _readKeyByte(raw, direction) {
    if (!this.key || this.key.length === 0) throw new Error("Key not ready");
    if (direction === "r") {
      const out = raw ^ this.key[this.curR];
      this.curR = (this.curR + 1) % this.key.length;
      return out & 0xff;
    }
    const out = raw ^ this.key[this.curW];
    this.curW = (this.curW + 1) % this.key.length;
    return out & 0xff;
  }

  _tryEncryptedPacket() {
    if (this.rx.length < 3) return null;

    // Parsing must not advance read-key state until a whole frame is available.
    const startR = this.curR;
    const dec = (raw) => this._readKeyByte(raw, "r");

    try {
      const command = s8(dec(this.rx[0]));
      const longLenCommands = new Set([-32, -66, 11, -67, -74, -87, 66]);
      let headerLen, len;

      if (longLenCommands.has(command)) {
        if (this.rx.length < 4) { this.curR = startR; return null; }
        const n0 = s8(dec(this.rx[1])) + 128;
        const n1 = s8(dec(this.rx[2])) + 128;
        const n2 = s8(dec(this.rx[3])) + 128;
        len = (n2 * 256 + n1) * 256 + n0;
        headerLen = 4;
      } else {
        const hi = dec(this.rx[1]);
        const lo = dec(this.rx[2]);
        len = (hi << 8) | lo;
        headerLen = 3;
      }

      if (len < 0 || len > 8 * 1024 * 1024) throw new Error(`Invalid encrypted packet length ${len}`);
      if (this.rx.length < headerLen + len) {
        this.curR = startR;
        return null;
      }

      const payload = new Uint8Array(len);
      for (let i = 0; i < len; i++) payload[i] = dec(this.rx[headerLen + i]);
      this.rx = this.rx.slice(headerLen + len);
      return { command, payload };
    } catch (err) {
      this.curR = startR;
      throw err;
    }
  }

  _acceptKey(payload) {
    if (!payload.length) throw new Error("Handshake response has no key payload");
    const keyLen = payload[0];
    if (keyLen <= 0 || 1 + keyLen > payload.length) {
      throw new Error(`Invalid key length ${keyLen}`);
    }
    const key = payload.slice(1, 1 + keyLen);
    for (let i = 0; i < key.length - 1; i++) key[i + 1] ^= key[i];
    this.key = key;
    this.curR = 0;
    this.curW = 0;
    this.keyReady = true;

    let ip2 = null, port2 = null, connect2 = null;
    try {
      let p = 1 + keyLen;
      const u16 = () => { const v = (payload[p] << 8) | payload[p + 1]; p += 2; return v; };
      const strLen = u16();
      ip2 = new TextDecoder().decode(payload.slice(p, p + strLen)); p += strLen;
      port2 = ((payload[p] << 24) | (payload[p + 1] << 16) | (payload[p + 2] << 8) | payload[p + 3]) >>> 0; p += 4;
      connect2 = payload[p] !== 0;
    } catch (_) {
      // Secondary endpoint is optional for the MVP.
    }

    this.onLog(`Handshake OK; key=${keyLen} bytes`);
    this.onKey({ keyLength: keyLen, ip2, port2, connect2 });
  }

  frame(command, payload = new Uint8Array(0)) {
    if (!this.keyReady) throw new Error("Handshake key not ready");
    if (!(payload instanceof Uint8Array)) payload = new Uint8Array(payload);
    if (payload.length > 0xffff) throw new Error("MVP sender only supports normal <=65535-byte packets");

    const out = new Uint8Array(3 + payload.length);
    out[0] = this._readKeyByte(u8(command), "w");
    out[1] = this._readKeyByte((payload.length >> 8) & 0xff, "w");
    out[2] = this._readKeyByte(payload.length & 0xff, "w");
    for (let i = 0; i < payload.length; i++) out[3 + i] = this._readKeyByte(payload[i], "w");
    return out;
  }

  makeSetClientType({ width = 1024, height = 600, version = VT15.version } = {}) {
    const w = new ByteWriter();
    w.byte(2)                  // messageNotLogin subcommand: set client type
      .byte(4)                 // PC client
      .byte(1)                 // zoom level
      .bool(false)
      .int(width)
      .int(height)
      .bool(true)              // qwerty
      .bool(true)              // supplied PC Unity client sets isTouch=true
      .utf(`Pc platform xxx|${version}`);
    return this.frame(-29, w.finish());
  }

  makeLogin(username, password, { version = VT15.version, type = 0 } = {}) {
    const user = String(username || "").trim();
    const pass = String(password || "");
    if (!user) throw new Error("Thiếu tài khoản");
    if (!pass) throw new Error("Thiếu mật khẩu");

    const w = new ByteWriter();
    w.byte(0)                  // messageNotLogin subcommand: login
      .utf(user)
      .utf(pass)
      .utf(version)
      .byte(type);
    return this.frame(-29, w.finish());
  }
}

export function hex(data, max = 96) {
  const a = data instanceof Uint8Array ? data : new Uint8Array(data);
  const shown = a.slice(0, max);
  const text = Array.from(shown, b => b.toString(16).padStart(2, "0")).join(" ");
  return a.length > max ? `${text} … (+${a.length - max})` : text;
}
