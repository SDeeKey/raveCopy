/* global Peer */
'use strict';

const $ = (id) => document.getElementById(id);
const video = $('video');
const DEMO = 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4';
const EPISODES = [12, 12, 12, 12, 12, 12, 12, 12, 14, 12, 12];
const EMBED_BASE = 'https://looking-as.allarknow.online/?token_movie=6f585d090288ce71097942167f7b08&token=5af6e7af5ffb19f2ddb300d28d90f8';
const EMBED_ORIGIN = new URL(EMBED_BASE).origin;
const embed = $('embed');
let embedded = { time: 0, paused: true, updated: Date.now(), duration: 0, ready: false };
let lastEmbedSeek = 0;
let lastEmbedCommand = 0;
const invitation = new URLSearchParams(location.hash.slice(1));
const roomId = invitation.get('room');
const roomKey = invitation.get('key');
const directOffer = invitation.get('offer');
const shortRoom = invitation.get('r');
const onlineEnabled = location.hostname.endsWith('.netlify.app') || location.hostname === '127.0.0.1';
let onlineRoom = '';
let onlineHostKey = '';
let onlineCreating = false;
let onlinePollTimer;
let relayJoin = '';
let relayCursor = 0;
let relayRunning = false;
let relayBusy = false;
let relayOffset = 0;
let relayPendingState = null;
const pendingDirect = new Map();
const directPeers = new Set();
let directMode = Boolean(directOffer || shortRoom);
let reconnectAttempts = 0;
const connections = new Map();
let peer;
let peerOpening = false;
let pendingCreate = false;
let peerStartTimer;
let hostConnection;
let isHost = false;
let secret = '';
let source = null;
let activeSource = '';
let blobUrl = '';
let latest = null;
let sequence = 0;
let clockOffset = 0;
let soundEnabled = false;
let playPending = false;
let connectTimer;
let feedbackTimer;
let lastChat = 0;
let pingTimer;

function feedback(message) {
  $('feedback').textContent = message;
  $('feedback').hidden = false;
  clearTimeout(feedbackTimer);
  feedbackTimer = setTimeout(() => { $('feedback').hidden = true; }, 7000);
}

function addMessage(name, text, system = false) {
  if (system) return;
  const element = document.createElement('div');
  element.className = system ? 'system' : 'bubble';
  if (!system) {
    const author = document.createElement('strong');
    author.textContent = name;
    element.append(author);
  }
  element.append(document.createTextNode(text));
  $('messages').append(element);
  while ($('messages').children.length > 100) $('messages').firstElementChild.remove();
  $('messages').scrollTop = $('messages').scrollHeight;
}

function send(connection, data) {
  if (!connection?.open) return;
  try { connection.send(data); } catch { feedback('Не удалось передать данные. Проверьте соединение.'); }
}

function broadcast(data) {
  if (onlineRoom && data.type === 'chat') { sendRelayChat(data); return; }
  for (const connection of connections.values()) send(connection, data);
}

function updatePeople(count = connections.size + 1) { $('people').textContent = `В комнате: ${count}`; }

function state() {
  if (source?.kind === 'shameless') {
    const elapsed = embedded.paused ? 0 : Math.min(10, (Date.now() - embedded.updated) / 1000);
    return { type: 'state', seq: ++sequence, source, time: embedded.time + elapsed, paused: embedded.paused, rate: 1, sent: Date.now() };
  }
  return { type: 'state', seq: ++sequence, source, time: Number.isFinite(video.currentTime) ? video.currentTime : 0,
    paused: video.paused, rate: video.playbackRate, sent: Date.now() };
}

function publishState() {
  if (!isHost) return;
  if (onlineRoom) { relayPendingState = state(); scheduleRelay(100); }
  else broadcast(state());
}

function validUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; }
  catch { return false; }
}

function validSource(value) {
  if (value === null) return true;
  return value && typeof value.id === 'string' && value.id.length < 100 &&
    typeof value.title === 'string' && value.title.length <= 250 &&
    ((value.kind === 'shameless' && Number.isInteger(value.season) && value.season >= 1 && value.season <= 11 &&
      Number.isInteger(value.episode) && value.episode >= 1 && value.episode <= EPISODES[value.season - 1]) ||
     (value.kind === 'url' && typeof value.url === 'string' && value.url.length < 8000 && validUrl(value.url)) ||
     (value.kind === 'file' && typeof value.name === 'string' && value.name.length <= 250 &&
       Number.isSafeInteger(value.size) && value.size > 0));
}

function loadVideo(url, descriptor) {
  embed.hidden = true;
  embed.removeAttribute('src');
  $('embed-controls').hidden = true;
  video.hidden = false;
  $('sound').hidden = isHost || soundEnabled;
  video.pause();
  if (blobUrl && blobUrl !== url) URL.revokeObjectURL(blobUrl);
  blobUrl = url.startsWith('blob:') ? url : '';
  activeSource = descriptor.id;
  video.src = url;
  video.load();
  $('empty').hidden = true;
  $('video-title').textContent = descriptor.title;
}

function setSource(descriptor, url) {
  if (!isHost) return;
  source = descriptor;
  if (descriptor.kind === 'shameless') loadSeries(descriptor);
  else loadVideo(url, descriptor);
  $('sync').textContent = 'Ведущий управляет плеером';
  publishState();
  setMobileSettings(false);
}

function requestPlay() {
  if (playPending || !video.paused) return;
  playPending = true;
  video.play().catch(() => {
    $('sound').hidden = false;
    $('sync').textContent = 'Нажмите «Включить просмотр и звук»';
  }).finally(() => { playPending = false; });
}

function applyPlayback(force = false) {
  if (source?.kind === 'shameless') { applyEmbed(force); return; }
  if (!latest?.source || activeSource !== latest.source.id || video.readyState < 1) return;
  const elapsed = latest.paused ? 0 : Math.max(0, Math.min(10, (Date.now() + clockOffset - latest.sent) / 1000));
  const expected = Math.min(Number.isFinite(video.duration) ? video.duration : Infinity, latest.time + elapsed * latest.rate);
  if (force || Math.abs(video.currentTime - expected) > (latest.paused ? 0.12 : 0.7)) video.currentTime = expected;
  video.playbackRate = latest.rate;
  if (latest.paused) video.pause(); else requestPlay();
  $('sync').textContent = latest.paused ? 'Общая пауза' : 'Синхронизировано с ведущим';
}

function receiveState(data) {
  if (!Number.isSafeInteger(data.seq) || data.seq <= (latest?.seq ?? -1) || !validSource(data.source) ||
      !Number.isFinite(data.time) || data.time < 0 || !Number.isFinite(data.rate) || data.rate < 0.25 || data.rate > 4 ||
      typeof data.paused !== 'boolean' || !Number.isFinite(data.sent)) return;
  const changed = data.source?.id !== latest?.source?.id;
  latest = data;
  if (!data.source) return;
  if (changed) {
    source = data.source;
    $('video-title').textContent = source.title;
    if (source.kind === 'shameless') {
      $('file').disabled = true;
      loadSeries(source);
    } else if (source.kind === 'url') {
      $('file').disabled = true;
      loadVideo(source.url, source);
    } else {
      embed.hidden = true;
      embed.removeAttribute('src');
      video.hidden = false;
      $('embed-controls').hidden = true;
      video.pause();
      video.removeAttribute('src');
      video.load();
      activeSource = '';
      if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = ''; }
      $('empty').hidden = false;
      $('empty').querySelector('h3').textContent = 'Откройте файл ведущего';
      $('empty').querySelector('p').textContent = source.name;
      $('file').disabled = false;
      $('sync').textContent = 'Выберите тот же файл на своём устройстве';
    }
  }
  applyPlayback(changed);
}

function chatMessage(data) {
  return data && data.type === 'chat' && typeof data.name === 'string' && typeof data.text === 'string' &&
    data.name.length > 0 && data.name.length <= 30 && data.text.trim().length > 0 && data.text.length <= 500;
}

function acceptGuest(connection) {
  if (!isHost || connection.metadata?.key !== secret || connections.size >= 7 || connections.has(connection.peer)) {
    connection.on('open', () => connection.close());
    return;
  }
  let admitted = false;
  let lastMessage = 0;
  connection.on('open', () => {
    // Check again because several channels may open at once.
    if (connections.size >= 7 || connections.has(connection.peer)) { connection.close(); return; }
    admitted = true;
    connections.set(connection.peer, connection);
    broadcast({ type: 'people', count: connections.size + 1 });
    updatePeople();
    send(connection, state());
    addMessage('', 'Зритель присоединился', true);
  });
  connection.on('data', (data) => {
    if (!admitted || !data || typeof data !== 'object') return;
    if (data.type === 'ping' && Number.isFinite(data.sent)) send(connection, { type: 'pong', echo: data.sent, host: Date.now() });
    if (chatMessage(data) && Date.now() - lastMessage >= 400) {
      lastMessage = Date.now();
      addMessage(data.name, data.text);
      broadcast({ type: 'chat', name: data.name, text: data.text });
    }
  });
  connection.on('close', () => {
    if (!admitted || connections.get(connection.peer) !== connection) return;
    connections.delete(connection.peer);
    updatePeople();
    broadcast({ type: 'people', count: connections.size + 1 });
    addMessage('', 'Зритель вышел из комнаты', true);
  });
  connection.on('error', () => connection.close());
}

function guestDisconnected() {
  clearTimeout(connectTimer);
  clearInterval(pingTimer);
  video.pause();
  latest = null;
  $('connection').textContent = 'Связь с ведущим потеряна';
  $('sync').textContent = 'Ожидаем подключения';
  $('send').disabled = true;
  $('create').hidden = false;
  $('create').disabled = shortRoom ? false : !peer?.open;
  $('create').textContent = 'Подключиться снова';
  updatePeople(1);
}

function joinRoom() {
  if (!peer?.open || !roomId || !roomKey) return;
  hostConnection?.close();
  clearTimeout(connectTimer);
  clearInterval(pingTimer);
  latest = null;
  $('create').disabled = true;
  $('connection').textContent = 'Ищем ведущего…';
  const connection = peer.connect(roomId, { reliable: true, serialization: 'json', metadata: { key: roomKey } });
  attachGuest(connection);
}

function attachGuest(connection, timeout = 15000) {
  hostConnection = connection;
  connection.on('open', () => {
    if (connection !== hostConnection) return;
    clearTimeout(connectTimer);
    $('connection').textContent = 'Вы в комнате';
    $('role').textContent = 'ВЫ — ЗРИТЕЛЬ';
    $('room-title').textContent = 'Вечер в хорошей компании';
    $('room-hint').textContent = 'Ведущий выбирает видео и управляет просмотром.';
    $('create').hidden = true;
    $('invite').hidden = directMode;
    $('send').disabled = false;
    video.controls = false;
    video.muted = !soundEnabled;
    $('sound').hidden = soundEnabled;
    send(connection, { type: 'ping', sent: Date.now() });
    pingTimer = setInterval(() => send(connection, { type: 'ping', sent: Date.now() }), 5000);
    addMessage('', 'Вы присоединились. Просмотром управляет ведущий.', true);
  });
  connection.on('data', (data) => {
    if (connection !== hostConnection || !data || typeof data !== 'object') return;
    if (data.type === 'pong' && Number.isFinite(data.host) && Number.isFinite(data.echo)) {
      clockOffset = data.host - (data.echo + Date.now()) / 2;
    }
    if (data.type === 'state') receiveState(data);
    if (chatMessage(data)) addMessage(data.name, data.text);
    if (data.type === 'people' && Number.isInteger(data.count) && data.count >= 1 && data.count <= 8) updatePeople(data.count);
  });
  connection.on('close', () => { if (connection === hostConnection) guestDisconnected(); });
  connection.on('error', () => { if (connection === hostConnection) { connection.close(); guestDisconnected(); } });
  connectTimer = setTimeout(() => {
    if (!connection.open) { connection.close(); guestDisconnected(); feedback('Ведущий недоступен. Он должен держать страницу открытой. Некоторые сети блокируют прямую связь.'); }
  }, timeout);
}

function createRoom() {
  if (shortRoom) { joinOnlineRoom(); return; }
  if (onlineEnabled && !directMode && !roomId) { createOnlineRoom(); return; }
  if (directOffer) { joinDirect().catch(() => feedback('Не удалось открыть прямое приглашение. Попросите новую ссылку.')); return; }
  if (!directMode && !peer?.open) { pendingCreate = !roomId; connectPeer(); return; }
  if (roomId) { joinRoom(); return; }
  secret = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  isHost = true;
  $('role').textContent = 'ВЫ — ВЕДУЩИЙ';
  $('room-title').textContent = 'Можно звать друзей';
  $('room-hint').textContent = 'До 8 зрителей. Не закрывайте эту вкладку: комната работает, пока вы здесь.';
  $('create').hidden = true;
  $('invite').hidden = false;
  $('demo').disabled = false;
  $('file').disabled = false;
  $('load-url').disabled = false;
  for (const id of ['season', 'episode', 'load-episode']) $(id).disabled = false;
  $('send').disabled = false;
  $('connection').textContent = 'Комната готова';
  addMessage('', 'Комната создана. Отправьте друзьям приглашение.', true);
}

$('create').addEventListener('click', createRoom);
$('invite').addEventListener('click', async () => {
  if (onlineRoom) {
    const url = new URL(location.pathname, location.origin);
    url.hash = `r=${onlineRoom}`;
    $('invite-label').hidden = false;
    $('invite-link').value = url.href;
    try { await navigator.clipboard.writeText(url.href); feedback('Ссылка скопирована. Друг откроет её и подключится автоматически.'); }
    catch { $('invite-link').focus(); $('invite-link').select(); feedback('Скопируйте ссылку из поля.'); }
    return;
  }
  if (directMode) { await inviteDirect(); return; }
  const url = new URL(location.href);
  if (isHost) url.hash = new URLSearchParams({ room: peer.id, key: secret }).toString();
  $('invite-label').hidden = false;
  $('invite-link').value = url.href;
  try { await navigator.clipboard.writeText(url.href); feedback('Ссылка скопирована. Отправьте её друзьям.'); }
  catch { $('invite-link').focus(); $('invite-link').select(); feedback('Скопируйте ссылку из поля приглашения.'); }
});
$('url-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const url = $('video-url').value.trim();
  if (!isHost) return;
  if (!validUrl(url)) { feedback('Нужна прямая HTTPS-ссылка на видео.'); return; }
  setSource({ id: crypto.randomUUID(), kind: 'url', title: 'Видео по ссылке', url }, url);
});
$('demo').addEventListener('click', () => setSource({ id: crypto.randomUUID(), kind: 'url', title: 'Тестовое видео · цветы · 5 секунд', url: DEMO }, DEMO));
$('file').addEventListener('change', () => {
  const file = $('file').files?.[0];
  $('file').value = '';
  if (!file || !file.size) return;
  if (isHost) {
    setSource({ id: crypto.randomUUID(), kind: 'file', name: file.name.slice(0, 250), title: file.name.slice(0, 250), size: file.size }, URL.createObjectURL(file));
  } else if (source?.kind === 'file') {
    if (file.name.slice(0, 250) !== source.name || file.size !== source.size) { feedback('Имя и размер файла отличаются от файла ведущего. Выберите одинаковую копию.'); return; }
    loadVideo(URL.createObjectURL(file), source);
  }
});
$('sound').addEventListener('click', () => {
  if (source?.kind === 'shameless') {
    feedback('Нажмите Play внутри внешнего плеера, чтобы разрешить воспроизведение со звуком.');
    return;
  }
  soundEnabled = true;
  video.muted = false;
  $('sound').hidden = true;
  if (latest && !latest.paused) requestPlay();
  applyPlayback(true);
});
$('chat-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (Date.now() - lastChat < 400) return;
  const text = $('message').value.trim().slice(0, 500);
  const name = $('name').value.trim().slice(0, 30) || 'Зритель';
  if (!text || (!isHost && !hostConnection?.open)) return;
  lastChat = Date.now();
  const message = { type: 'chat', name, text };
  if (isHost) { addMessage(name, text); broadcast(message); } else send(hostConnection, message);
  $('message').value = '';
});
for (const event of ['play', 'pause', 'seeked', 'ratechange', 'ended']) video.addEventListener(event, publishState);
video.addEventListener('loadedmetadata', () => { if (isHost) publishState(); else applyPlayback(true); });
video.addEventListener('error', () => {
  if (!video.getAttribute('src')) return;
  $('sync').textContent = 'Видео не удалось открыть';
  feedback('Источник недоступен или формат не поддерживается. Для телефона лучше MP4 с H.264/AAC.');
});
setInterval(() => {
  if (source?.kind === 'shameless') {
    if (!embedded.ready || !embedded.duration) embedCommand('duration');
    else if (!isHost) applyEmbed();
  }
  if (isHost) publishState();
}, 2000);
window.addEventListener('beforeunload', () => {
  relayRunning = false;
  clearTimeout(onlinePollTimer);
  if (relayJoin) fetch('/.netlify/functions/signal', { method: 'POST', keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'leave', room: shortRoom, join: relayJoin }) }).catch(() => {});
  peer?.destroy();
  for (const pc of directPeers) pc.close();
  if (blobUrl) URL.revokeObjectURL(blobUrl);
});

function peerFailed() {
  clearTimeout(peerStartTimer);
  peerOpening = false;
  if (directMode) return;
  $('create').disabled = false;
  $('connection').textContent = 'Обычная связь недоступна';
  if (pendingCreate) {
    pendingCreate = false;
    createDirectRoom();
    feedback('Сервис комнат недоступен. Создана прямая комната — отправьте другу приглашение и примите ответный код.');
  } else if (roomId) {
    peer?.destroy();
    feedback('Сервис комнат недоступен. Попросите ведущего создать прямую комнату и отправить новое приглашение.');
  }
}

function connectPeer() {
  if (peerOpening || peer?.open) return;
  if (typeof Peer === 'undefined') { peerFailed(); return; }
  peerOpening = true;
  $('create').disabled = true;
  $('connection').textContent = 'Подключаем комнату…';
  peer?.destroy();
  peer = new Peer(crypto.randomUUID());
  peerStartTimer = setTimeout(peerFailed, 8000);
  peer.on('open', () => {
    clearTimeout(peerStartTimer);
    peerOpening = false;
    reconnectAttempts = 0;
    $('create').disabled = false;
    $('connection').textContent = isHost ? 'Комната готова' : 'Можно подключаться';
    if (roomId && roomKey && !hostConnection?.open) joinRoom();
    else if (pendingCreate) { pendingCreate = false; createRoom(); }
  });
  peer.on('connection', acceptGuest);
  peer.on('disconnected', () => {
    if (directMode || peer.destroyed) return;
    if (!isHost && !peerOpening) return;
    $('connection').textContent = 'Восстанавливаем сервис связи…';
    $('create').disabled = true;
    if (++reconnectAttempts <= 2 && !peer.destroyed) {
      setTimeout(() => { if (peer.disconnected && !peer.destroyed) peer.reconnect(); }, 1500);
    } else {
      $('connection').textContent = 'Сервис связи недоступен';
      feedback('Обычная комната не подключилась. Используйте резервное прямое соединение ниже.');
    }
  });
  peer.on('error', (error) => {
    if (directMode) return;
    if (error.type === 'peer-unavailable' && roomId) { hostConnection?.close(); guestDisconnected(); }
    else if (!isHost) peerFailed();
    else { $('connection').textContent = 'Сервис комнат недоступен'; feedback('Сервис комнат недоступен. Уже открытые соединения могут продолжать работать.'); }
  });
}

if (onlineEnabled || shortRoom) $('direct-panel').hidden = true;
if (shortRoom) {
  $('create').hidden = true;
  joinOnlineRoom();
} else if (directOffer) {
  $('direct-create').hidden = true;
  joinDirect().catch(() => feedback('Приглашение не удалось открыть. Попросите у ведущего новую ссылку.'));
} else if (roomId && roomKey) {
  connectPeer();
} else {
  $('connection').textContent = 'Сайт готов';
  $('create').disabled = false;
}

async function signal(action, data = {}, key = '') {
  const response = await fetch('/.netlify/functions/signal', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: key } : {}) },
    body: JSON.stringify({ action, room: onlineRoom || shortRoom, ...data }),
    cache: 'no-store', signal: AbortSignal.timeout(10000)
  });
  let result;
  try { result = await response.json(); } catch { throw new Error('Сервис комнат не запущен на этом адресе.'); }
  if (!response.ok) throw Object.assign(new Error(result.error || 'Сервис комнат недоступен.'), { status: response.status });
  return result;
}

async function createOnlineRoom() {
  if (onlineCreating || isHost) return;
  onlineCreating = true;
  $('create').disabled = true;
  $('connection').textContent = 'Создаём комнату…';
  try {
    const result = await signal('create');
    if (!/^[A-Za-z0-9_-]{16}$/.test(result.room) || typeof result.hostKey !== 'string') throw new Error('Некорректный ответ сервера.');
    onlineRoom = result.room;
    onlineHostKey = result.hostKey;
    directMode = true;
    createRoom();
    $('room-hint').textContent = 'Отправьте одну короткую ссылку всем друзьям. Не закрывайте эту вкладку.';
    relayRunning = true;
    scheduleRelay(0);
  } catch (error) {
    $('connection').textContent = 'Комната не создана';
    feedback(error.name === 'TimeoutError' ? 'Сервер не ответил. Попробуйте создать комнату снова.' : error.message);
  } finally { onlineCreating = false; $('create').disabled = false; }
}

function scheduleRelay(delay = 2000) {
  if (!relayRunning) return;
  clearTimeout(onlinePollTimer);
  onlinePollTimer = setTimeout(syncRelay, delay);
}

async function syncRelay() {
  if (!relayRunning || relayBusy) return;
  relayBusy = true;
  const started = Date.now();
  const snapshot = isHost ? (relayPendingState || state()) : null;
  let retryDelay = 0;
  try {
    const result = await signal('sync', { join: relayJoin, since: relayCursor,
      ...(snapshot ? { state: { ...snapshot, sent: snapshot.sent + relayOffset } } : {}) }, onlineHostKey);
    if (!relayRunning) return;
    relayOffset = result.serverTime - (started + Date.now()) / 2;
    if (!isHost) { clockOffset = relayOffset; if (result.state) receiveState(result.state); }
    else if (relayPendingState?.seq === snapshot.seq) relayPendingState = null;
    for (const message of result.messages || []) {
      if (message.seq > relayCursor && !(isHost && message.actor === 'host')) addMessage(message.name, message.text);
    }
    relayCursor = result.cursor;
    updatePeople(result.count);
    $('connection').textContent = isHost ? 'Комната готова' : 'Вы в комнате';
  } catch (error) {
    retryDelay = 5000;
    $('connection').textContent = 'Восстанавливаем соединение…';
    if (error.status === 410) {
      relayRunning = false;
      if (!isHost) hostConnection?.close();
      feedback(error.message);
    }
  } finally { relayBusy = false; scheduleRelay(retryDelay || (relayPendingState ? 100 : 2000)); }
}

async function sendRelayChat(message) {
  try {
    await signal('chat', { join: relayJoin, message: { ...message, id: crypto.randomUUID() } }, onlineHostKey);
    scheduleRelay(0);
  } catch (error) { feedback(`Сообщение не отправлено: ${error.message}`); }
}

function relayConnection() {
  const handlers = new Map();
  const emit = (event, value) => { for (const callback of handlers.get(event) || []) callback(value); };
  const connection = {
    get open() { return relayRunning; },
    on(event, callback) { if (!handlers.has(event)) handlers.set(event, []); handlers.get(event).push(callback); },
    send(data) {
      if (data.type === 'chat') sendRelayChat(data);
      if (data.type === 'ping') emit('data', { type: 'pong', echo: data.sent, host: Date.now() + relayOffset });
    },
    close() { relayRunning = false; clearTimeout(onlinePollTimer); emit('close'); }
  };
  queueMicrotask(() => { if (relayRunning) emit('open'); });
  return connection;
}

async function joinOnlineRoom() {
  if (onlineCreating || hostConnection?.open) return;
  onlineCreating = true;
  try {
    if (!/^[A-Za-z0-9_-]{16}$/.test(shortRoom || '')) throw new Error('Ссылка на комнату повреждена.');
    hostConnection?.close();
    $('create').hidden = true;
    $('connection').textContent = 'Подключаемся к ведущему…';
    const id = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(12)))).replaceAll('+', '-').replaceAll('/', '_');
    await signal('join', { join: id, relay: true });
    relayJoin = id;
    relayCursor = 0;
    relayRunning = true;
    attachGuest(relayConnection());
    scheduleRelay(0);
  } catch (error) {
    clearTimeout(connectTimer);
    $('connection').textContent = 'Не удалось подключиться';
    $('create').hidden = false;
    $('create').disabled = false;
    $('create').textContent = 'Подключиться снова';
    feedback(error.name === 'TimeoutError' ? 'Сервер не ответил. Нажмите «Подключиться снова».' : error.message);
  } finally { onlineCreating = false; }
}

document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleRelay(0); });

function pack(value) { return btoa(JSON.stringify(value)); }
function unpack(value) {
  if (value.length > 32000) throw new Error('Invitation too large');
  const result = JSON.parse(atob(value.trim()));
  if (!result || typeof result.id !== 'string' || result.id.length > 100 ||
      !['offer', 'answer'].includes(result.type) || typeof result.sdp !== 'string' || result.sdp.length > 25000) throw new Error('Invalid invitation');
  return result;
}

function iceReady(pc) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') { resolve(); return; }
    const finish = () => { clearTimeout(timer); pc.removeEventListener('icegatheringstatechange', check); resolve(); };
    const check = () => { if (pc.iceGatheringState === 'complete') finish(); };
    const timer = setTimeout(finish, 7000);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

function directChannel(pc, channel, id) {
  const handlers = new Map();
  const emit = (event, value) => { for (const callback of handlers.get(event) || []) callback(value); };
  const connection = {
    peer: id, metadata: { key: secret },
    get open() { return channel.readyState === 'open'; },
    on(event, callback) { if (!handlers.has(event)) handlers.set(event, []); handlers.get(event).push(callback); },
    send(data) { channel.send(JSON.stringify(data)); },
    close() { channel.close(); pc.close(); }
  };
  channel.addEventListener('open', () => emit('open'));
  channel.addEventListener('close', () => emit('close'));
  channel.addEventListener('error', () => emit('error'));
  channel.addEventListener('message', (event) => {
    if (typeof event.data !== 'string' || event.data.length > 16000) return;
    try { emit('data', JSON.parse(event.data)); } catch { /* Ignore malformed data. */ }
  });
  pc.addEventListener('connectionstatechange', () => {
    if (pc.connectionState === 'failed') { emit('error'); connection.close(); }
  });
  return connection;
}

function newDirectPeer() {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  directPeers.add(pc);
  pc.addEventListener('connectionstatechange', () => { if (pc.connectionState === 'closed') directPeers.delete(pc); });
  return pc;
}

async function inviteDirect() {
  if (!isHost || !directMode) return;
  if (connections.size + pendingDirect.size >= 7) { feedback('Максимум 7 приглашений и зрителей. Неиспользованные приглашения истекают через 5 минут.'); return; }
  $('invite').disabled = true;
  let pc;
  let id;
  try {
    pc = newDirectPeer();
    id = crypto.randomUUID();
    const connection = directChannel(pc, pc.createDataChannel('together'), id);
    pendingDirect.set(id, pc);
    acceptGuest(connection);
    connection.on('open', () => pendingDirect.delete(id));
    setTimeout(() => { if (pendingDirect.has(id)) { pc.close(); pendingDirect.delete(id); } }, 300000);
    await pc.setLocalDescription(await pc.createOffer());
    await iceReady(pc);
    const url = new URL(location.href);
    url.hash = new URLSearchParams({ offer: pack({ id, type: 'offer', sdp: pc.localDescription.sdp }) }).toString();
    $('invite-label').hidden = false;
    $('invite-link').value = url.href;
    try { await navigator.clipboard.writeText(url.href); feedback('Приглашение скопировано. Друг должен вернуть код ответа.'); }
    catch { $('invite-link').focus(); $('invite-link').select(); feedback('Скопируйте приглашение из поля.'); }
  } catch {
    pc?.close();
    if (id) pendingDirect.delete(id);
    feedback('Не удалось создать прямое приглашение.');
  } finally { $('invite').disabled = false; }
}

async function joinDirect() {
  const offer = unpack(directOffer);
  if (offer.type !== 'offer') throw new Error('Expected offer');
  directMode = true;
  $('create').hidden = true;
  $('direct-create').hidden = true;
  $('connection').textContent = 'Готовим код ответа…';
  const pc = newDirectPeer();
  pc.addEventListener('datachannel', (event) => attachGuest(directChannel(pc, event.channel, offer.id)), { once: true });
  await pc.setRemoteDescription({ type: offer.type, sdp: offer.sdp });
  await pc.setLocalDescription(await pc.createAnswer());
  await iceReady(pc);
  $('reply-panel').hidden = false;
  $('reply').value = pack({ id: offer.id, type: 'answer', sdp: pc.localDescription.sdp });
  $('connection').textContent = 'Отправьте ведущему код ответа';
  $('room-hint').textContent = 'Ведущий вставит ваш код и нажмёт «Подключить».';
  setTimeout(() => { if (pc.connectionState === 'new') { pc.close(); feedback('Приглашение истекло. Попросите у ведущего новую ссылку.'); } }, 300000);
}

function createDirectRoom() {
  if (roomId || isHost) { feedback('Для новой прямой комнаты откройте главную страницу в новой вкладке.'); return; }
  directMode = true;
  pendingCreate = false;
  peerOpening = false;
  clearTimeout(peerStartTimer);
  peer?.destroy();
  $('direct-create').hidden = true;
  $('answer-panel').hidden = false;
  createRoom();
  $('connection').textContent = 'Прямая комната готова';
  $('room-hint').textContent = 'Для каждого друга создайте отдельное приглашение и примите его ответный код. Не закрывайте вкладку.';
}
$('direct-create').addEventListener('click', createDirectRoom);
$('accept-answer').addEventListener('click', async () => {
  try {
    const answer = unpack($('answer').value);
    const pc = pendingDirect.get(answer.id);
    if (answer.type !== 'answer' || !pc) throw new Error('Unknown answer');
    await pc.setRemoteDescription({ type: answer.type, sdp: answer.sdp });
    $('answer').value = '';
    feedback('Ответ принят. Устанавливаем прямое соединение…');
  } catch { feedback('Код не подошёл или приглашение истекло. Создайте новое приглашение.'); }
});
$('copy-reply').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('reply').value); feedback('Код скопирован. Отправьте его ведущему.'); }
  catch { $('reply').focus(); $('reply').select(); feedback('Скопируйте код из поля.'); }
});

function fillEpisodes(season, selected = 1) {
  $('episode').replaceChildren();
  for (let number = 1; number <= EPISODES[season - 1]; number++) {
    $('episode').add(new Option(String(number), String(number)));
  }
  $('episode').value = String(selected);
}

for (let season = 1; season <= EPISODES.length; season++) $('season').add(new Option(String(season), String(season)));
fillEpisodes(1);
$('season').addEventListener('change', () => fillEpisodes(Number($('season').value)));
$('episode-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!isHost) return;
  const season = Number($('season').value);
  const episode = Number($('episode').value);
  const descriptor = { id: crypto.randomUUID(), kind: 'shameless', season, episode,
    title: `Бесстыжие · сезон ${season}, серия ${episode}` };
  if (validSource(descriptor)) setSource(descriptor);
});

function embedCommand(api, value) {
  if (source?.kind !== 'shameless' || embed.hidden || !embed.contentWindow) return;
  embed.contentWindow.postMessage(JSON.stringify(value === undefined ? { api } : { api, value }), EMBED_ORIGIN);
}

function loadSeries(descriptor) {
  video.pause();
  video.removeAttribute('src');
  video.load();
  video.hidden = true;
  if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = ''; }
  activeSource = descriptor.id;
  embedded = { time: 0, paused: true, updated: Date.now(), duration: 0, ready: false };
  lastEmbedSeek = 0;
  lastEmbedCommand = 0;
  $('empty').hidden = true;
  $('sound').hidden = true;
  $('video-title').textContent = descriptor.title;
  $('season').value = String(descriptor.season);
  fillEpisodes(descriptor.season, descriptor.episode);
  $('episode-source').href = `https://shameless-series.ru/${descriptor.season}-sezon-${descriptor.episode}-seriya`;
  $('embed-controls').hidden = false;
  $('embed-resync').hidden = isHost;
  for (const id of ['embed-play', 'embed-pause', 'embed-seek-button']) $(id).disabled = true;
  $('sync').textContent = 'Загружаем внешний плеер…';
  embed.hidden = false;
  embed.src = `${EMBED_BASE}&season=${descriptor.season}&episode=${descriptor.episode}`;
  setTimeout(() => {
    if (activeSource === descriptor.id && !embedded.ready) {
      $('sync').textContent = 'Плеер пока не ответил. Попробуйте Play внутри него или откройте источник.';
    }
  }, 15000);
}

function applyEmbed(force = false) {
  if (isHost || !embedded.ready || !latest || activeSource !== latest.source?.id) return;
  const elapsed = latest.paused ? 0 : Math.max(0, Math.min(10, (Date.now() + clockOffset - latest.sent) / 1000));
  const target = Math.min(embedded.duration || 86400, latest.time + elapsed);
  const localElapsed = embedded.paused ? 0 : Math.min(10, (Date.now() - embedded.updated) / 1000);
  const drift = Math.abs(embedded.time + localElapsed - target);
  if (embedded.duration > 0 && (force || drift > (latest.paused ? 0.15 : 1.2)) && (force || Date.now() - lastEmbedSeek > 2500)) {
    embedCommand('seek', Math.max(0.01, target));
    lastEmbedSeek = Date.now();
  }
  if ((force || latest.paused !== embedded.paused) && (force || Date.now() - lastEmbedCommand > 1500)) {
    embedCommand(latest.paused ? 'pause' : 'play');
    lastEmbedCommand = Date.now();
  }
}

embed.addEventListener('load', () => embedCommand('duration'));
window.addEventListener('message', (event) => {
  if (event.origin !== EMBED_ORIGIN || event.source !== embed.contentWindow || source?.kind !== 'shameless') return;
  let data = event.data;
  if (typeof data === 'string') {
    if (data.length > 4096) return;
    try { data = JSON.parse(data); } catch { return; }
  }
  if (!data || !['duration', 'play', 'pause', 'timeupdate', 'seeked', 'ended'].includes(data.event) ||
      !Number.isFinite(data.time) || data.time < 0 || data.time > 86400) return;
  embedded.ready = true;
  for (const id of ['embed-play', 'embed-pause', 'embed-seek-button']) $(id).disabled = !isHost;
  if (data.event === 'duration') {
    embedded.duration = data.time;
    if (!embedded.duration) $('sync').textContent = 'Каждый участник нажимает Play внутри плеера';
    return;
  }
  const predicted = embedded.time + (embedded.paused ? 0 : Math.min(10, (Date.now() - embedded.updated) / 1000));
  const jumped = Math.abs(data.time - predicted) > 1.5;
  embedded.time = data.time;
  embedded.updated = Date.now();
  if (data.event === 'play') embedded.paused = false;
  if (data.event === 'pause' || data.event === 'ended') embedded.paused = true;
  const minutes = Math.floor(data.time / 60);
  const seconds = String(Math.floor(data.time % 60)).padStart(2, '0');
  $('sync').textContent = `${minutes}:${seconds} · ${embedded.paused ? 'Пауза' : 'Просмотр'} · ${isHost ? 'Вы — ведущий' : 'Следуем за ведущим'}`;
  if (isHost && (jumped || data.event !== 'timeupdate')) publishState();
});
$('embed-play').addEventListener('click', () => { if (isHost) embedCommand('play'); });
$('embed-pause').addEventListener('click', () => { if (isHost) embedCommand('pause'); });
$('embed-seek-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!isHost || !embedded.ready) return;
  const value = Number($('embed-seek').value);
  if (!Number.isFinite(value) || value < 0 || value > 86400) return;
  const target = Math.max(0.01, Math.min(embedded.duration || 86400, value));
  embedCommand('seek', target);
  embedded.time = target;
  embedded.updated = Date.now();
  publishState();
});
$('embed-resync').addEventListener('click', () => applyEmbed(true));

// Follow the visible area above the keyboard without resizing the player.
function setMobileSettings(open) {
  document.body.classList.toggle('mobile-settings-open', open);
  $('mobile-settings').setAttribute('aria-expanded', String(open));
  $('mobile-settings').textContent = open ? 'К просмотру' : 'Настройки';
}

$('mobile-settings').addEventListener('click', () => {
  setMobileSettings(!document.body.classList.contains('mobile-settings-open'));
});
setMobileSettings(!shortRoom && !roomId && !directOffer);

let mobileViewportFrame = 0;
let mobileViewportWidth = 0;
function updateMobileViewport() {
  cancelAnimationFrame(mobileViewportFrame);
  mobileViewportFrame = requestAnimationFrame(() => {
    if (!matchMedia('(max-width: 680px)').matches) return;
    const viewport = window.visualViewport;
    // Leave user-initiated pinch zoom available.
    if (viewport && Math.abs(viewport.scale - 1) > 0.05) return;
    const height = viewport?.height || window.innerHeight;
    const width = document.documentElement.clientWidth;
    const typing = document.activeElement?.id === 'message';
    const style = document.documentElement.style;
    style.setProperty('--mobile-height', `${height}px`);
    style.setProperty('--mobile-top', `${viewport?.offsetTop || 0}px`);
    if (!typing || width !== mobileViewportWidth) {
      style.setProperty('--mobile-player-height', `${Math.min((width - 24) * 9 / 16, height * 0.3)}px`);
      mobileViewportWidth = width;
    }
    document.body.classList.toggle('mobile-typing', typing);
  });
}
window.visualViewport?.addEventListener('resize', updateMobileViewport);
window.visualViewport?.addEventListener('scroll', updateMobileViewport);
window.addEventListener('resize', updateMobileViewport);
document.addEventListener('focusin', updateMobileViewport);
document.addEventListener('focusout', updateMobileViewport);
updateMobileViewport();
