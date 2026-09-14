'use strict';

/* ============================================================
   Wire-format helpers - mirrors the PC host's UProtocol.pas and
   the Android app's RemoteProtocol.kt byte-for-byte. No code is
   shared between the three clients, so if the protocol changes,
   update all three.

     Binary tag 1 (frame):      [1][monitorIndex u8][width u16 LE][height u16 LE][jpeg bytes]
     Binary tag 2 (file chunk): [2][idLen u8][id bytes][chunkIndex u32 LE][totalChunks u32 LE][chunk bytes]
   ============================================================ */
const TAG_FRAME = 1;
const TAG_FILECHUNK = 2;

function parseFrame(buf) {
  const dv = new DataView(buf);
  if (buf.byteLength < 6 || dv.getUint8(0) !== TAG_FRAME) return null;
  return {
    monitorIndex: dv.getUint8(1),
    width: dv.getUint16(2, true),
    height: dv.getUint16(4, true),
    jpeg: new Uint8Array(buf, 6),
  };
}

function buildFileChunk(id, chunkIndex, totalChunks, chunkBytes) {
  const idBytes = new TextEncoder().encode(id).slice(0, 255);
  const header = new Uint8Array(2 + idBytes.length + 8);
  header[0] = TAG_FILECHUNK;
  header[1] = idBytes.length;
  header.set(idBytes, 2);
  const dv = new DataView(header.buffer);
  dv.setUint32(2 + idBytes.length, chunkIndex, true);
  dv.setUint32(2 + idBytes.length + 4, totalChunks, true);
  const out = new Uint8Array(header.length + chunkBytes.length);
  out.set(header, 0);
  out.set(chunkBytes, header.length);
  return out;
}

function parseFileChunk(buf) {
  const dv = new DataView(buf);
  if (buf.byteLength < 2 || dv.getUint8(0) !== TAG_FILECHUNK) return null;
  const idLen = dv.getUint8(1);
  if (buf.byteLength < 2 + idLen + 8) return null;
  const id = new TextDecoder().decode(new Uint8Array(buf, 2, idLen));
  return {
    id,
    chunkIndex: dv.getUint32(2 + idLen, true),
    totalChunks: dv.getUint32(2 + idLen + 4, true),
    chunk: new Uint8Array(buf, 2 + idLen + 8),
  };
}

function jsonMsg(type, extra) {
  return JSON.stringify(Object.assign({ type }, extra || {}));
}

/* ============================================================
   State
   ============================================================ */
const LS_RELAY = 'dsr_remote_relay_host';
const LS_TOKEN = 'dsr_remote_token';
const DEFAULT_RELAY_HOST = 'dsr-remote-relay.100dsr100.workers.dev';
const FILE_CHUNK_SIZE = 49152;

let ws = null;
let wantConnected = false;
let reconnectTimer = null;
let monitors = [];
let selectedMonitor = -1;
let lastFrameUrl = null;

let activePointers = new Map(); // pointerId -> {x, y} in CLIENT coords
let leftDown = false;
let scrollMode = false;
let lastScrollY = 0;
let twoFingerMoved = false;

let incoming = null; // {id, name, size, received, parts: []}
let outgoingBusy = false;

const $ = (id) => document.getElementById(id);

/* ============================================================
   Pairing screen
   ============================================================ */
$('editRelayHost').value = localStorage.getItem(LS_RELAY) || DEFAULT_RELAY_HOST;
$('editToken').value = localStorage.getItem(LS_TOKEN) || '';

$('btnConnect').addEventListener('click', () => {
  const host = $('editRelayHost').value.trim();
  const token = $('editToken').value.trim();
  if (!token) {
    $('pairStatus').textContent = 'Enter a pairing token first.';
    return;
  }
  localStorage.setItem(LS_RELAY, host);
  localStorage.setItem(LS_TOKEN, token);
  $('pairScreen').style.display = 'none';
  $('remoteScreen').style.display = 'flex';
  wantConnected = true;
  connect();
});

/* ============================================================
   Connection
   ============================================================ */
function connect() {
  if (ws) return;
  const host = localStorage.getItem(LS_RELAY) || DEFAULT_RELAY_HOST;
  const token = localStorage.getItem(LS_TOKEN);
  $('lblStatus').textContent = 'Connecting…';
  ws = new WebSocket(`wss://${host}/ws/${encodeURIComponent(token)}`);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    $('lblStatus').textContent = 'Connected — waiting for PC';
    ws.send(jsonMsg('hello', { role: 'controller' }));
  };
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') handleText(e.data);
    else handleBinary(e.data);
  };
  ws.onclose = () => {
    ws = null;
    $('lblStatus').textContent = 'Disconnected';
  };
  ws.onerror = () => {
    // onclose always follows onerror for a WebSocket, so no extra handling needed here.
  };
}

function disconnect() {
  wantConnected = false;
  if (ws) { try { ws.close(); } catch (e) {} ws = null; }
}

if (!reconnectTimer) {
  reconnectTimer = setInterval(() => {
    if (wantConnected && !ws) connect();
  }, 4000);
}

function send(text) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(text); }
function sendBinary(bytes) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(bytes); }

/* ============================================================
   Incoming messages
   ============================================================ */
function handleText(text) {
  let obj;
  try { obj = JSON.parse(text); } catch (e) { return; }
  switch (obj.type) {
    case 'monitors':
      monitors = obj.list || [];
      if (selectedMonitor < 0 && monitors.length) {
        const primary = monitors.find(m => m.primary) || monitors[0];
        selectMonitor(primary.index);
      }
      $('lblStatus').textContent = 'Streaming';
      break;
    case 'clipboard':
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(obj.text || '').catch(() => {});
      }
      break;
    case 'file_start':
      startIncomingFile(obj);
      break;
  }
}

function handleBinary(buf) {
  const tag = new DataView(buf).getUint8(0);
  if (tag === TAG_FRAME) {
    const f = parseFrame(buf);
    if (!f) return;
    const blob = new Blob([f.jpeg], { type: 'image/jpeg' });
    const url = URL.createObjectURL(blob);
    const prev = lastFrameUrl;
    $('imgScreen').src = url;
    $('imgScreen').style.display = 'block';
    lastFrameUrl = url;
    if (prev) URL.revokeObjectURL(prev);
    $('lblWaiting').style.display = 'none';
  } else if (tag === TAG_FILECHUNK) {
    receiveFileChunk(buf);
  }
}

function selectMonitor(index) {
  selectedMonitor = index;
  send(jsonMsg('select_monitor', { index }));
}

/* ============================================================
   Mouse / touch -> input, via Pointer Events (unifies mouse+touch)
   ============================================================ */
const imgScreen = $('imgScreen');
imgScreen.addEventListener('contextmenu', (e) => e.preventDefault());

function fractionFromEvent(e) {
  const w = imgScreen.clientWidth, h = imgScreen.clientHeight;
  if (!w || !h) return null;
  const rect = imgScreen.getBoundingClientRect();
  const fx = (e.clientX - rect.left) / w;
  const fy = (e.clientY - rect.top) / h;
  return [Math.min(1, Math.max(0, fx)), Math.min(1, Math.max(0, fy))];
}

function avgY() {
  let sum = 0;
  for (const p of activePointers.values()) sum += p.y;
  return sum / activePointers.size;
}

imgScreen.addEventListener('pointerdown', (e) => {
  imgScreen.setPointerCapture(e.pointerId);
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (activePointers.size === 1) {
    scrollMode = false;
    twoFingerMoved = false;
    const f = fractionFromEvent(e);
    if (f) send(jsonMsg('input', { kind: 'move', fx: f[0], fy: f[1] }));
    send(jsonMsg('input', { kind: 'down', button: 'left' }));
    leftDown = true;
  } else if (activePointers.size === 2) {
    if (leftDown) { send(jsonMsg('input', { kind: 'up', button: 'left' })); leftDown = false; }
    scrollMode = true;
    twoFingerMoved = false;
    lastScrollY = avgY();
  }
});

imgScreen.addEventListener('pointermove', (e) => {
  if (!activePointers.has(e.pointerId)) return;
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (scrollMode && activePointers.size >= 2) {
    const y = avgY();
    const dy = y - lastScrollY;
    if (Math.abs(dy) > 8) {
      send(jsonMsg('input', { kind: 'wheel', delta: dy > 0 ? -60 : 60 }));
      lastScrollY = y;
      twoFingerMoved = true;
    }
  } else if (!scrollMode) {
    const f = fractionFromEvent(e);
    if (f) send(jsonMsg('input', { kind: 'move', fx: f[0], fy: f[1] }));
  }
});

function pointerEnd(e) {
  const wasTwo = activePointers.size === 2;
  activePointers.delete(e.pointerId);
  if (scrollMode && wasTwo && !twoFingerMoved) {
    send(jsonMsg('input', { kind: 'down', button: 'right' }));
    send(jsonMsg('input', { kind: 'up', button: 'right' }));
  }
  if (activePointers.size === 0) {
    if (leftDown) { send(jsonMsg('input', { kind: 'up', button: 'left' })); leftDown = false; }
    scrollMode = false;
  }
}
imgScreen.addEventListener('pointerup', pointerEnd);
imgScreen.addEventListener('pointercancel', pointerEnd);

/* ============================================================
   Toolbar
   ============================================================ */
$('btnDisconnect').addEventListener('click', () => {
  disconnect();
  $('remoteScreen').style.display = 'none';
  $('pairScreen').style.display = 'flex';
});

$('btnRightClick').addEventListener('click', () => {
  send(jsonMsg('input', { kind: 'down', button: 'right' }));
  send(jsonMsg('input', { kind: 'up', button: 'right' }));
});

$('btnClipboard').addEventListener('click', async () => {
  if (!navigator.clipboard || !navigator.clipboard.readText) {
    alert('This browser will not allow reading the clipboard here (needs HTTPS + a supporting browser).');
    return;
  }
  try {
    const text = await navigator.clipboard.readText();
    send(jsonMsg('clipboard', { text }));
  } catch (e) {
    alert('Clipboard permission was not granted.');
  }
});

/* ---- Monitor picker ---- */
$('btnMonitor').addEventListener('click', () => {
  const list = $('monitorList');
  list.innerHTML = '';
  if (!monitors.length) {
    list.innerHTML = '<div class="opt">No monitors reported yet</div>';
  } else {
    for (const m of monitors) {
      const b = document.createElement('button');
      b.className = 'opt';
      b.textContent = `Monitor ${m.index} (${m.w}x${m.h})${m.primary ? ' *' : ''}`;
      b.onclick = () => { selectMonitor(m.index); monitorDialog.close(); };
      list.appendChild(b);
    }
  }
  monitorDialog.showModal();
});

/* ---- Quality picker - same 4 presets as the PC host and Android app ---- */
const QUALITY_PRESETS = [
  { fps: 20, jpeg_q: 75, scale: 100, greyscale: false }, // High speed
  { fps: 8, jpeg_q: 60, scale: 100, greyscale: false },  // Balanced
  { fps: 6, jpeg_q: 35, scale: 60, greyscale: false },   // Data saver
  { fps: 4, jpeg_q: 30, scale: 50, greyscale: true },    // Minimal B&W
];
$('btnQuality').addEventListener('click', () => qualityDialog.showModal());
document.querySelectorAll('#qualityList .opt').forEach((btn) => {
  btn.addEventListener('click', () => {
    const p = QUALITY_PRESETS[Number(btn.dataset.preset)];
    send(jsonMsg('quality', p));
    qualityDialog.close();
  });
});

/* ---- Keyboard ---- */
const hiddenInput = $('hiddenInput');
const keyRow = $('keyRow');
let keyboardActive = false;

$('btnKeyboard').addEventListener('click', () => {
  keyboardActive = !keyboardActive;
  keyRow.style.display = keyboardActive ? 'block' : 'none';
  if (keyboardActive) { hiddenInput.value = ''; hiddenInput.focus(); }
  else hiddenInput.blur();
});

hiddenInput.addEventListener('input', () => {
  const text = hiddenInput.value;
  if (text) send(jsonMsg('input', { kind: 'text', text }));
  hiddenInput.value = '';
});

hiddenInput.addEventListener('keydown', (e) => {
  const map = { Backspace: 'BACKSPACE', Enter: 'ENTER', Tab: 'TAB', Escape: 'ESC',
    ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT',
    Delete: 'DELETE', Home: 'HOME', End: 'END', PageUp: 'PAGEUP', PageDown: 'PAGEDOWN' };
  if (map[e.key]) {
    e.preventDefault();
    send(jsonMsg('input', { kind: 'combo', key: map[e.key], mods: '' }));
  }
});

const KEY_ROW_BUTTONS = [
  ['Esc', 'ESC', ''], ['Tab', 'TAB', ''], ['←', 'LEFT', ''], ['↑', 'UP', ''],
  ['↓', 'DOWN', ''], ['→', 'RIGHT', ''], ['Home', 'HOME', ''], ['End', 'END', ''],
  ['Del', 'DELETE', ''], ['PgUp', 'PAGEUP', ''], ['PgDn', 'PAGEDOWN', ''],
  ['Ctrl+C', 'c', 'ctrl'], ['Ctrl+V', 'v', 'ctrl'], ['Ctrl+A', 'a', 'ctrl'], ['Ctrl+Z', 'z', 'ctrl'],
  ['Alt+Tab', 'TAB', 'alt'], ['Win', 'WIN', ''],
];
for (const [label, key, mods] of KEY_ROW_BUTTONS) {
  const b = document.createElement('button');
  b.textContent = label;
  b.onclick = () => { send(jsonMsg('input', { kind: 'combo', key, mods })); hiddenInput.focus(); };
  keyRow.appendChild(b);
}

/* ============================================================
   File transfer
   ============================================================ */
$('btnSendFile').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', async () => {
  const file = $('fileInput').files[0];
  $('fileInput').value = '';
  if (!file || outgoingBusy) return;
  outgoingBusy = true;
  const id = 'f' + Date.now();
  const totalChunks = Math.max(1, Math.ceil(file.size / FILE_CHUNK_SIZE));
  send(jsonMsg('file_start', { id, name: file.name, size: file.size }));
  const buf = new Uint8Array(await file.arrayBuffer());
  let offset = 0, index = 0;
  const sendNext = () => {
    const end = Math.min(offset + FILE_CHUNK_SIZE, buf.length);
    sendBinary(buildFileChunk(id, index, totalChunks, buf.subarray(offset, end)));
    offset = end;
    index++;
    if (offset < buf.length) {
      setTimeout(sendNext, 10);
    } else {
      outgoingBusy = false;
      $('lblStatus').textContent = `Sent ${file.name}`;
    }
  };
  sendNext();
});

function startIncomingFile(obj) {
  incoming = { id: obj.id, name: (obj.name || 'received.bin').replace(/[\\/]/g, '_'), size: obj.size || 0, received: 0, parts: [] };
}

function receiveFileChunk(buf) {
  const c = parseFileChunk(buf);
  if (!c || !incoming || c.id !== incoming.id) return;
  incoming.parts.push(c.chunk);
  incoming.received += c.chunk.length;
  if (c.chunkIndex + 1 >= c.totalChunks) {
    const blob = new Blob(incoming.parts);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = incoming.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    $('lblStatus').textContent = `Received ${incoming.name}`;
    incoming = null;
  }
}
