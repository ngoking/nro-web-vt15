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

let ws = null;
let clientReady = false;
let setTypeSent = false;
let clientOkSent = false;
let loginSent = false;

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

    // Server version announcement: -28 / subcommand 4.
    // The original client compares local data versions here and, once ready,
    // answers with clientOk (-28 / subcommand 13). Our prototype has no RMS
    // renderer cache yet, so for protocol/login testing we acknowledge readiness.
    if (command === -28 && payload[0] === 4) {
      try {
        const v = protocol.parseServerVersions(payload);
        log(`Server versions: data=${v.data}, map=${v.map}, skill=${v.skill}, item=${v.item}.`, 'ok');
        if (!clientOkSent && ws?.readyState === WebSocket.OPEN) {
          ws.send(protocol.makeClientOk());
          clientOkSent = true;
          log('Đã gửi clientOk (-28/13). Client protocol đã qua bước version gate.', 'ok');
          setStatus(loginSent ? 'Đã xác nhận dữ liệu — chờ phản hồi đăng nhập' : 'Sẵn sàng đăng nhập VT15', 'ok');
        }
      } catch (err) {
        log(`Không đọc được version packet: ${err.message}`, 'err');
      }
      return;
    }

    // Login success in the reference client: cmd 0 = character list.
    if (command === 0) {
      try {
        const chars = protocol.parseLoginCharacters(payload);
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
  protocol.reset();
  clearCharacters();
  loginBtn.disabled = true;
  disconnectBtn.disabled = true;
  connectBtn.disabled = false;
  setStatus('Chưa kết nối');
}

connectBtn.addEventListener('click', () => {
  disconnect();
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${scheme}://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';
  connectBtn.disabled = true;
  disconnectBtn.disabled = false;
  setStatus(`Đang nối ${VT15.host}:${VT15.port}…`, 'busy');
  log(`Mở gateway tới ${VT15.name}: ${VT15.host}:${VT15.port}`);

  ws.addEventListener('open', () => {
    setStatus('TCP đã mở — đang handshake…', 'busy');
    log('WebSocket gateway OK; gửi handshake -27.');
    ws.send(protocol.handshakeRequest());
  });

  ws.addEventListener('message', (ev) => {
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

  ws.addEventListener('close', (ev) => {
    log(`Kết nối đóng: code=${ev.code}${ev.reason ? ` ${ev.reason}` : ''}`);
    if (ws) disconnect();
  });

  ws.addEventListener('error', () => {
    log('WebSocket/gateway error.', 'err');
    setStatus('Không kết nối được gateway/server', 'err');
  });
});

loginBtn.addEventListener('click', () => {
  if (!clientReady || !ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    const frame = protocol.makeLogin(userEl.value, passEl.value, { version: VT15.version, type: 0 });
    ws.send(frame);
    loginSent = true;
    clearCharacters();
    log('Đã gửi packet login. Mật khẩu không được ghi vào log.');
    setStatus(clientOkSent ? 'Đã gửi đăng nhập — chờ cmd=0…' : 'Đã gửi đăng nhập — đang chờ version/clientOk…', 'busy');
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
