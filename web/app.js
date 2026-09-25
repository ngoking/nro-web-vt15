import { NroProtocol, VT15, hex } from './protocol.js';

const $ = (q) => document.querySelector(q);
const logEl = $('#log');
const statusEl = $('#status');
const connectBtn = $('#connectBtn');
const loginBtn = $('#loginBtn');
const disconnectBtn = $('#disconnectBtn');
const userEl = $('#username');
const passEl = $('#password');
const charsEl = $('#characters');
const mapInfoEl = $('#mapInfo');

let ws = null;
let clientReady = false;
let setTypeSent = false;
let clientOkSent = false;
let loginSent = false;
let sync = null;
let loginTimer = null;

function log(line, kind = '') {
  const div = document.createElement('div');
  div.className = kind;
  div.textContent = `[${new Date().toLocaleTimeString()}] ${line}`;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(text, state = 'idle') {
  statusEl.textContent = text;
  statusEl.dataset.state = state;
}

function clearCharacters() {
  charsEl.innerHTML = '';
  charsEl.hidden = true;
}

function clearMapInfo() {
  mapInfoEl.replaceChildren();
  mapInfoEl.hidden = true;
}

function showMapInfo(info) {
  mapInfoEl.replaceChildren();
  const title = document.createElement('h2');
  title.textContent = 'Đã nhận thông tin map từ server';
  const detail = document.createElement('p');
  detail.textContent = `${info.mapName} · map ${info.mapId} · khu ${info.zoneId}`;
  const note = document.createElement('p');
  note.textContent = 'Nhân vật đã vào map. Bản web vẫn chưa vẽ và điều khiển game.';
  mapInfoEl.append(title, detail, note);
  mapInfoEl.hidden = false;
}

function updateSync(command, payload) {
  if (!sync || clientOkSent) return;
  let part = null;
  let version = null;
  if (command === -87 && payload.length) {
    part = 'data';
    version = payload[0];
  } else if (command === -28 && payload.length > 1) {
    const sub = payload[0];
    if (sub === 6) part = 'map';
    if (sub === 7) part = 'skill';
    if (sub === 8 && payload.length > 2 && payload[2] === 2) part = 'item';
    version = payload[1];
  }
  if (!part || sync.received.has(part)) return;
  if (version !== sync.versions[part]) {
    log(`Bỏ qua dữ liệu ${part}: phiên bản ${version}, cần ${sync.versions[part]}.`, 'err');
    return;
  }
  sync.received.add(part);
  log(`Đã nhận ${part} (${sync.received.size}/4).`, 'ok');
  setStatus(`Đang đồng bộ dữ liệu ${sync.received.size}/4…`, 'busy');
  if (sync.received.size === 4 && ws?.readyState === WebSocket.OPEN) {
    ws.send(protocol.makeClientOk());
    ws.send(protocol.makeFinishUpdate());
    clientOkSent = true;
    log('Đã tải đủ 4 nhóm dữ liệu; gửi clientOk và finishUpdate.', 'ok');
    setStatus(loginSent ? 'Đã đồng bộ — chờ danh sách nhân vật' : 'Đã đồng bộ — bấm Đăng nhập', 'ok');
  }
}

function showCharacters(characters) {
  clearCharacters();
  charsEl.hidden = false;
  const title = document.createElement('p');
  title.innerHTML = `<strong>Đăng nhập thành công — ${characters.length} nhân vật</strong>`;
  charsEl.appendChild(title);

  if (!characters.length) {
    const p = document.createElement('p');
    p.textContent = 'Tài khoản chưa có nhân vật.';
    charsEl.appendChild(p);
    return;
  }

  const wrap = document.createElement('div');
  wrap.className = 'char-grid';
  for (const ch of characters) {
    const card = document.createElement('div');
    card.className = 'char-card';
    const info = document.createElement('div');
    const power = typeof ch.power === 'bigint' ? ch.power.toString() : String(ch.power);
    info.innerHTML = `<strong>${escapeHtml(ch.name)}</strong><br><span>ID ${ch.playerId} · Sức mạnh ${power}</span>`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Vào nhân vật';
    btn.addEventListener('click', () => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(protocol.makeSelectCharacter(ch.name));
      setStatus(`Đã chọn ${ch.name} — đang nhận dữ liệu game…`, 'busy');
      log(`Đã gửi chọn nhân vật: ${ch.name}`);
    });
    card.append(info, btn);
    wrap.appendChild(card);
  }
  charsEl.appendChild(wrap);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}

const protocol = new NroProtocol({
  onLog: (s) => log(s, 'ok'),
  onKey: (info) => {
    clientReady = true;
    setStatus('Handshake OK — đang khởi tạo client', 'ok');
    loginBtn.disabled = false;
    log(`Secondary: ${info.ip2 || '-'}:${info.port2 || '-'} connect2=${info.connect2 ?? '-'}`);

    if (!setTypeSent && ws?.readyState === WebSocket.OPEN) {
      ws.send(protocol.makeSetClientType({ version: VT15.version }));
      setTypeSent = true;
      log('Đã gửi setClientType (PC / 1024×600 / v2.4.6).');
    }
  },
  onPacket: ({ command, payload }) => {
    log(`RX cmd=${command} len=${payload.length} | ${hex(payload)}`);

    // Request fresh data/map/skill/item before acknowledging client readiness.
    if (command === -28 && payload[0] === 4) {
      try {
        const v = protocol.parseServerVersions(payload);
        log(`Phiên bản dữ liệu: data=${v.data}, map=${v.map}, skill=${v.skill}, item=${v.item}. Đây không phải ID map.`, 'ok');
        if (!sync && ws?.readyState === WebSocket.OPEN) {
          sync = { versions: v, received: new Set() };
          ws.send(protocol.makeUpdateData());
          ws.send(protocol.makeUpdateMap());
          ws.send(protocol.makeUpdateSkill());
          ws.send(protocol.makeUpdateItem());
          log('Đã yêu cầu tải data/map/skill/item từ server.', 'ok');
          setStatus('Đang đồng bộ dữ liệu 0/4…', 'busy');
        }
      } catch (err) {
        log(`Không đọc được version packet: ${err.message}`, 'err');
      }
      return;
    }

    updateSync(command, payload);

    if (command === -24) {
      try {
        const info = protocol.parseMapInfo(payload);
        showMapInfo(info);
        setStatus(`Đã vào ${info.mapName} · map ${info.mapId} · khu ${info.zoneId}`, 'ok');
        log(`MAP INFO: ${info.mapName}, map=${info.mapId}, khu=${info.zoneId}.`, 'ok');
      } catch (err) {
        log(`Có MAP_INFO nhưng parse lỗi: ${err.message}`, 'err');
      }
    }

    // Login success: cmd 0 contains the character list.
    if (command === 0) {
      try {
        const chars = protocol.parseLoginCharacters(payload);
        clearTimeout(loginTimer);
        loginTimer = null;
        setStatus(`Đăng nhập thành công — ${chars.length} nhân vật`, 'ok');
        log(`LOGIN OK: nhận cmd=0 với ${chars.length} nhân vật.`, 'ok');
        showCharacters(chars);
      } catch (err) {
        setStatus('Có cmd=0 nhưng parse danh sách nhân vật lỗi', 'err');
        log(`Parse login cmd=0 lỗi: ${err.message}`, 'err');
      }
    }
  },
});

function disconnect() {
  const old = ws;
  ws = null;
  try { old?.close(); } catch (_) {}
  clientReady = false;
  setTypeSent = false;
  clientOkSent = false;
  loginSent = false;
  sync = null;
  clearTimeout(loginTimer);
  loginTimer = null;
  protocol.reset();
  clearCharacters();
  clearMapInfo();
  loginBtn.disabled = true;
  disconnectBtn.disabled = true;
  connectBtn.disabled = false;
  setStatus('Chưa kết nối');
}

connectBtn.addEventListener('click', () => {
  disconnect();
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${scheme}://${location.host}/ws`);
  ws = socket;
  socket.binaryType = 'arraybuffer';
  connectBtn.disabled = true;
  disconnectBtn.disabled = false;
  setStatus(`Đang nối ${VT15.host}:${VT15.port}…`, 'busy');
  log(`Mở gateway tới ${VT15.name}: ${VT15.host}:${VT15.port}`);

  socket.addEventListener('open', () => {
    if (ws !== socket) return;
    setStatus('TCP đã mở — đang handshake…', 'busy');
    log('WebSocket gateway OK; gửi handshake -27.');
    socket.send(protocol.handshakeRequest());
  });

  socket.addEventListener('message', (ev) => {
    if (ws !== socket) return;
    if (typeof ev.data === 'string') {
      log(ev.data, 'err');
      return;
    }
    try {
      protocol.feed(new Uint8Array(ev.data));
    } catch (err) {
      log(`Protocol error: ${err.message}`, 'err');
      setStatus('Lỗi protocol — xem log', 'err');
    }
  });

  socket.addEventListener('close', (ev) => {
    if (ws !== socket) return;
    log(`Kết nối đóng: code=${ev.code}${ev.reason ? ` ${ev.reason}` : ''}`);
    disconnect();
  });

  socket.addEventListener('error', () => {
    if (ws !== socket) return;
    log('WebSocket/gateway error.', 'err');
    setStatus('Không kết nối được gateway/server', 'err');
  });
});

loginBtn.addEventListener('click', () => {
  if (!clientReady || !ws || ws.readyState !== WebSocket.OPEN || loginSent) return;
  try {
    const frame = protocol.makeLogin(userEl.value, passEl.value, { version: VT15.version, type: 0 });
    ws.send(frame);
    loginSent = true;
    loginBtn.disabled = true;
    clearCharacters();
    log('Đã gửi packet login. Mật khẩu không được ghi vào log.');
    setStatus(clientOkSent ? 'Đã gửi đăng nhập — chờ danh sách nhân vật…' : 'Đã gửi đăng nhập — đang đồng bộ dữ liệu…', 'busy');
    loginTimer = setTimeout(() => {
      if (!loginSent || !ws || ws.readyState !== WebSocket.OPEN) return;
      setStatus('Chưa có danh sách nhân vật sau 30 giây — xem log', 'err');
      log('Hết 30 giây chưa nhận cmd=0; chưa thể xác nhận đăng nhập thành công.', 'err');
    }, 30000);
  } catch (err) {
    log(err.message, 'err');
  }
});

disconnectBtn.addEventListener('click', disconnect);
passEl.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !loginBtn.disabled) loginBtn.click();
});

setStatus('Chưa kết nối');
clearCharacters();
clearMapInfo();
