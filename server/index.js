const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

// Disable X-Powered-By header to obscure tech stack
app.disable('x-powered-by');

// Security headers middleware
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Configure CORS securely
const allowedOrigins = [
  'https://tryzappit.vercel.app',
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:5000',
  'http://localhost:5173',
  'http://localhost:8080',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5500'
];

app.use(cors({
  origin: (origin, callback) => {
    // Allow non-browser requests or any subdomains on vercel.app
    if (!origin || allowedOrigins.includes(origin) || origin.endsWith('.vercel.app')) {
      return callback(null, true);
    }
    return callback(null, true); // Allow all web clients for public P2P file sharing
  },
  methods: ['GET', 'POST']
}));

app.use(express.json({ limit: '10kb' })); // Limit body payload

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  maxHttpBufferSize: 1e5 // 100KB max for signaling messages
});

// Rate limiting map: ip -> { count, resetTime }
const rateLimitMap = new Map();
function isRateLimited(ip, maxRequests = 40, windowMs = 60000) {
  const now = Date.now();
  const record = rateLimitMap.get(ip) || { count: 0, resetTime: now + windowMs };
  if (now > record.resetTime) {
    record.count = 1;
    record.resetTime = now + windowMs;
  } else {
    record.count++;
  }
  rateLimitMap.set(ip, record);
  return record.count > maxRequests;
}

// Clean rate limit map periodically
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of rateLimitMap.entries()) {
    if (now > record.resetTime) {
      rateLimitMap.delete(ip);
    }
  }
}, 5 * 60 * 1000);

// Room storage (in-memory)
// { roomId: { peers: Map<socketId, peerInfo>, password: null|string, createdAt, hostId } }
const rooms = new Map();
const MAX_CONCURRENT_ROOMS = 1000;

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'TryZappit Signaling Server Running',
    rooms: rooms.size,
    timestamp: new Date().toISOString()
  });
});

// Generate room code API
app.get('/create-room', (req, res) => {
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (isRateLimited(clientIp, 30, 60000)) {
    return res.status(429).json({ error: 'Too many requests. Please try again in a minute.' });
  }

  const roomId = generateRoomCode();
  res.json({ roomId });
});

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  let attempts = 0;
  do {
    code = '';
    for (let i = 0; i < 6; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    attempts++;
  } while (rooms.has(code) && attempts < 100);
  return code;
}

// Constant-time password verification to prevent timing attacks
function verifyPassword(storedPassword, providedPassword) {
  if (!storedPassword) return true;
  if (!providedPassword || typeof providedPassword !== 'string') return false;
  const bufA = Buffer.from(storedPassword);
  const bufB = Buffer.from(providedPassword);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Helper to leave previous room
function leaveCurrentRoom(socket) {
  const prevRoomId = socket.roomId;
  if (!prevRoomId) return;

  const room = rooms.get(prevRoomId);
  if (room) {
    room.peers.delete(socket.id);
    socket.to(prevRoomId).emit('peer-left', { peerId: socket.id });
    if (room.peers.size === 0) {
      rooms.delete(prevRoomId);
    }
  }
  socket.leave(prevRoomId);
  socket.roomId = null;
}

io.on('connection', (socket) => {
  const clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;

  // ─── CREATE ROOM ───────────────────────────────────────────
  socket.on('create-room', (payload = {}) => {
    try {
      if (rooms.size >= MAX_CONCURRENT_ROOMS) {
        socket.emit('error', { message: 'Server is currently at capacity. Please try again soon.' });
        return;
      }

      leaveCurrentRoom(socket);

      const displayName = typeof payload.displayName === 'string'
        ? payload.displayName.trim().slice(0, 30) || 'Anonymous'
        : 'Anonymous';

      const password = (typeof payload.password === 'string' && payload.password.length > 0)
        ? payload.password.slice(0, 64)
        : null;

      const roomId = generateRoomCode();

      rooms.set(roomId, {
        peers: new Map([[socket.id, {
          id: socket.id,
          displayName,
          isHost: true,
          joinedAt: Date.now()
        }]]),
        password,
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
    } catch(err) {
      console.error('[Create-Room Error]:', err);
      socket.emit('error', { message: 'Failed to create room. Please try again.' });
    }
  });

  // ─── JOIN ROOM ─────────────────────────────────────────────
  socket.on('join-room', (payload = {}) => {
    try {
      if (!payload.roomId || typeof payload.roomId !== 'string') {
        socket.emit('error', { message: 'Invalid room code.' });
        return;
      }

      const roomId = payload.roomId.toUpperCase().trim().slice(0, 6);
      const room = rooms.get(roomId);

      if (!room) {
        socket.emit('error', { message: 'Room not found. Check your code and try again.' });
        return;
      }

      const password = typeof payload.password === 'string' ? payload.password : '';
      if (room.password && !verifyPassword(room.password, password)) {
        socket.emit('error', { message: 'Wrong password. Try again.' });
        return;
      }

      if (room.peers.size >= 10) {
        socket.emit('error', { message: 'Room is full (max 10 peers).' });
        return;
      }

      leaveCurrentRoom(socket);

      const displayName = typeof payload.displayName === 'string'
        ? payload.displayName.trim().slice(0, 30) || 'Anonymous'
        : 'Anonymous';

      const existingPeers = Array.from(room.peers.values());

      room.peers.set(socket.id, {
        id: socket.id,
        displayName,
        isHost: false,
        joinedAt: Date.now()
      });

      socket.join(roomId);
      socket.roomId = roomId;

      socket.emit('room-joined', {
        roomId,
        peerId: socket.id,
        peers: existingPeers
      });

      socket.to(roomId).emit('peer-joined', {
        peerId: socket.id,
        displayName
      });

      console.log(`[Room] ${socket.id} joined ${roomId} (${room.peers.size} peers)`);
    } catch(err) {
      console.error('[Join-Room Error]:', err);
      socket.emit('error', { message: 'Failed to join room.' });
    }
  });

  // ─── WEBRTC SIGNALING (With Cross-Room Authorization Checks) ───
  socket.on('offer', ({ targetId, offer } = {}) => {
    if (!targetId || !offer || !socket.roomId) return;
    const room = rooms.get(socket.roomId);
    // Security check: Verify target is a member of the caller's room
    if (!room || !room.peers.has(targetId) || !room.peers.has(socket.id)) return;

    socket.to(targetId).emit('offer', {
      fromId: socket.id,
      offer
    });
  });

  socket.on('answer', ({ targetId, answer } = {}) => {
    if (!targetId || !answer || !socket.roomId) return;
    const room = rooms.get(socket.roomId);
    // Security check: Verify target is a member of the caller's room
    if (!room || !room.peers.has(targetId) || !room.peers.has(socket.id)) return;

    socket.to(targetId).emit('answer', {
      fromId: socket.id,
      answer
    });
  });

  socket.on('ice-candidate', ({ targetId, candidate } = {}) => {
    if (!targetId || !candidate || !socket.roomId) return;
    const room = rooms.get(socket.roomId);
    // Security check: Verify target is a member of the caller's room
    if (!room || !room.peers.has(targetId) || !room.peers.has(socket.id)) return;

    socket.to(targetId).emit('ice-candidate', {
      fromId: socket.id,
      candidate
    });
  });

  // ─── CHAT (With Room Verification & Sanitization) ──────────
  socket.on('chat-message', ({ roomId, message, displayName } = {}) => {
    if (!socket.roomId || socket.roomId !== roomId) return;
    const room = rooms.get(roomId);
    if (!room || !room.peers.has(socket.id)) return;

    if (!message || typeof message !== 'string') return;
    const sanitizedMsg = message.trim().slice(0, 1000);
    if (!sanitizedMsg) return;

    const safeDisplayName = typeof displayName === 'string'
      ? displayName.trim().slice(0, 30) || 'Anonymous'
      : 'Anonymous';

    io.to(roomId).emit('chat-message', {
      fromId: socket.id,
      displayName: safeDisplayName,
      message: sanitizedMsg,
      timestamp: Date.now()
    });
  });

  // ─── FILE METADATA RELAY ───────────────────────────────────
  socket.on('file-meta', ({ roomId, fileName, fileSize, fileType } = {}) => {
    if (!socket.roomId || socket.roomId !== roomId) return;
    const room = rooms.get(roomId);
    if (!room || !room.peers.has(socket.id)) return;

    socket.to(roomId).emit('file-meta', {
      fromId: socket.id,
      fileName: typeof fileName === 'string' ? fileName.slice(0, 255) : 'file',
      fileSize: typeof fileSize === 'number' ? fileSize : 0,
      fileType: typeof fileType === 'string' ? fileType.slice(0, 100) : ''
    });
  });

  socket.on('file-complete', ({ roomId, fileName } = {}) => {
    if (!socket.roomId || socket.roomId !== roomId) return;
    const room = rooms.get(roomId);
    if (!room || !room.peers.has(socket.id)) return;

    socket.to(roomId).emit('file-complete', {
      fromId: socket.id,
      fileName: typeof fileName === 'string' ? fileName.slice(0, 255) : 'file'
    });
  });

  // ─── DISCONNECT ────────────────────────────────────────────
  socket.on('disconnect', () => {
    leaveCurrentRoom(socket);
  });
});

// Periodic cleanup: Remove stale rooms older than 1 hour or empty rooms
setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms.entries()) {
    if (room.peers.size === 0 || now - room.createdAt > 60 * 60 * 1000) {
      rooms.delete(roomId);
      console.log(`[Cleanup] Removed stale/empty room: ${roomId}`);
    }
  }
}, 10 * 60 * 1000);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`✅ TryZappit Signaling Server running on port ${PORT}`);
});
