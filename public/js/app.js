// ─── TryZappit Main App ────────────────────────────────────────
// Socket.io + WebRTC orchestration + UI

const SERVER_URL = window.ZAPPIT_SERVER || 'https://tryzappit-server.onrender.com';

class TryZappit {
  constructor() {
    this.socket = null;
    this.connManager = null;
    this.myId = null;
    this.roomId = null;
    this.displayName = 'Anonymous';
    this.peers = new Map(); // peerId → { displayName, connected }
    this.transferQueue = [];
    this.isTransferring = false;
    this.receivedFiles = [];

    this.init();
  }

  init() {
    this._detectPage();
  }

  _detectPage() {
    const path = window.location.pathname;
    const params = new URLSearchParams(window.location.search);
    const roomFromUrl = params.get('room');

    if (path.includes('room') || roomFromUrl) {
      this.initRoomPage(roomFromUrl);
    } else if (path.includes('send')) {
      this.initSendPage();
    } else if (path.includes('receive')) {
      this.initReceivePage();
    } else {
      this.initLanding();
    }
  }

  // ─── SOCKET SETUP ──────────────────────────────────────────
  connectSocket() {
    this.socket = io(SERVER_URL, { transports: ['websocket', 'polling'] });

    this.socket.on('connect', () => {
      this.myId = this.socket.id;
      console.log('[Socket] Connected:', this.myId);
    });

    this.socket.on('disconnect', () => {
      UI.showToast('Connection lost. Reconnecting...', 'error');
    });

    this.socket.on('error', ({ message }) => {
      UI.showToast(message, 'error');
    });

    // Room events
    this.socket.on('room-created', (data) => this._onRoomCreated(data));
    this.socket.on('room-joined', (data) => this._onRoomJoined(data));
    this.socket.on('peer-joined', (data) => this._onPeerJoined(data));
    this.socket.on('peer-left', (data) => this._onPeerLeft(data));

    // WebRTC signaling
    this.socket.on('offer', async ({ fromId, offer }) => {
      if (!this.connManager) return;
      await this.connManager.handleOffer(fromId, offer);
    });

    this.socket.on('answer', async ({ fromId, answer }) => {
      if (!this.connManager) return;
      await this.connManager.handleAnswer(fromId, answer);
    });

    this.socket.on('ice-candidate', async ({ fromId, candidate }) => {
      if (!this.connManager) return;
      await this.connManager.handleIceCandidate(fromId, candidate);
    });

    // Chat from signaling (fallback)
    this.socket.on('chat-message', (data) => {
      UI.addChatMessage(data.displayName, data.message, false);
    });
  }

  // ─── ROOM EVENTS ───────────────────────────────────────────
  _onRoomCreated({ roomId, peerId }) {
    this.roomId = roomId;
    this.myId = peerId;
    this._enterRoom();
  }

  async _onRoomJoined({ roomId, peerId, peers }) {
    this.roomId = roomId;
    this.myId = peerId;

    // Connect to all existing peers
    for (const peer of peers) {
      this.peers.set(peer.id, { displayName: peer.displayName, connected: false });
      await this.connManager.connectTo(peer.id);
    }

    this._enterRoom();
  }

  async _onPeerJoined({ peerId, displayName }) {
    this.peers.set(peerId, { displayName, connected: false });
    UI.addPeer(peerId, displayName);
    UI.showToast(`${displayName} joined the room`, 'success');
    UI.updatePeerCount(this.peers.size + 1);
  }

  _onPeerLeft({ peerId }) {
    const peer = this.peers.get(peerId);
    const name = peer?.displayName || 'Someone';
    this.peers.delete(peerId);
    this.connManager?.removePeer(peerId);
    UI.removePeer(peerId);
    UI.showToast(`${name} left the room`, 'warn');
    UI.updatePeerCount(this.peers.size + 1);
  }

  _enterRoom() {
    // Setup connection manager
    this.connManager = new ConnectionManager(
      this.socket,
      (data) => this._onP2PData(data),
      (peerId, state) => this._onPeerState(peerId, state)
    );

    // Update URL
    const url = new URL(window.location);
    url.searchParams.set('room', this.roomId);
    window.history.pushState({}, '', url);

    // Show room UI
    UI.showRoom(this.roomId, this.displayName);
    UI.generateQR(this.roomId);
    UI.updatePeerCount(1);
  }

  // ─── P2P DATA ──────────────────────────────────────────────
  _onP2PData(data) {
    switch (data.type) {
      case 'file-start':
        UI.showIncomingFile(data);
        break;

      case 'file-progress':
        UI.updateReceiveProgress(data.progress, data.received, data.total);
        break;

      case 'file-complete':
        this.receivedFiles.push(data);
        UI.showFileComplete(data);
        break;

      case 'chat':
        UI.addChatMessage(data.displayName, data.message, false);
        break;

      case 'cancel':
        UI.showToast('Transfer cancelled by sender', 'warn');
        UI.resetProgress();
        break;
    }
  }

  _onPeerState(peerId, state) {
    console.log(`[Peer ${peerId}] State: ${state}`);
    if (state === 'data-open') {
      const peer = this.peers.get(peerId);
      if (peer) {
        peer.connected = true;
        UI.setPeerConnected(peerId, true);
      }
    } else if (state === 'failed' || state === 'disconnected') {
      UI.setPeerConnected(peerId, false);
    }
  }

  // ─── ACTIONS ───────────────────────────────────────────────
  createRoom(displayName, password) {
    this.displayName = displayName || 'Anonymous';
    this.connectSocket();
    this.socket.on('connect', () => {
      this.socket.emit('create-room', { displayName: this.displayName, password });
    });
  }

  joinRoom(roomId, displayName, password) {
    this.displayName = displayName || 'Anonymous';
    this.connectSocket();
    this.socket.on('connect', () => {
      this.socket.emit('join-room', {
        roomId: roomId.toUpperCase().trim(),
        displayName: this.displayName,
        password
      });
    });
  }

  async sendFiles(files) {
    if (this.peers.size === 0) {
      UI.showToast('No peers connected yet. Share the room code first!', 'warn');
      return;
    }

    for (const file of files) {
      this.transferQueue.push(file);
    }

    if (!this.isTransferring) {
      this._processQueue();
    }
  }

  async _processQueue() {
    if (this.transferQueue.length === 0) {
      this.isTransferring = false;
      UI.resetSendProgress();
      return;
    }

    this.isTransferring = true;
    const file = this.transferQueue.shift();

    // Notify peers via socket (for UI preview)
    this.socket.emit('file-meta', {
      roomId: this.roomId,
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type
    });

    UI.showSendingFile(file);

    try {
      await this.connManager.broadcastFile(file, (progress, sent, total) => {
        UI.updateSendProgress(progress, sent, total, file.name);
      });

      this.socket.emit('file-complete', { roomId: this.roomId, fileName: file.name });
      UI.showToast(`"${file.name}" sent successfully!`, 'success');
    } catch (e) {
      UI.showToast(`Failed to send "${file.name}"`, 'error');
      console.error(e);
    }

    // Process next file
    setTimeout(() => this._processQueue(), 500);
  }

  sendChat(message) {
    if (!message.trim()) return;

    // Send via DataChannel to all peers
    this.connManager?.broadcastChat(message, this.displayName);

    // Also via socket for reliability
    this.socket.emit('chat-message', {
      roomId: this.roomId,
      message,
      displayName: this.displayName
    });

    UI.addChatMessage(this.displayName, message, true);
  }

  // ─── PAGE INITS ────────────────────────────────────────────
  initLanding() {
    // Landing page handlers
    const sendBtn = document.getElementById('btn-send');
    const receiveBtn = document.getElementById('btn-receive');
    const joinBtn = document.getElementById('btn-join');
    const roomInput = document.getElementById('room-code-input');
    const createRoomBtn = document.getElementById('btn-create-room');

    sendBtn?.addEventListener('click', () => {
      window.location.href = 'pages/send.html';
    });

    receiveBtn?.addEventListener('click', () => {
      window.location.href = 'pages/receive.html';
    });

    joinBtn?.addEventListener('click', () => {
      const code = roomInput?.value?.trim();
      if (code) window.location.href = `pages/room.html?room=${code.toUpperCase()}`;
    });

    roomInput?.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') joinBtn?.click();
    });

    createRoomBtn?.addEventListener('click', () => {
      window.location.href = 'pages/send.html';
    });
  }

  initSendPage() {
    UI.initSendPage(this);
  }

  initReceivePage() {
    UI.initReceivePage(this);
  }

  initRoomPage(roomId) {
    UI.initRoomPage(this, roomId);
  }
}

// ─── UI Manager ────────────────────────────────────────────────
const UI = {
  showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    if (!toast) return;

    const colors = {
      success: '#00FF88',
      error: '#FF4444',
      warn: '#FFAA00',
      info: '#00BBFF'
    };

    toast.textContent = message;
    toast.style.borderColor = colors[type] || colors.info;
    toast.style.color = colors[type] || colors.info;
    toast.classList.add('show');

    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => toast.classList.remove('show'), 3500);
  },

  showRoom(roomId, displayName) {
    document.getElementById('overlay-loading')?.classList.add('hidden');
    document.getElementById('room-ui')?.classList.remove('hidden');

    const el = document.getElementById('display-room-id');
    if (el) el.textContent = roomId;

    const link = `${window.location.origin}/pages/room.html?room=${roomId}`;
    const linkEl = document.getElementById('share-link');
    if (linkEl) linkEl.value = link;
  },

  generateQR(roomId) {
    const qrEl = document.getElementById('qr-container');
    if (!qrEl) return;

    const link = `${window.location.origin}/pages/room.html?room=${roomId}`;
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(link)}&bgcolor=000000&color=00FF88&margin=10`;

    qrEl.innerHTML = `<img src="${qrUrl}" alt="QR Code" style="width:160px;height:160px;border:1px solid rgba(0,255,136,0.3)">`;
  },

  updatePeerCount(count) {
    const el = document.getElementById('peer-count');
    if (el) el.textContent = count;
  },

  addPeer(peerId, displayName) {
    const list = document.getElementById('peer-list');
    if (!list) return;

    const item = document.createElement('div');
    item.id = `peer-${peerId}`;
    item.className = 'peer-item';
    item.innerHTML = `
      <span class="peer-dot" id="dot-${peerId}"></span>
      <span class="peer-name">${displayName}</span>
      <span class="peer-status" id="status-${peerId}">connecting...</span>
    `;
    list.appendChild(item);
  },

  removePeer(peerId) {
    document.getElementById(`peer-${peerId}`)?.remove();
  },

  setPeerConnected(peerId, connected) {
    const dot = document.getElementById(`dot-${peerId}`);
    const status = document.getElementById(`status-${peerId}`);
    if (dot) dot.className = `peer-dot ${connected ? 'connected' : ''}`;
    if (status) status.textContent = connected ? 'ready' : 'disconnected';
  },

  showSendingFile(file) {
    const el = document.getElementById('sending-filename');
    if (el) el.textContent = file.name;

    document.getElementById('send-progress-wrap')?.classList.remove('hidden');
  },

  updateSendProgress(progress, sent, total, name) {
    const bar = document.getElementById('send-progress-bar');
    const pct = document.getElementById('send-progress-pct');
    const speed = document.getElementById('send-speed');

    if (bar) bar.style.width = `${Math.round(progress * 100)}%`;
    if (pct) pct.textContent = `${Math.round(progress * 100)}%`;
    if (speed) speed.textContent = `${formatBytes(sent)} / ${formatBytes(total)}`;
  },

  resetSendProgress() {
    const bar = document.getElementById('send-progress-bar');
    if (bar) bar.style.width = '0%';
    document.getElementById('send-progress-wrap')?.classList.add('hidden');
  },

  showIncomingFile(data) {
    document.getElementById('recv-progress-wrap')?.classList.remove('hidden');
    const el = document.getElementById('recv-filename');
    if (el) el.textContent = data.name;
    this.updateReceiveProgress(0, 0, data.size);
  },

  updateReceiveProgress(progress, received, total) {
    const bar = document.getElementById('recv-progress-bar');
    const pct = document.getElementById('recv-progress-pct');
    const speed = document.getElementById('recv-speed');

    if (bar) bar.style.width = `${Math.round(progress * 100)}%`;
    if (pct) pct.textContent = `${Math.round(progress * 100)}%`;
    if (speed) speed.textContent = `${formatBytes(received)} / ${formatBytes(total)}`;
  },

  resetProgress() {
    document.getElementById('recv-progress-wrap')?.classList.add('hidden');
  },

  showFileComplete(data) {
    const list = document.getElementById('received-files');
    if (!list) return;

    list.classList.remove('hidden');

    const item = document.createElement('div');
    item.className = 'received-file-item';

    const icon = getFileIcon(data.fileType);
    const url = URL.createObjectURL(data.blob);
    const isPreviewable = data.fileType?.startsWith('image/') ||
      data.fileType?.startsWith('video/') ||
      data.fileType?.startsWith('audio/');

    item.innerHTML = `
      <div class="file-icon">${icon}</div>
      <div class="file-info">
        <span class="file-name">${data.name}</span>
        <span class="file-size">${formatBytes(data.blob.size)}</span>
      </div>
      <div class="file-actions">
        ${isPreviewable ? `<button class="btn-preview" onclick="showPreview('${url}','${data.fileType}','${data.name}')">Preview</button>` : ''}
        <a href="${url}" download="${data.name}" class="btn-download">Download</a>
      </div>
    `;

    list.prepend(item);

    this.updateReceiveProgress(1, data.blob.size, data.blob.size);
    this.showToast(`"${data.name}" received!`, 'success');

    // Auto-preview images
    if (data.fileType?.startsWith('image/')) {
      showPreview(url, data.fileType, data.name);
    }
  },

  addChatMessage(name, message, isMine) {
    const chat = document.getElementById('chat-messages');
    if (!chat) return;

    const msg = document.createElement('div');
    msg.className = `chat-msg ${isMine ? 'mine' : 'theirs'}`;
    msg.innerHTML = `
      <span class="chat-name">${isMine ? 'You' : name}</span>
      <span class="chat-text">${escapeHtml(message)}</span>
    `;
    chat.appendChild(msg);
    chat.scrollTop = chat.scrollHeight;
  },

  initSendPage(app) {
    const nameInput = document.getElementById('display-name');
    const passInput = document.getElementById('room-password');
    const createBtn = document.getElementById('btn-create');

    createBtn?.addEventListener('click', () => {
      const name = nameInput?.value || 'Anonymous';
      const pass = passInput?.value || null;
      document.getElementById('overlay-loading')?.classList.remove('hidden');
      app.createRoom(name, pass);
    });

    this._setupDropzone(app);
    this._setupChat(app);
    this._setupCopyLink();
  },

  initReceivePage(app) {
    const nameInput = document.getElementById('display-name');
    const codeInput = document.getElementById('room-code');
    const passInput = document.getElementById('room-password');
    const joinBtn = document.getElementById('btn-join');

    joinBtn?.addEventListener('click', () => {
      const name = nameInput?.value || 'Anonymous';
      const code = codeInput?.value?.toUpperCase()?.trim();
      const pass = passInput?.value || null;

      if (!code) {
        this.showToast('Enter a room code!', 'error');
        return;
      }

      document.getElementById('overlay-loading')?.classList.remove('hidden');
      app.joinRoom(code, name, pass);
    });

    this._setupDropzone(app);
    this._setupChat(app);
    this._setupCopyLink();
  },

  initRoomPage(app, roomId) {
    // Check if joining or creating
    const params = new URLSearchParams(window.location.search);
    const isHost = params.get('host') === '1';

    if (isHost || !roomId) {
      app.createRoom('Anonymous', null);
    } else {
      const name = localStorage.getItem('zappit_name') || 'Anonymous';
      app.joinRoom(roomId, name, null);
    }

    this._setupDropzone(app);
    this._setupChat(app);
    this._setupCopyLink();
  },

  _setupDropzone(app) {
    const zone = document.getElementById('dropzone');
    const fileInput = document.getElementById('file-input');

    if (!zone) return;

    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      zone.classList.add('drag-over');
    });

    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));

    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      const files = Array.from(e.dataTransfer.files);
      app.sendFiles(files);
    });

    zone.addEventListener('click', () => fileInput?.click());

    fileInput?.addEventListener('change', (e) => {
      const files = Array.from(e.target.files);
      app.sendFiles(files);
      e.target.value = '';
    });
  },

  _setupChat(app) {
    const input = document.getElementById('chat-input');
    const btn = document.getElementById('chat-send');

    const send = () => {
      const msg = input?.value?.trim();
      if (msg) {
        app.sendChat(msg);
        input.value = '';
      }
    };

    btn?.addEventListener('click', send);
    input?.addEventListener('keypress', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });
  },

  _setupCopyLink() {
    const copyBtn = document.getElementById('btn-copy-link');
    const linkInput = document.getElementById('share-link');

    copyBtn?.addEventListener('click', () => {
      const link = linkInput?.value;
      if (link) {
        navigator.clipboard.writeText(link).then(() => {
          this.showToast('Link copied!', 'success');
        });
      }
    });

    const copyCode = document.getElementById('btn-copy-code');
    copyCode?.addEventListener('click', () => {
      const code = document.getElementById('display-room-id')?.textContent;
      if (code) {
        navigator.clipboard.writeText(code).then(() => {
          this.showToast('Code copied!', 'success');
        });
      }
    });
  }
};

// ─── Preview Modal ──────────────────────────────────────────────
window.showPreview = function(url, type, name) {
  const modal = document.getElementById('preview-modal');
  const content = document.getElementById('preview-content');
  const title = document.getElementById('preview-title');

  if (!modal || !content) return;

  title.textContent = name;
  content.innerHTML = '';

  if (type.startsWith('image/')) {
    content.innerHTML = `<img src="${url}" style="max-width:100%;max-height:70vh;object-fit:contain">`;
  } else if (type.startsWith('video/')) {
    content.innerHTML = `<video src="${url}" controls style="max-width:100%;max-height:70vh"></video>`;
  } else if (type.startsWith('audio/')) {
    content.innerHTML = `<audio src="${url}" controls style="width:100%"></audio>`;
  } else if (type === 'application/pdf') {
    content.innerHTML = `<iframe src="${url}" style="width:100%;height:70vh;border:none"></iframe>`;
  }

  modal.classList.remove('hidden');
};

window.closePreview = function() {
  document.getElementById('preview-modal')?.classList.add('hidden');
};

// ─── Helpers ────────────────────────────────────────────────────
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function getFileIcon(type) {
  if (!type) return '📄';
  if (type.startsWith('image/')) return '🖼️';
  if (type.startsWith('video/')) return '🎥';
  if (type.startsWith('audio/')) return '🎵';
  if (type === 'application/pdf') return '📕';
  if (type.includes('zip') || type.includes('rar')) return '📦';
  if (type.includes('text')) return '📝';
  return '📄';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(str));
  return div.innerHTML;
}

// ─── Boot ───────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  window.zappit = new TryZappit();
});
