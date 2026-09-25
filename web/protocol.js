// NRO protocol helpers for the VT15 web prototype.
// Rendering/gameplay is intentionally separate from transport/protocol logic.

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

export class ByteReader {
  constructor(data) {
    this.a = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.p = 0;
  }
  need(n) {
    if (this.p + n > this.a.length) throw new Error(`Packet truncated at ${this.p}, need ${n}`);
  }
  byte() { this.need(1); return this.a[this.p++]; }
  sbyte() { return s8(this.byte()); }
  ushort() { this.need(2); return (this.a[this.p++] << 8) | this.a[this.p++]; }
  short() {
    const v = this.ushort();
    return (v & 0x8000) ? v - 0x10000 : v;
  }
  int() {
    this.need(4);
    const v = (this.a[this.p] << 24) | (this.a[this.p + 1] << 16) | (this.a[this.p + 2] << 8) | this.a[this.p + 3];
    this.p += 4;
    return v | 0;
  }
  long() {
    this.need(8);
    let v = 0n;
    for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(this.a[this.p++]);
    if (v & (1n << 63n)) v -= 1n << 64n;
    return v;
  }
  utf() {
    const n = this.ushort();
    this.need(n);
    const s = new TextDecoder().decode(this.a.slice(this.p, this.p + n));
    this.p += n;
    return s;
  }
  remaining() { return this.a.length - this.p; }
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

  handshakeRequest() {
    return new Uint8Array([0xe5, 0x00, 0x00]); // cmd=-27, payload=0
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
      if (!this.keyReady && pkt.command === -27) this._acceptKey(pkt.payload);
      else this.onPacket(pkt);
    }
  }

  _tryPlainPacket() {
    if (this.rx.length < 3) return null;
    const command = s8(this.rx[0]);
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
    const startR = this.curR;
    const dec = (raw) => this._readKeyByte(raw, "r");

    try {
      const command = s8(dec(this.rx[0]));
      // Commands that use 3 encrypted length bytes in the original client reader.
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
      if (this.rx.length < headerLen + len) { this.curR = startR; return null; }
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
    if (keyLen <= 0 || 1 + keyLen > payload.length) throw new Error(`Invalid key length ${keyLen}`);
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
    } catch (_) {}

    this.onLog(`Handshake OK; key=${keyLen} bytes`);
    this.onKey({ keyLength: keyLen, ip2, port2, connect2 });
  }

  frame(command, payload = new Uint8Array(0)) {
    if (!this.keyReady) throw new Error("Handshake key not ready");
    if (!(payload instanceof Uint8Array)) payload = new Uint8Array(payload);
    if (payload.length > 0xffff) throw new Error("Sender supports <=65535-byte payloads");
    const out = new Uint8Array(3 + payload.length);
    out[0] = this._readKeyByte(u8(command), "w");
    out[1] = this._readKeyByte((payload.length >> 8) & 0xff, "w");
    out[2] = this._readKeyByte(payload.length & 0xff, "w");
    for (let i = 0; i < payload.length; i++) out[3 + i] = this._readKeyByte(payload[i], "w");
    return out;
  }

  makeSetClientType({ width = 1024, height = 600, version = VT15.version } = {}) {
    const w = new ByteWriter();
    w.byte(2).byte(4).byte(1).bool(false).int(width).int(height).bool(true).bool(true).utf(`Pc platform xxx|${version}`);
    return this.frame(-29, w.finish());
  }

  makeLogin(username, password, { version = VT15.version, type = 0 } = {}) {
    const user = String(username || "").trim();
    const pass = String(password || "");
    if (!user) throw new Error("Thiếu tài khoản");
    if (!pass) throw new Error("Thiếu mật khẩu");
    const w = new ByteWriter();
    w.byte(0).utf(user).utf(pass).utf(version).byte(type);
    return this.frame(-29, w.finish());
  }

  // -28 = messageNotMap. Subcommand 13 is the original client's clientOk().
  makeClientOk() {
    return this.frame(-28, new Uint8Array([13]));
  }

  makeUpdateData() {
    return this.frame(-87);
  }

  makeUpdateMap() {
    return this.frame(-28, new Uint8Array([6]));
  }

  makeUpdateSkill() {
    return this.frame(-28, new Uint8Array([7]));
  }

  makeUpdateItem() {
    return this.frame(-28, new Uint8Array([8]));
  }

  makeFinishUpdate() {
    return this.frame(-38);
  }

  makeSelectCharacter(name) {
    const w = new ByteWriter();
    w.byte(1).utf(String(name)); // messageNotMap subcommand 1
    return this.frame(-28, w.finish());
  }

  parseServerVersions(payload) {
    const r = new ByteReader(payload);
    const sub = r.byte();
    if (sub !== 4) throw new Error(`Expected -28/4, got sub=${sub}`);
    return {
      data: r.byte(),
      map: r.byte(),
      skill: r.byte(),
      item: r.byte(),
      extra: r.byte(),
    };
  }

  parseLoginCharacters(payload) {
    const r = new ByteReader(payload);
    const count = r.byte();
    if (count > 20) throw new Error(`Unreasonable character count ${count}`);
    const characters = [];
    for (let i = 0; i < count; i++) {
      characters.push({
        playerId: r.int(),
        name: r.utf(),
        head: r.short(),
        body: r.short(),
        leg: r.short(),
        power: r.long(),
      });
    }
    return characters;
  }

  parseMapInfo(payload) {
    const r = new ByteReader(payload);
    const mapId = r.byte();
    const planetId = r.sbyte();
    const tileId = r.sbyte();
    const backgroundId = r.sbyte();
    const mapType = r.sbyte();
    const mapName = r.utf();
    const zoneId = r.sbyte();
    return { mapId, planetId, tileId, backgroundId, mapType, mapName, zoneId };
  }
}

export function hex(data, max = 96) {
  const a = data instanceof Uint8Array ? data : new Uint8Array(data);
  const shown = a.slice(0, max);
  const text = Array.from(shown, b => b.toString(16).padStart(2, "0")).join(" ");
  return a.length > max ? `${text} … (+${a.length - max})` : text;
}
