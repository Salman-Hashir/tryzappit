// ─── TryZappit Main App ────────────────────────────────────────
const SERVER_URL = window.ZAPPIT_SERVER || 'https://tryzappit.onrender.com';

class TryZappit {
  constructor() {
    this.socket = null;
    this.connManager = null;
    this.myId = null;
    this.roomId = null;
    this.displayName = 'Anonymous';
    this.peers = new Map();
    this.transferQueue = [];
    this.isTransferring = false;
    this.init();
  }

  init() {
    const path = window.location.pathname;
    const params = new URLSearchParams(window.location.search);
    const roomFromUrl = params.get('room');

    if (path.includes('room')) {
      this._initRoomPage(roomFromUrl);
    } else if (path.includes('send')) {
      this._initSendPage();
    } else if (path.includes('receive')) {
      this._initReceivePage();
    } else {
      this._initLanding();
    }
  }

  // ─── SOCKET ────────────────────────────────────────────────
  connectSocket(onReady) {
    console.log('[Socket] Connecting to:', SERVER_URL);
    this.socket = io(SERVER_URL, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 5,
      timeout: 10000
    });

    this.socket.on('connect', () => {
      this.myId = this.socket.id;
      console.log('[Socket] Connected:', this.myId);
      onReady && onReady();
    });

    this.socket.on('connect_error', (err) => {
      console.error('[Socket] Error:', err.message);
      UI.showToast('Cannot connect to server. Check your internet.', 'error');
      document.getElementById('overlay-loading')?.classList.add('hidden');
    });

    this.socket.on('disconnect', (reason) => {
      console.log('[Socket] Disconnected:', reason);
      UI.showToast('Connection lost: ' + reason, 'error');
    });

    this.socket.on('error', ({ message }) => {
      UI.showToast(message, 'error');
      document.getElementById('overlay-loading')?.classList.add('hidden');
    });

    // Room events
    this.socket.on('room-created', (data) => this._onRoomCreated(data));
    this.socket.on('room-joined', (data) => this._onRoomJoined(data));
    this.socket.on('peer-joined', (data) => this._onPeerJoined(data));
    this.socket.on('peer-left', (data) => this._onPeerLeft(data));

    // WebRTC signaling
    this.socket.on('offer', async ({ fromId, offer }) => {
      console.log('[Signal] Offer from:', fromId);
      if (this.connManager) await this.connManager.handleOffer(fromId, offer);
    });

    this.socket.on('answer', async ({ fromId, answer }) => {
      console.log('[Signal] Answer from:', fromId);
      if (this.connManager) await this.connManager.handleAnswer(fromId, answer);
    });

    this.socket.on('ice-candidate', async ({ fromId, candidate }) => {
      if (this.connManager) await this.connManager.handleIceCandidate(fromId, candidate);
    });

    // Chat fallback via socket
    this.socket.on('chat-message', (data) => {
      if (data.fromId !== this.myId) {
        UI.addChatMessage(data.displayName, data.message, false);
      }
    });
  }

  // ─── ROOM EVENTS ───────────────────────────────────────────
  _onRoomCreated({ roomId, peerId }) {
    this.roomId = roomId;
    this.myId = peerId;
    this._setupConnManager();
    this._enterRoom();
  }

  async _onRoomJoined({ roomId, peerId, peers }) {
    this.roomId = roomId;
    this.myId = peerId;
    this._setupConnManager();

    for (const peer of peers) {
      this.peers.set(peer.id, { displayName: peer.displayName, connected: false });
      UI.addPeer(peer.id, peer.displayName);
      await this.connManager.connectTo(peer.id);
    }

    this._enterRoom();
  }

  _onPeerJoined({ peerId, displayName }) {
    this.peers.set(peerId, { displayName, connected: false });
    UI.addPeer(peerId, displayName);
    UI.showToast(displayName + ' joined!', 'success');
    UI.updatePeerCount(this.peers.size + 1);
  }

  _onPeerLeft({ peerId }) {
    const peer = this.peers.get(peerId);
    const name = peer?.displayName || 'Someone';
    this.peers.delete(peerId);
    this.connManager?.removePeer(peerId);
    UI.removePeer(peerId);
    UI.showToast(name + ' left the room', 'warn');
    UI.updatePeerCount(this.peers.size + 1);
  }

  _setupConnManager() {
    this.connManager = new ConnectionManager(
      this.socket,
      (data) => this._onP2PData(data),
      (peerId, state) => this._onPeerState(peerId, state)
    );
  }

  _enterRoom() {
    // Update URL with room id
    const url = new URL(window.location.href);
    url.searchParams.set('room', this.roomId);
    window.history.replaceState({}, '', url);

    UI.showRoom(this.roomId, this.displayName);
    UI.generateQR(this.roomId);
    UI.updatePeerCount(this.peers.size + 1);
  }

  // ─── P2P DATA ──────────────────────────────────────────────
  _onP2PData(data) {
    switch(data.type) {
      case 'file-start':
        UI.showIncomingFile(data);
        break;
      case 'file-progress':
        UI.updateReceiveProgress(data.progress, data.received, data.total);
        break;
      case 'file-complete':
        UI.showFileComplete(data);
        break;
      case 'chat':
        UI.addChatMessage(data.displayName, data.message, false);
        break;
    }
  }

  _onPeerState(peerId, state) {
    if (state === 'data-open') {
      const peer = this.peers.get(peerId);
      if (peer) { peer.connected = true; UI.setPeerConnected(peerId, true); }
      UI.showToast('P2P connection established!', 'success');
    } else if (state === 'failed' || state === 'disconnected' || state === 'closed') {
      UI.setPeerConnected(peerId, false);
    }
  }

  // ─── PUBLIC API ─────────────────────────────────────────────
  createRoom(displayName, password) {
    this.displayName = displayName || 'Anonymous';
    this.connectSocket(() => {
      this.socket.emit('create-room', { displayName: this.displayName, password: password || null });
    });
  }

  joinRoom(roomId, displayName, password) {
    this.displayName = displayName || 'Anonymous';
    this.connectSocket(() => {
      this.socket.emit('join-room', {
        roomId: roomId.toUpperCase().trim(),
        displayName: this.displayName,
        password: password || null
      });
    });
  }

  async sendFiles(files) {
    if (!this.connManager || this.connManager.getPeerCount() === 0) {
      UI.showToast('No peers connected yet! Share the room code first.', 'warn');
      return;
    }
    for (const file of files) this.transferQueue.push(file);
    if (!this.isTransferring) this._processQueue();
  }

  async _processQueue() {
    if (this.transferQueue.length === 0) {
      this.isTransferring = false;
      return;
    }
    this.isTransferring = true;
    const file = this.transferQueue.shift();

    UI.showSendingFile(file);
    try {
      await this.connManager.broadcastFile(file, (progress, sent, total) => {
        UI.updateSendProgress(progress, sent, total);
      });
      UI.showToast('"' + file.name + '" sent!', 'success');
    } catch(e) {
      console.error('[Send] Error:', e);
      UI.showToast('Failed to send "' + file.name + '": ' + e.message, 'error');
    }
    setTimeout(() => this._processQueue(), 300);
  }

  sendChat(message) {
    if (!message.trim()) return;
    // Try P2P first, fallback to socket
    const sentP2P = this.connManager?.broadcastChat(message, this.displayName);
    // Always send via socket too for reliability
    if (this.socket && this.roomId) {
      this.socket.emit('chat-message', { roomId: this.roomId, message, displayName: this.displayName });
    }
    UI.addChatMessage(this.displayName, message, true);
  }

  // ─── PAGE INITS ─────────────────────────────────────────────
  _initLanding() {
    document.getElementById('btn-send')?.addEventListener('click', () => {
      window.location.href = 'pages/send.html';
    });
    document.getElementById('btn-receive')?.addEventListener('click', () => {
      window.location.href = 'pages/receive.html';
    });
    document.getElementById('btn-create-room')?.addEventListener('click', () => {
      window.location.href = 'pages/send.html';
    });
    const joinBtn = document.getElementById('btn-join');
    const roomInput = document.getElementById('room-code-input');
    joinBtn?.addEventListener('click', () => {
      const code = roomInput?.value?.trim();
      if (code) window.location.href = 'pages/room.html?room=' + code.toUpperCase();
      else UI.showToast('Enter a room code!', 'warn');
    });
    roomInput?.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') joinBtn?.click();
    });
  }

  _initSendPage() {
    const createBtn = document.getElementById('btn-create');
    createBtn?.addEventListener('click', () => {
      const name = document.getElementById('display-name')?.value?.trim() || 'Anonymous';
      const pass = document.getElementById('room-password')?.value || null;
      localStorage.setItem('zappit_name', name);
      document.getElementById('overlay-loading')?.classList.remove('hidden');
      this.createRoom(name, pass);
    });
    this._setupSharedUI();
  }

  _initReceivePage() {
    // Pre-fill from URL
    const params = new URLSearchParams(window.location.search);
    const code = params.get('room');
    if (code) {
      const inp = document.getElementById('room-code');
      if (inp) inp.value = code.toUpperCase();
    }

    document.getElementById('btn-join')?.addEventListener('click', () => {
      const name = document.getElementById('display-name')?.value?.trim() || 'Anonymous';
      const code = document.getElementById('room-code')?.value?.toUpperCase()?.trim();
      const pass = document.getElementById('room-password')?.value || null;
      if (!code) { UI.showToast('Enter a room code!', 'error'); return; }
      localStorage.setItem('zappit_name', name);
      document.getElementById('overlay-loading')?.classList.remove('hidden');
      this.joinRoom(code, name, pass);
    });
    this._setupSharedUI();
  }

  _initRoomPage(roomId) {
    const savedName = localStorage.getItem('zappit_name') || 'Anonymous';

    if (!roomId) {
      // No room id = create new
      document.getElementById('overlay-loading')?.classList.remove('hidden');
      this.createRoom(savedName, null);
    } else {
      // Has room id = show name form then join
      document.getElementById('name-ui')?.classList.remove('hidden');
      document.getElementById('join-room-label') && (document.getElementById('join-room-label').textContent = 'Joining room ' + roomId);

      const inp = document.getElementById('display-name');
      if (inp) inp.value = savedName;

      document.getElementById('btn-join-room')?.addEventListener('click', () => {
        const name = document.getElementById('display-name')?.value?.trim() || 'Anonymous';
        const pass = document.getElementById('room-password')?.value || null;
        localStorage.setItem('zappit_name', name);
        document.getElementById('name-ui')?.classList.add('hidden');
        document.getElementById('overlay-loading')?.classList.remove('hidden');
        this.joinRoom(roomId, name, pass);
      });
    }
    this._setupSharedUI();
  }

  _setupSharedUI() {
    // Dropzone
    const zone = document.getElementById('dropzone');
    const fileInput = document.getElementById('file-input');
    if (zone) {
      zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag-over'); });
      zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
      zone.addEventListener('drop', (e) => {
        e.preventDefault(); zone.classList.remove('drag-over');
        this.sendFiles(Array.from(e.dataTransfer.files));
      });
      zone.addEventListener('click', () => fileInput?.click());
    }
    fileInput?.addEventListener('change', (e) => {
      this.sendFiles(Array.from(e.target.files));
      e.target.value = '';
    });

    // Chat
    const chatInput = document.getElementById('chat-input');
    const chatSend = document.getElementById('chat-send');
    const doSend = () => { const m = chatInput?.value?.trim(); if (m) { this.sendChat(m); chatInput.value = ''; } };
    chatSend?.addEventListener('click', doSend);
    chatInput?.addEventListener('keypress', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); } });

    // Copy buttons
    document.getElementById('btn-copy-code')?.addEventListener('click', () => {
      const code = document.getElementById('display-room-id')?.textContent;
      if (code && code !== '——————') navigator.clipboard.writeText(code).then(() => UI.showToast('Code copied!', 'success'));
    });
    document.getElementById('btn-copy-link')?.addEventListener('click', () => {
      const link = document.getElementById('share-link')?.value;
      if (link) navigator.clipboard.writeText(link).then(() => UI.showToast('Link copied!', 'success'));
    });
  }
}

// ─── UI ────────────────────────────────────────────────────────
const UI = {
  _toastTimer: null,

  showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    if (!toast) return;
    const colors = { success: '#00FF88', error: '#FF5555', warn: '#FFAA00', info: '#00BBFF' };
    toast.textContent = message;
    toast.style.borderColor = colors[type] || colors.info;
    toast.style.color = colors[type] || colors.info;
    toast.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => toast.classList.remove('show'), 3500);
  },

  showRoom(roomId, displayName) {
    document.getElementById('overlay-loading')?.classList.add('hidden');
    document.getElementById('setup-ui')?.classList.add('hidden');
    document.getElementById('name-ui')?.classList.add('hidden');
    document.getElementById('room-ui')?.classList.remove('hidden');

    const el = document.getElementById('display-room-id');
    if (el) el.textContent = roomId;

    const nameEl = document.getElementById('my-name-display');
    if (nameEl) nameEl.textContent = 'You (' + displayName + ')';

    const link = window.location.origin + '/pages/room.html?room=' + roomId;
    const linkEl = document.getElementById('share-link');
    if (linkEl) linkEl.value = link;
  },

  generateQR(roomId) {
    const qrEl = document.getElementById('qr-container');
    if (!qrEl) return;
    const link = window.location.origin + '/pages/room.html?room=' + roomId;
    const url = 'https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=' + encodeURIComponent(link) + '&bgcolor=050808&color=00FF88&margin=10';
    qrEl.innerHTML = '<img src="' + url + '" alt="QR" style="width:160px;height:160px;border:1px solid rgba(0,255,136,0.3);display:block;margin:0 auto">';
  },

  updatePeerCount(count) {
    ['peer-count', 'peer-count-2'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = count;
    });
  },

  addPeer(peerId, displayName) {
    const list = document.getElementById('peer-list');
    if (!list) return;
    if (document.getElementById('peer-' + peerId)) return; // already exists
    const item = document.createElement('div');
    item.id = 'peer-' + peerId;
    item.className = 'peer-item';
    item.innerHTML = '<span class="peer-dot" id="dot-' + peerId + '"></span><span class="peer-name">' + escapeHtml(displayName) + '</span><span class="peer-status" id="status-' + peerId + '">connecting...</span>';
    list.appendChild(item);
  },

  removePeer(peerId) {
    document.getElementById('peer-' + peerId)?.remove();
  },

  setPeerConnected(peerId, connected) {
    const dot = document.getElementById('dot-' + peerId);
    const status = document.getElementById('status-' + peerId);
    if (dot) dot.className = 'peer-dot' + (connected ? ' connected' : '');
    if (status) status.textContent = connected ? 'ready' : 'disconnected';
  },

  showSendingFile(file) {
    document.getElementById('send-progress-wrap')?.classList.remove('hidden');
    const el = document.getElementById('sending-filename');
    if (el) el.textContent = file.name;
  },

  updateSendProgress(progress, sent, total) {
    const bar = document.getElementById('send-progress-bar');
    const pct = document.getElementById('send-progress-pct');
    const speed = document.getElementById('send-speed');
    const p = Math.round(progress * 100);
    if (bar) bar.style.width = p + '%';
    if (pct) pct.textContent = p + '%';
    if (speed) speed.textContent = formatBytes(sent) + ' / ' + formatBytes(total);
  },

  showIncomingFile(data) {
    document.getElementById('recv-progress-wrap')?.classList.remove('hidden');
    document.getElementById('waiting-msg')?.classList.add('hidden');
    const el = document.getElementById('recv-filename');
    if (el) el.textContent = data.name;
    this.updateReceiveProgress(0, 0, data.size);
  },

  updateReceiveProgress(progress, received, total) {
    const bar = document.getElementById('recv-progress-bar');
    const pct = document.getElementById('recv-progress-pct');
    const speed = document.getElementById('recv-speed');
    const p = Math.round(progress * 100);
    if (bar) bar.style.width = p + '%';
    if (pct) pct.textContent = p + '%';
    if (speed) speed.textContent = formatBytes(received) + ' / ' + formatBytes(total);
  },

  showFileComplete(data) {
    const list = document.getElementById('received-files');
    if (!list) return;
    list.classList.remove('hidden');
    document.getElementById('waiting-msg')?.classList.add('hidden');

    const url = URL.createObjectURL(data.blob);
    const icon = getFileIcon(data.fileType);
    const isPreviewable = data.fileType?.startsWith('image/') || data.fileType?.startsWith('video/') || data.fileType?.startsWith('audio/') || data.fileType === 'application/pdf';

    const item = document.createElement('div');
    item.className = 'received-file-item';
    item.innerHTML = '<div class="file-icon">' + icon + '</div><div class="file-info"><span class="file-name">' + escapeHtml(data.name) + '</span><span class="file-size">' + formatBytes(data.blob.size) + '</span></div><div class="file-actions">' +
      (isPreviewable ? '<button class="btn-preview" onclick="showPreview(\'' + url + '\',\'' + data.fileType + '\',\'' + escapeHtml(data.name) + '\')">Preview</button>' : '') +
      '<a href="' + url + '" download="' + escapeHtml(data.name) + '" class="btn-download">Download</a></div>';
    list.prepend(item);

    this.updateReceiveProgress(1, data.blob.size, data.blob.size);
    this.showToast('"' + data.name + '" received!', 'success');
    if (data.fileType?.startsWith('image/')) showPreview(url, data.fileType, data.name);
  },

  addChatMessage(name, message, isMine) {
    const chat = document.getElementById('chat-messages');
    if (!chat) return;
    // Remove placeholder
    const placeholder = chat.querySelector('[data-placeholder]');
    placeholder?.remove();

    const msg = document.createElement('div');
    msg.className = 'chat-msg ' + (isMine ? 'mine' : 'theirs');
    msg.innerHTML = '<span class="chat-name">' + (isMine ? 'You' : escapeHtml(name)) + '</span><span class="chat-text">' + escapeHtml(message) + '</span>';
    chat.appendChild(msg);
    chat.scrollTop = chat.scrollHeight;
  }
};

// ─── Preview Modal ──────────────────────────────────────────────
window.showPreview = function(url, type, name) {
  const modal = document.getElementById('preview-modal');
  const content = document.getElementById('preview-content');
  const title = document.getElementById('preview-title');
  if (!modal || !content) return;
  if (title) title.textContent = name;
  content.innerHTML = '';
  if (type.startsWith('image/')) {
    content.innerHTML = '<img src="' + url + '" style="max-width:100%;max-height:70vh;object-fit:contain;display:block;margin:0 auto">';
  } else if (type.startsWith('video/')) {
    content.innerHTML = '<video src="' + url + '" controls style="max-width:100%;max-height:70vh;display:block;margin:0 auto"></video>';
  } else if (type.startsWith('audio/')) {
    content.innerHTML = '<audio src="' + url + '" controls style="width:100%"></audio>';
  } else if (type === 'application/pdf') {
    content.innerHTML = '<iframe src="' + url + '" style="width:100%;height:70vh;border:none"></iframe>';
  }
  modal.classList.remove('hidden');
};

window.closePreview = function() {
  document.getElementById('preview-modal')?.classList.add('hidden');
};

// ─── Helpers ────────────────────────────────────────────────────
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024, sizes = ['B','KB','MB','GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
}

function getFileIcon(type) {
  if (!type) return '📄';
  if (type.startsWith('image/')) return '🖼️';
  if (type.startsWith('video/')) return '🎥';
  if (type.startsWith('audio/')) return '🎵';
  if (type === 'application/pdf') return '📕';
  if (type.includes('zip') || type.includes('rar') || type.includes('7z')) return '📦';
  if (type.includes('text') || type.includes('json')) return '📝';
  return '📄';
}

function escapeHtml(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.appendChild(document.createTextNode(String(str)));
  return d.innerHTML;
}

// ─── QR toggle helper ───────────────────────────────────────────
window.toggleQR = function() {
  const w = document.getElementById('qr-wrap');
  if (w) w.style.display = w.style.display === 'none' ? 'block' : 'none';
};

// ─── Boot ───────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  window.zappit = new TryZappit();
});
