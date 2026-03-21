// ─── TryZappit WebRTC P2P Manager ─────────────────────────────
// Handles peer connections, DataChannels, file chunking

const CHUNK_SIZE = 64 * 1024; // 64KB chunks
const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    // Optional: add TURN here for strict NAT fallback
    // { urls: 'turn:your-turn-server.com', username: '...', credential: '...' }
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

    // Incoming file assembly
    this.incomingFile = null;
    this.receivedChunks = [];
    this.receivedSize = 0;

    this._setupPeerConnection();
  }

  _setupPeerConnection() {
    // ICE candidate → send to remote via signaling
    this.pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.socket.emit('ice-candidate', {
          targetId: this.peerId,
          candidate: e.candidate
        });
      }
    };

    this.pc.onconnectionstatechange = () => {
      this.onStateCallback(this.peerId, this.pc.connectionState);
    };

    // Remote peer opened a DataChannel (receiver side)
    this.pc.ondatachannel = (e) => {
      this._setupDataChannel(e.channel);
    };
  }

  // Sender creates the data channel
  createDataChannel() {
    this.dataChannel = this.pc.createDataChannel('filetransfer', {
      ordered: true
    });
    this._setupDataChannel(this.dataChannel);
  }

  _setupDataChannel(channel) {
    this.dataChannel = channel;
    channel.binaryType = 'arraybuffer';

    channel.onopen = () => {
      console.log(`[DC] Open with ${this.peerId}`);
      this.onStateCallback(this.peerId, 'data-open');
    };

    channel.onclose = () => {
      this.onStateCallback(this.peerId, 'data-closed');
    };

    channel.onmessage = (e) => {
      this._handleIncoming(e.data);
    };
  }

  _handleIncoming(data) {
    // String = metadata/control message
    if (typeof data === 'string') {
      const msg = JSON.parse(data);

      if (msg.type === 'file-start') {
        this.incomingFile = {
          name: msg.name,
          size: msg.size,
          fileType: msg.fileType,
          totalChunks: msg.totalChunks
        };
        this.receivedChunks = [];
        this.receivedSize = 0;
        this.onDataCallback({ type: 'file-start', ...this.incomingFile, fromId: this.peerId });
      }

      else if (msg.type === 'file-end') {
        const blob = new Blob(this.receivedChunks, { type: this.incomingFile.fileType });
        this.onDataCallback({
          type: 'file-complete',
          blob,
          name: this.incomingFile.name,
          fileType: this.incomingFile.fileType,
          fromId: this.peerId
        });
        this.incomingFile = null;
        this.receivedChunks = [];
        this.receivedSize = 0;
      }

      else if (msg.type === 'chat') {
        this.onDataCallback({ type: 'chat', ...msg, fromId: this.peerId });
      }

      else if (msg.type === 'cancel') {
        this.incomingFile = null;
        this.receivedChunks = [];
        this.receivedSize = 0;
        this.onDataCallback({ type: 'cancel', fromId: this.peerId });
      }
    }

    // Binary = file chunk
    else if (data instanceof ArrayBuffer) {
      this.receivedChunks.push(data);
      this.receivedSize += data.byteLength;

      if (this.incomingFile) {
        const progress = this.receivedSize / this.incomingFile.size;
        this.onDataCallback({
          type: 'file-progress',
          progress,
          received: this.receivedSize,
          total: this.incomingFile.size,
          fromId: this.peerId
        });
      }
    }
  }

  // Send a file to this peer
  async sendFile(file, onProgress) {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
      throw new Error('Data channel not open');
    }

    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    // Send metadata
    this.dataChannel.send(JSON.stringify({
      type: 'file-start',
      name: file.name,
      size: file.size,
      fileType: file.type,
      totalChunks
    }));

    // Send chunks
    let offset = 0;
    let chunkIndex = 0;

    const sendNextChunk = () => {
      return new Promise((resolve) => {
        const slice = file.slice(offset, offset + CHUNK_SIZE);
        const reader = new FileReader();

        reader.onload = (e) => {
          // Wait if buffer is filling up
          const waitForDrain = () => {
            if (this.dataChannel.bufferedAmount > 16 * 1024 * 1024) {
              setTimeout(waitForDrain, 50);
            } else {
              this.dataChannel.send(e.target.result);
              offset += e.target.result.byteLength;
              chunkIndex++;
              onProgress && onProgress(offset / file.size, offset, file.size);
              resolve();
            }
          };
          waitForDrain();
        };

        reader.readAsArrayBuffer(slice);
      });
    };

    while (offset < file.size) {
      await sendNextChunk();
    }

    // Signal end
    this.dataChannel.send(JSON.stringify({ type: 'file-end' }));
  }

  // Send chat message
  sendChat(message, displayName) {
    if (this.dataChannel && this.dataChannel.readyState === 'open') {
      this.dataChannel.send(JSON.stringify({
        type: 'chat',
        message,
        displayName,
        timestamp: Date.now()
      }));
    }
  }

  // Create offer (initiator)
  async createOffer() {
    this.createDataChannel();
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    return offer;
  }

  // Handle incoming offer (receiver)
  async handleOffer(offer) {
    await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return answer;
  }

  // Handle incoming answer
  async handleAnswer(answer) {
    await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
  }

  // Add ICE candidate
  async addIceCandidate(candidate) {
    try {
      await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      console.warn('ICE candidate error:', e);
    }
  }

  close() {
    if (this.dataChannel) this.dataChannel.close();
    this.pc.close();
  }
}

// ─── Connection Manager ─────────────────────────────────────
class ConnectionManager {
  constructor(socket, onData, onState) {
    this.socket = socket;
    this.onData = onData;
    this.onState = onState;
    this.peers = new Map(); // peerId → PeerConnection
  }

  // Initiate connection to a peer (we are the offerer)
  async connectTo(peerId) {
    const peer = new PeerConnection(peerId, this.socket, this.onData, this.onState);
    this.peers.set(peerId, peer);

    const offer = await peer.createOffer();
    this.socket.emit('offer', { targetId: peerId, offer });
    return peer;
  }

  // Handle incoming offer from a peer
  async handleOffer(fromId, offer) {
    const peer = new PeerConnection(fromId, this.socket, this.onData, this.onState);
    this.peers.set(fromId, peer);

    const answer = await peer.handleOffer(offer);
    this.socket.emit('answer', { targetId: fromId, answer });
    return peer;
  }

  async handleAnswer(fromId, answer) {
    const peer = this.peers.get(fromId);
    if (peer) await peer.handleAnswer(answer);
  }

  async handleIceCandidate(fromId, candidate) {
    const peer = this.peers.get(fromId);
    if (peer) await peer.addIceCandidate(candidate);
  }

  removePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.close();
      this.peers.delete(peerId);
    }
  }

  // Send file to ALL peers
  async broadcastFile(file, onProgress) {
    const peerList = Array.from(this.peers.values());
    await Promise.all(peerList.map(peer => peer.sendFile(file, onProgress)));
  }

  // Send file to specific peer
  async sendFileTo(peerId, file, onProgress) {
    const peer = this.peers.get(peerId);
    if (peer) await peer.sendFile(file, onProgress);
  }

  // Broadcast chat to all
  broadcastChat(message, displayName) {
    for (const peer of this.peers.values()) {
      peer.sendChat(message, displayName);
    }
  }

  getPeerCount() {
    return this.peers.size;
  }

  closeAll() {
    for (const peer of this.peers.values()) {
      peer.close();
    }
    this.peers.clear();
  }
}

window.ConnectionManager = ConnectionManager;
