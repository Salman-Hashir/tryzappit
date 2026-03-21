// ─── TryZappit WebRTC P2P Manager ─────────────────────────────
const CHUNK_SIZE = 16 * 1024; // 16KB chunks

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
  ]
};

class PeerConnection {
  constructor(peerId, socket, onDataCallback, onStateCallback) {
    this.peerId = peerId;
    this.socket = socket;
    this.onDataCallback = onDataCallback;
    this.onStateCallback = onStateCallback;
    this.pc = new RTCPeerConnection(ICE_SERVERS);
    this.dataChannel = null;
    this.incomingFile = null;
    this.receivedChunks = [];
    this.receivedSize = 0;
    this._setupPeerConnection();
  }

  _setupPeerConnection() {
    this.pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.socket.emit('ice-candidate', { targetId: this.peerId, candidate: e.candidate });
      }
    };
    this.pc.onconnectionstatechange = () => {
      console.log('[PC] ' + this.peerId + ' state: ' + this.pc.connectionState);
      this.onStateCallback(this.peerId, this.pc.connectionState);
    };
    this.pc.ondatachannel = (e) => {
      console.log('[DC] Received data channel from ' + this.peerId);
      this._setupDataChannel(e.channel);
    };
  }

  createDataChannel() {
    this.dataChannel = this.pc.createDataChannel('filetransfer', { ordered: true });
    this._setupDataChannel(this.dataChannel);
  }

  _setupDataChannel(channel) {
    this.dataChannel = channel;
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => {
      console.log('[DC] Open with ' + this.peerId);
      this.onStateCallback(this.peerId, 'data-open');
    };
    channel.onclose = () => this.onStateCallback(this.peerId, 'data-closed');
    channel.onerror = (e) => console.error('[DC] Error:', e);
    channel.onmessage = (e) => this._handleIncoming(e.data);
  }

  _handleIncoming(data) {
    if (typeof data === 'string') {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'file-start') {
          this.incomingFile = { name: msg.name, size: msg.size, fileType: msg.fileType };
          this.receivedChunks = [];
          this.receivedSize = 0;
          this.onDataCallback({ type: 'file-start', ...this.incomingFile, fromId: this.peerId });
        } else if (msg.type === 'file-end') {
          const blob = new Blob(this.receivedChunks, { type: this.incomingFile?.fileType || 'application/octet-stream' });
          this.onDataCallback({ type: 'file-complete', blob, name: this.incomingFile?.name || 'file', fileType: this.incomingFile?.fileType || '', fromId: this.peerId });
          this.incomingFile = null; this.receivedChunks = []; this.receivedSize = 0;
        } else if (msg.type === 'chat') {
          this.onDataCallback({ type: 'chat', ...msg, fromId: this.peerId });
        }
      } catch(e) { console.error('[DC] Parse error:', e); }
    } else if (data instanceof ArrayBuffer) {
      this.receivedChunks.push(data);
      this.receivedSize += data.byteLength;
      if (this.incomingFile) {
        this.onDataCallback({ type: 'file-progress', progress: Math.min(this.receivedSize / this.incomingFile.size, 1), received: this.receivedSize, total: this.incomingFile.size, fromId: this.peerId });
      }
    }
  }

  async sendFile(file, onProgress) {
    return new Promise(async (resolve, reject) => {
      if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
        reject(new Error('Data channel not open')); return;
      }
      this.dataChannel.send(JSON.stringify({ type: 'file-start', name: file.name, size: file.size, fileType: file.type || 'application/octet-stream' }));
      let offset = 0;
      const sendChunk = async () => {
        if (offset >= file.size) { this.dataChannel.send(JSON.stringify({ type: 'file-end' })); resolve(); return; }
        if (this.dataChannel.bufferedAmount > 1024 * 1024) { setTimeout(sendChunk, 50); return; }
        const slice = file.slice(offset, offset + CHUNK_SIZE);
        const buffer = await slice.arrayBuffer();
        this.dataChannel.send(buffer);
        offset += buffer.byteLength;
        onProgress && onProgress(Math.min(offset / file.size, 1), offset, file.size);
        setTimeout(sendChunk, 0);
      };
      sendChunk();
    });
  }

  sendChat(message, displayName) {
    if (this.dataChannel && this.dataChannel.readyState === 'open') {
      this.dataChannel.send(JSON.stringify({ type: 'chat', message, displayName, timestamp: Date.now() }));
      return true;
    }
    return false;
  }

  async createOffer() {
    this.createDataChannel();
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    return offer;
  }

  async handleOffer(offer) {
    await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return answer;
  }

  async handleAnswer(answer) {
    if (this.pc.signalingState !== 'stable') {
      await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
    }
  }

  async addIceCandidate(candidate) {
    try {
      if (this.pc.remoteDescription) await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch(e) { console.warn('[ICE] Error:', e.message); }
  }

  close() {
    try { if (this.dataChannel) this.dataChannel.close(); this.pc.close(); } catch(e) {}
  }
}

class ConnectionManager {
  constructor(socket, onData, onState) {
    this.socket = socket;
    this.onData = onData;
    this.onState = onState;
    this.peers = new Map();
    this._pending = new Map();
  }

  async connectTo(peerId) {
    console.log('[CM] Connecting to:', peerId);
    const peer = new PeerConnection(peerId, this.socket, this.onData, this.onState);
    this.peers.set(peerId, peer);
    const offer = await peer.createOffer();
    this.socket.emit('offer', { targetId: peerId, offer });
    return peer;
  }

  async handleOffer(fromId, offer) {
    console.log('[CM] Offer from:', fromId);
    const peer = new PeerConnection(fromId, this.socket, this.onData, this.onState);
    this.peers.set(fromId, peer);
    const answer = await peer.handleOffer(offer);
    this.socket.emit('answer', { targetId: fromId, answer });
    const buffered = this._pending.get(fromId) || [];
    for (const c of buffered) await peer.addIceCandidate(c);
    this._pending.delete(fromId);
    return peer;
  }

  async handleAnswer(fromId, answer) {
    const peer = this.peers.get(fromId);
    if (peer) {
      await peer.handleAnswer(answer);
      const buffered = this._pending.get(fromId) || [];
      for (const c of buffered) await peer.addIceCandidate(c);
      this._pending.delete(fromId);
    }
  }

  async handleIceCandidate(fromId, candidate) {
    const peer = this.peers.get(fromId);
    if (peer && peer.pc.remoteDescription) {
      await peer.addIceCandidate(candidate);
    } else {
      if (!this._pending.has(fromId)) this._pending.set(fromId, []);
      this._pending.get(fromId).push(candidate);
    }
  }

  removePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (peer) { peer.close(); this.peers.delete(peerId); }
  }

  async broadcastFile(file, onProgress) {
    const peers = Array.from(this.peers.values());
    if (peers.length === 0) throw new Error('No peers connected');
    for (const peer of peers) await peer.sendFile(file, onProgress);
  }

  broadcastChat(message, displayName) {
    let sent = false;
    for (const peer of this.peers.values()) if (peer.sendChat(message, displayName)) sent = true;
    return sent;
  }

  getPeerCount() { return this.peers.size; }
  closeAll() { for (const peer of this.peers.values()) peer.close(); this.peers.clear(); }
}

window.ConnectionManager = ConnectionManager;
