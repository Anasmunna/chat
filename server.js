const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Allowed users for private chat
const ALLOWED_USERS = {
  'rafee@12': '2632',
  'irfane@12': '2632'
};

// In-memory session and state stores
const sessions = new Map(); // token -> userId
const connectedUsers = new Map(); // userId -> socketId
const socketToUser = new Map(); // socketId -> userId
const profilePictures = new Map(); // userId -> dataURL string
const messages = []; // simple in-memory chat history

app.use(express.json({ limit: '5mb' }));
app.use(express.static('public'));

function normalizeUserId(value) {
  return String(value || '').trim().toLowerCase();
}

function createToken(userId) {
  const randomPart = Math.random().toString(36).slice(2);
  return `${userId}:${Date.now()}:${randomPart}`;
}

function getOtherUser(userId) {
  return Object.keys(ALLOWED_USERS).find((u) => u !== userId) || null;
}

function getOnlineStatusFor(userId) {
  const other = getOtherUser(userId);
  if (!other) return false;
  return connectedUsers.has(other);
}

// Login endpoint
app.post('/api/login', (req, res) => {
  const userId = normalizeUserId(req.body.userId);
  const password = String(req.body.password || '').trim();

  // Explicit invalid response requested by spec
  if (!ALLOWED_USERS[userId] || ALLOWED_USERS[userId] !== password) {
    return res.status(401).json({ success: false, message: 'Invalid Login' });
  }

  const token = createToken(userId);
  sessions.set(token, userId);

  return res.json({
    success: true,
    token,
    userId,
    profilePicture: profilePictures.get(userId) || null
  });
});

// Validate auth token for chat page bootstrap
app.get('/api/me', (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const userId = sessions.get(token);

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  return res.json({
    success: true,
    userId,
    profilePicture: profilePictures.get(userId) || null,
    otherOnline: getOnlineStatusFor(userId)
  });
});

io.on('connection', (socket) => {
  socket.on('join', ({ token }) => {
    const userId = sessions.get(String(token || ''));

    if (!userId) {
      socket.emit('joinError', { message: 'Unauthorized' });
      socket.disconnect(true);
      return;
    }

    const existingSocketId = connectedUsers.get(userId);
    if (existingSocketId && existingSocketId !== socket.id) {
      // Single live socket per user keeps online tracking clean
      io.to(existingSocketId).emit('forceLogout', {
        message: 'You logged in from another session.'
      });
      const oldSocket = io.sockets.sockets.get(existingSocketId);
      if (oldSocket) oldSocket.disconnect(true);
    }

    // Private chat: only two users can be connected simultaneously.
    // Since only two IDs are valid, this guards edge cases and enforces request.
    if (connectedUsers.size >= 2 && !connectedUsers.has(userId)) {
      socket.emit('joinError', { message: 'Chat is private' });
      socket.disconnect(true);
      return;
    }

    connectedUsers.set(userId, socket.id);
    socketToUser.set(socket.id, userId);
    socket.join('private-room');

    socket.emit('joined', {
      userId,
      messages,
      profilePicture: profilePictures.get(userId) || null,
      otherOnline: getOnlineStatusFor(userId)
    });

    const other = getOtherUser(userId);
    if (other && connectedUsers.has(other)) {
      io.to(connectedUsers.get(other)).emit('presence', {
        userId,
        online: true
      });
    }
  });

  socket.on('message', ({ token, text }) => {
    const userId = sessions.get(String(token || ''));
    if (!userId || connectedUsers.get(userId) !== socket.id) {
      socket.emit('joinError', { message: 'Unauthorized' });
      return;
    }

    const cleanText = String(text || '').trim();
    if (!cleanText) return;

    const payload = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sender: userId,
      text: cleanText,
      timestamp: Date.now()
    };

    messages.push(payload);

    io.to('private-room').emit('message', payload);
  });

  socket.on('profilePicture', ({ token, imageData }) => {
    const userId = sessions.get(String(token || ''));
    if (!userId || connectedUsers.get(userId) !== socket.id) {
      socket.emit('joinError', { message: 'Unauthorized' });
      return;
    }

    const image = String(imageData || '');
    const isDataImage = /^data:image\/(png|jpeg|jpg|webp|gif);base64,/.test(image);

    if (!isDataImage || image.length > 4_000_000) {
      socket.emit('profileError', { message: 'Invalid image' });
      return;
    }

    profilePictures.set(userId, image);

    io.to('private-room').emit('profileUpdated', {
      userId,
      imageData: image
    });
  });

  socket.on('disconnect', () => {
    const userId = socketToUser.get(socket.id);
    if (!userId) return;

    socketToUser.delete(socket.id);

    const knownSocketId = connectedUsers.get(userId);
    if (knownSocketId === socket.id) {
      connectedUsers.delete(userId);
    }

    const other = getOtherUser(userId);
    if (other && connectedUsers.has(other)) {
      io.to(connectedUsers.get(other)).emit('presence', {
        userId,
        online: false
      });
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
