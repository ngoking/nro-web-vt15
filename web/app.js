import { NroProtocol, VT15, hex } from './protocol.js';

const $ = (q) => document.querySelector(q);
const logEl = $('#log');
const statusEl = $('#status');
const connectBtn = $('#connectBtn');
const loginBtn = $('#loginBtn');
const disconnectBtn = $('#disconnectBtn');
const userEl = $('#username');
const passEl = $('#password');

let ws = null;
let clientReady = false;
let setTypeSent = false;

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

const protocol = new NroProtocol({
  onLog: (s) => log(s, 'ok'),
  onKey: (info) => {
    clientReady = true;
    setStatus('Handshake OK — sẵn sàng đăng nhập', 'ok');
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
    if (command === 0) {
      setStatus('Server đã trả packet login (cmd 0)', 'ok');
    }
  },
});

function disconnect() {
  try { ws?.close(); } catch (_) {}
  ws = null;
  clientReady = false;
  setTypeSent = false;
  protocol.reset();
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
    log('Đã gửi packet login. Mật khẩu không được ghi vào log.');
    setStatus('Đã gửi đăng nhập — chờ server…', 'busy');
  } catch (err) {
    log(err.message, 'err');
  }
});

disconnectBtn.addEventListener('click', disconnect);
passEl.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !loginBtn.disabled) loginBtn.click();
});

setStatus('Chưa kết nối');
