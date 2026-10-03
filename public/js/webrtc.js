// ─── TryZappit WebRTC P2P Manager ─────────────────────────────
const CHUNK_SIZE = 64 * 1024; // 64KB chunks (standard optimal for SCTP data channels)

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:openrelay.metered.ca:80' },
    // Free TURN servers to enable transfer across 4G/5G, symmetric NATs, and firewalls
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
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

    this.pc.oniceconnectionstatechange = () => {
      console.log('[ICE] ' + this.peerId + ' state: ' + this.pc.iceConnectionState);
      if (this.pc.iceConnectionState === 'failed') {
        try { this.pc.restartIce(); } catch(e) {}
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
    channel.bufferedAmountLowThreshold = 256 * 1024; // 256KB threshold for backpressure

    const notifyOpen = () => {
      console.log('[DC] Open with ' + this.peerId);
      this.onStateCallback(this.peerId, 'data-open');
    };

    // Fix: If channel is already open when ondatachannel triggers, onopen won't fire
    if (channel.readyState === 'open') {
      notifyOpen();
    } else {
      channel.onopen = notifyOpen;
    }

    channel.onclose = () => {
      console.log('[DC] Closed with ' + this.peerId);
      this.onStateCallback(this.peerId, 'data-closed');
    };

    channel.onerror = (e) => console.error('[DC] Error with ' + this.peerId + ':', e);
    channel.onmessage = (e) => this._handleIncoming(e.data);
  }

  async _handleIncoming(data) {
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
          this.onDataCallback({
            type: 'file-complete',
            blob,
            name: this.incomingFile?.name || 'file',
            fileType: this.incomingFile?.fileType || '',
            fromId: this.peerId
          });
          this.incomingFile = null;
          this.receivedChunks = [];
          this.receivedSize = 0;
        } else if (msg.type === 'chat') {
          this.onDataCallback({ type: 'chat', ...msg, fromId: this.peerId });
        }
      } catch(e) {
        console.error('[DC] Parse error:', e);
      }
    } else {
      // Support both ArrayBuffer and Blob (mobile browsers sometimes deliver Blob)
      let chunk = data;
      let size = 0;
      if (data instanceof Blob) {
        chunk = await data.arrayBuffer();
        size = chunk.byteLength;
      } else if (data instanceof ArrayBuffer) {
        size = data.byteLength;
      }

      if (size > 0) {
        this.receivedChunks.push(chunk);
        this.receivedSize += size;
        if (this.incomingFile) {
          this.onDataCallback({
            type: 'file-progress',
            progress: Math.min(this.receivedSize / (this.incomingFile.size || 1), 1),
            received: this.receivedSize,
            total: this.incomingFile.size,
            fromId: this.peerId
          });
        }
      }
    }
  }

  async sendFile(file, onProgress) {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
      throw new Error('Data channel not open with ' + this.peerId);
    }

    return new Promise((resolve, reject) => {
      const channel = this.dataChannel;

      try {
        channel.send(JSON.stringify({
          type: 'file-start',
          name: file.name,
          size: file.size,
          fileType: file.type || 'application/octet-stream'
        }));
      } catch(err) {
        return reject(err);
      }

      let offset = 0;
      const totalSize = file.size;

      const cleanup = () => {
        channel.removeEventListener('bufferedamountlow', sendNext);
        channel.removeEventListener('error', onError);
        channel.removeEventListener('close', onClose);
      };

      const onError = (e) => {
        cleanup();
        reject(new Error('Data channel error while sending file'));
      };

      const onClose = () => {
        cleanup();
        reject(new Error('Data channel closed unexpectedly'));
      };

      channel.addEventListener('error', onError);
      channel.addEventListener('close', onClose);

      const sendNext = async () => {
        try {
          if (channel.readyState !== 'open') {
            cleanup();
            return reject(new Error('Data channel closed mid-transfer'));
          }

          while (offset < totalSize) {
            // Apply backpressure if buffer exceeds 512KB
            if (channel.bufferedAmount > 512 * 1024) {
              channel.addEventListener('bufferedamountlow', sendNext, { once: true });
              return;
            }

            const slice = file.slice(offset, offset + CHUNK_SIZE);
            const buffer = await slice.arrayBuffer();

            if (channel.readyState !== 'open') {
              cleanup();
              return reject(new Error('Data channel closed mid-transfer'));
            }

            channel.send(buffer);
            offset += buffer.byteLength;

            if (onProgress) {
              onProgress(Math.min(offset / (totalSize || 1), 1), offset, totalSize);
            }
          }

          // File transfer complete
          channel.send(JSON.stringify({ type: 'file-end' }));
          cleanup();
          resolve();
        } catch (err) {
          cleanup();
          reject(err);
        }
      };

      sendNext();
    });
  }

  sendChat(message, displayName) {
    if (this.dataChannel && this.dataChannel.readyState === 'open') {
      try {
        this.dataChannel.send(JSON.stringify({ type: 'chat', message, displayName, timestamp: Date.now() }));
        return true;
      } catch(e) {
        return false;
      }
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
    await this.pc.setRemoteDescription(offer);
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return answer;
  }

  async handleAnswer(answer) {
    if (this.pc.signalingState !== 'stable') {
      await this.pc.setRemoteDescription(answer);
    }
  }

  async addIceCandidate(candidate) {
    if (!candidate) return;
    try {
      if (this.pc.remoteDescription) {
        await this.pc.addIceCandidate(candidate);
      }
    } catch(e) {
      console.warn('[ICE] Error adding candidate:', e.message);
    }
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
    if (!candidate) return;
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

  getReadyPeerCount() {
    let count = 0;
    for (const peer of this.peers.values()) {
      if (peer.dataChannel && peer.dataChannel.readyState === 'open') {
        count++;
      }
    }
    return count;
  }

  async broadcastFile(file, onProgress) {
    const readyPeers = Array.from(this.peers.values()).filter(
      p => p.dataChannel && p.dataChannel.readyState === 'open'
    );
    if (readyPeers.length === 0) {
      throw new Error('P2P connection is not established yet. Wait a moment and try again.');
    }
    for (const peer of readyPeers) {
      await peer.sendFile(file, onProgress);
    }
  }

  broadcastChat(message, displayName) {
    let sent = false;
    for (const peer of this.peers.values()) {
      if (peer.sendChat(message, displayName)) sent = true;
    }
    return sent;
  }

  getPeerCount() { return this.peers.size; }
  closeAll() { for (const peer of this.peers.values()) peer.close(); this.peers.clear(); }
}

window.ConnectionManager = ConnectionManager;
