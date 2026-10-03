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
    // Pre-warm the free-tier Render backend in the background as soon as page loads
    try {
      fetch(SERVER_URL, { mode: 'no-cors' }).catch(() => {});
    } catch(e) {}

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
    if (this.socket) {
      if (this.socket.connected) {
        onReady && onReady();
      } else {
        this.socket.once('connect', () => {
          onReady && onReady();
        });
      }
      return;
    }

    console.log('[Socket] Connecting to:', SERVER_URL);
    const loadingText = document.querySelector('.loading-text');
    if (loadingText) loadingText.textContent = 'Connecting to server... (waking up server if idle)';

    this.socket = io(SERVER_URL, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 8,
      reconnectionDelay: 2000,
      timeout: 45000 // 45 seconds for Render free tier wakeups
    });

    this.socket.on('connect', () => {
      this.myId = this.socket.id;
      console.log('[Socket] Connected:', this.myId);
      onReady && onReady();
    });

    let connectAttempts = 0;
    this.socket.on('connect_error', (err) => {
      connectAttempts++;
      console.warn('[Socket] Attempt ' + connectAttempts + ' error:', err.message);
      if (loadingText) {
        loadingText.textContent = 'Waking up server (free tier may take ~30s)...';
      }
      if (connectAttempts >= 8) {
        UI.showToast('Server connection timed out. Please refresh.', 'error');
        document.getElementById('overlay-loading')?.classList.add('hidden');
      }
    });

    this.socket.on('disconnect', (reason) => {
      console.log('[Socket] Disconnected:', reason);
      UI.showToast('Connection lost: ' + reason, 'warn');
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
    if (!files || files.length === 0) return;

    if (!this.connManager || this.connManager.getPeerCount() === 0) {
      UI.showToast('No peers connected yet! Share the room code first.', 'warn');
      return;
    }

    // If peer is connected to room but WebRTC P2P channel is still finishing handshake, wait up to 4s
    if (this.connManager.getReadyPeerCount() === 0) {
      UI.showToast('Establishing direct P2P link... please wait.', 'info');
      let waited = 0;
      while (waited < 4000 && this.connManager.getReadyPeerCount() === 0) {
        await new Promise(r => setTimeout(r, 400));
        waited += 400;
      }
      if (this.connManager.getReadyPeerCount() === 0) {
        UI.showToast('P2P connection is still connecting. Please try again in 5 seconds.', 'warn');
        return;
      }
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
    } finally {
      setTimeout(() => this._processQueue(), 300);
    }
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

    const dot = document.createElement('span');
    dot.className = 'peer-dot';
    dot.id = 'dot-' + peerId;

    const name = document.createElement('span');
    name.className = 'peer-name';
    name.textContent = displayName || 'Anonymous';

    const status = document.createElement('span');
    status.className = 'peer-status';
    status.id = 'status-' + peerId;
    status.textContent = 'connecting...';

    item.appendChild(dot);
    item.appendChild(name);
    item.appendChild(status);
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
    const safeType = typeof data.fileType === 'string' ? data.fileType.toLowerCase() : '';
    const isSafeImage = (safeType.startsWith('image/') && !safeType.includes('svg'));
    const isSafeMedia = safeType.startsWith('video/') || safeType.startsWith('audio/');
    const isSafePdf = safeType === 'application/pdf';
    const isPreviewable = isSafeImage || isSafeMedia || isSafePdf;
    const safeName = typeof data.name === 'string' ? data.name : 'downloaded_file';

    const item = document.createElement('div');
    item.className = 'received-file-item';

    const iconDiv = document.createElement('div');
    iconDiv.className = 'file-icon';
    iconDiv.textContent = icon;
    item.appendChild(iconDiv);

    const infoDiv = document.createElement('div');
    infoDiv.className = 'file-info';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'file-name';
    nameSpan.textContent = safeName;

    const sizeSpan = document.createElement('span');
    sizeSpan.className = 'file-size';
    sizeSpan.textContent = formatBytes(data.blob.size);

    infoDiv.appendChild(nameSpan);
    infoDiv.appendChild(sizeSpan);
    item.appendChild(infoDiv);

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'file-actions';

    if (isPreviewable) {
      const previewBtn = document.createElement('button');
      previewBtn.className = 'btn-preview';
      previewBtn.textContent = 'Preview';
      previewBtn.addEventListener('click', () => {
        showPreview(url, safeType, safeName);
      });
      actionsDiv.appendChild(previewBtn);
    }

    const downloadLink = document.createElement('a');
    downloadLink.className = 'btn-download';
    downloadLink.href = url;
    downloadLink.download = safeName;
    downloadLink.textContent = 'Download';
    actionsDiv.appendChild(downloadLink);

    item.appendChild(actionsDiv);
    list.prepend(item);

    this.updateReceiveProgress(1, data.blob.size, data.blob.size);
    this.showToast('"' + safeName + '" received!', 'success');
    if (isSafeImage) showPreview(url, safeType, safeName);
  },

  addChatMessage(name, message, isMine) {
    const chat = document.getElementById('chat-messages');
    if (!chat) return;
    const placeholder = chat.querySelector('[data-placeholder]');
    placeholder?.remove();

    const msg = document.createElement('div');
    msg.className = 'chat-msg ' + (isMine ? 'mine' : 'theirs');

    const nameSpan = document.createElement('span');
    nameSpan.className = 'chat-name';
    nameSpan.textContent = isMine ? 'You' : (name || 'Anonymous');

    const textSpan = document.createElement('span');
    textSpan.className = 'chat-text';
    textSpan.textContent = message || '';

    msg.appendChild(nameSpan);
    msg.appendChild(textSpan);
    chat.appendChild(msg);
    chat.scrollTop = chat.scrollHeight;
  }
};

// ─── Preview Modal (Secured against XSS) ─────────────────────────
window.showPreview = function(url, type, name) {
  const modal = document.getElementById('preview-modal');
  const content = document.getElementById('preview-content');
  const title = document.getElementById('preview-title');
  if (!modal || !content) return;
  if (title) title.textContent = name;
  content.innerHTML = '';

  const safeType = typeof type === 'string' ? type.toLowerCase() : '';
  if (safeType.startsWith('image/') && !safeType.includes('svg')) {
    const img = document.createElement('img');
    img.src = url;
    img.style.maxWidth = '100%';
    img.style.maxHeight = '70vh';
    img.style.objectFit = 'contain';
    img.style.display = 'block';
    img.style.margin = '0 auto';
    content.appendChild(img);
  } else if (safeType.startsWith('video/')) {
    const video = document.createElement('video');
    video.src = url;
    video.controls = true;
    video.style.maxWidth = '100%';
    video.style.maxHeight = '70vh';
    video.style.display = 'block';
    video.style.margin = '0 auto';
    content.appendChild(video);
  } else if (safeType.startsWith('audio/')) {
    const audio = document.createElement('audio');
    audio.src = url;
    audio.controls = true;
    audio.style.width = '100%';
    content.appendChild(audio);
  } else if (safeType === 'application/pdf') {
    const iframe = document.createElement('iframe');
    iframe.src = url;
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.style.width = '100%';
    iframe.style.height = '70vh';
    iframe.style.border = 'none';
    content.appendChild(iframe);
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
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
