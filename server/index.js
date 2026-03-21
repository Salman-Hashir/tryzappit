const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  maxHttpBufferSize: 1e6 // 1MB for signaling only
});

app.use(cors());
app.use(express.json());

// Room storage (in-memory, no DB)
const rooms = new Map();
// { roomId: { peers: Map<socketId, peerInfo>, password: null|string, createdAt, hostId } }

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'TryZappit Signaling Server Running',
    rooms: rooms.size,
    timestamp: new Date().toISOString()
  });
});

// Generate room code
app.get('/create-room', (req, res) => {
  const roomId = generateRoomCode();
  res.json({ roomId });
});

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  // ─── CREATE ROOM ───────────────────────────────────────────
  socket.on('create-room', ({ displayName, password }) => {
    const roomId = generateRoomCode();

    rooms.set(roomId, {
      peers: new Map([[socket.id, {
        id: socket.id,
        displayName: displayName || 'Anonymous',
        isHost: true,
        joinedAt: Date.now()
      }]]),
      password: password || null,
      createdAt: Date.now(),
      hostId: socket.id
    });

    socket.join(roomId);
    socket.roomId = roomId;

    socket.emit('room-created', {
      roomId,
      peerId: socket.id,
      peers: []
    });

    console.log(`[Room] Created: ${roomId} by ${socket.id}`);
  });

  // ─── JOIN ROOM ─────────────────────────────────────────────
  socket.on('join-room', ({ roomId, displayName, password }) => {
    const room = rooms.get(roomId);

    if (!room) {
      socket.emit('error', { message: 'Room not found. Check your code and try again.' });
      return;
    }

    if (room.password && room.password !== password) {
      socket.emit('error', { message: 'Wrong password. Try again.' });
      return;
    }

    if (room.peers.size >= 10) {
      socket.emit('error', { message: 'Room is full (max 10 peers).' });
      return;
    }

    const existingPeers = Array.from(room.peers.values());

    room.peers.set(socket.id, {
      id: socket.id,
      displayName: displayName || 'Anonymous',
      isHost: false,
      joinedAt: Date.now()
    });

    socket.join(roomId);
    socket.roomId = roomId;

    // Tell the new peer about existing peers
    socket.emit('room-joined', {
      roomId,
      peerId: socket.id,
      peers: existingPeers
    });

    // Tell existing peers about the new peer
    socket.to(roomId).emit('peer-joined', {
      peerId: socket.id,
      displayName: displayName || 'Anonymous'
    });

    console.log(`[Room] ${socket.id} joined ${roomId} (${room.peers.size} peers)`);
  });

  // ─── WEBRTC SIGNALING ──────────────────────────────────────
  socket.on('offer', ({ targetId, offer }) => {
    socket.to(targetId).emit('offer', {
      fromId: socket.id,
      offer
    });
  });

  socket.on('answer', ({ targetId, answer }) => {
    socket.to(targetId).emit('answer', {
      fromId: socket.id,
      answer
    });
  });

  socket.on('ice-candidate', ({ targetId, candidate }) => {
    socket.to(targetId).emit('ice-candidate', {
      fromId: socket.id,
      candidate
    });
  });

  // ─── CHAT ──────────────────────────────────────────────────
  socket.on('chat-message', ({ roomId, message, displayName }) => {
    const room = rooms.get(roomId);
    if (!room || !room.peers.has(socket.id)) return;

    // Relay to everyone in room including sender
    io.to(roomId).emit('chat-message', {
      fromId: socket.id,
      displayName,
      message,
      timestamp: Date.now()
    });
  });

  // ─── FILE METADATA (for preview UI) ───────────────────────
  socket.on('file-meta', ({ roomId, fileName, fileSize, fileType }) => {
    socket.to(roomId).emit('file-meta', {
      fromId: socket.id,
      fileName,
      fileSize,
      fileType
    });
  });

  socket.on('file-complete', ({ roomId, fileName }) => {
    socket.to(roomId).emit('file-complete', {
      fromId: socket.id,
      fileName
    });
  });

  // ─── DISCONNECT ────────────────────────────────────────────
  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    room.peers.delete(socket.id);

    // Notify others
    socket.to(roomId).emit('peer-left', { peerId: socket.id });

    // Clean up empty rooms
    if (room.peers.size === 0) {
      rooms.delete(roomId);
      console.log(`[Room] Deleted empty room: ${roomId}`);
    }

    console.log(`[-] Disconnected: ${socket.id} from room ${roomId}`);
  });
});

// Clean up stale rooms every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms.entries()) {
    if (now - room.createdAt > 60 * 60 * 1000) { // 1 hour
      rooms.delete(roomId);
      console.log(`[Cleanup] Removed stale room: ${roomId}`);
    }
  }
}, 10 * 60 * 1000);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`✅ TryZappit Signaling Server running on port ${PORT}`);
});
