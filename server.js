const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

/**
 * In-memory room store. No accounts, no persistence.
 *
 * room = {
 *   code, hostId, players: Map(socketId -> {id, name, score, connected}),
 *   phase: 'lobby' | 'submitting' | 'voting' | 'reveal' | 'round-end',
 *   settings: { scoringMode: 'none'|'correct'|'fooling'|'both', pointsCorrect, pointsFool },
 *   quotes: [{id, text, authorId}],
 *   currentQuoteIndex: number,
 *   votes: { [quoteId]: { [voterId]: targetId } },
 *   submittedBy: Set(socketId),
 *   roundNumber: number
 * }
 */
const rooms = new Map();

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I confusion
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function defaultSettings() {
  return { scoringMode: 'both', pointsCorrect: 100, pointsFool: 50 };
}

function publicPlayers(room) {
  return Array.from(room.players.values()).map((p) => ({
    id: p.id,
    name: p.name,
    score: p.score,
    connected: p.connected,
    isHost: p.id === room.hostId,
  }));
}

function currentQuote(room) {
  if (room.quotes.length === 0) return null;
  return room.quotes[room.currentQuoteIndex] || null;
}

function eligibleVoterIds(room, quote) {
  return Array.from(room.players.values())
    .filter((p) => p.connected && p.id !== quote.authorId)
    .map((p) => p.id);
}

function buildStateFor(room) {
  const quote = currentQuote(room);
  const base = {
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    settings: room.settings,
    players: publicPlayers(room),
    roundNumber: room.roundNumber,
    submittedCount: room.submittedBy.size,
    totalPlayers: room.players.size,
    quoteIndex: room.currentQuoteIndex,
    totalQuotes: room.quotes.length,
  };

  if (room.phase === 'voting' && quote) {
    const votesForQuote = room.votes[quote.id] || {};
    base.currentQuote = { id: quote.id, text: quote.text };
    base.votedCount = Object.keys(votesForQuote).length;
    base.eligibleVoters = eligibleVoterIds(room, quote).length;
  }

  if (room.phase === 'reveal' && quote) {
    const votesForQuote = room.votes[quote.id] || {};
    base.currentQuote = { id: quote.id, text: quote.text, authorId: quote.authorId };
    base.votes = votesForQuote;
  }

  return base;
}

function broadcast(room) {
  const state = buildStateFor(room);
  io.to(room.code).emit('room:state', state);
}

function getRoomBySocket(socket) {
  const code = socket.data.roomCode;
  if (!code) return null;
  return rooms.get(code) || null;
}

function resetForNewRound(room) {
  room.phase = 'submitting';
  room.quotes = [];
  room.votes = {};
  room.submittedBy = new Set();
  room.currentQuoteIndex = 0;
  room.roundNumber += 1;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function moveToVotingIfReady(room) {
  const connectedPlayers = Array.from(room.players.values()).filter((p) => p.connected);
  if (room.submittedBy.size >= connectedPlayers.length && connectedPlayers.length >= 2) {
    startVoting(room);
  }
}

function startVoting(room) {
  room.quotes = shuffle(room.quotes);
  room.currentQuoteIndex = 0;
  room.phase = room.quotes.length > 0 ? 'voting' : 'round-end';
}

function moveToRevealIfReady(room) {
  const quote = currentQuote(room);
  if (!quote) return;
  const votesForQuote = room.votes[quote.id] || {};
  const eligible = eligibleVoterIds(room, quote);
  if (eligible.length === 0 || Object.keys(votesForQuote).length >= eligible.length) {
    revealCurrentQuote(room);
  }
}

function revealCurrentQuote(room) {
  const quote = currentQuote(room);
  if (!quote) return;
  room.phase = 'reveal';
  const votesForQuote = room.votes[quote.id] || {};
  const author = room.players.get(quote.authorId);
  if (!author) return;

  const { scoringMode, pointsCorrect, pointsFool } = room.settings;
  let correctCount = 0;
  let wrongCount = 0;

  Object.entries(votesForQuote).forEach(([voterId, targetId]) => {
    const voter = room.players.get(voterId);
    if (!voter) return;
    if (targetId === quote.authorId) {
      correctCount += 1;
      if (scoringMode === 'correct' || scoringMode === 'both') {
        voter.score += pointsCorrect;
      }
    } else {
      wrongCount += 1;
    }
  });

  if (scoringMode === 'fooling' || scoringMode === 'both') {
    author.score += wrongCount * pointsFool;
  }

  quote._correctCount = correctCount;
  quote._wrongCount = wrongCount;
}

function advanceQuote(room) {
  if (room.currentQuoteIndex + 1 < room.quotes.length) {
    room.currentQuoteIndex += 1;
    room.phase = 'voting';
  } else {
    room.phase = 'round-end';
  }
}

io.on('connection', (socket) => {
  socket.on('host:create', ({ name }, cb) => {
    const code = makeCode();
    const room = {
      code,
      hostId: socket.id,
      players: new Map(),
      phase: 'lobby',
      settings: defaultSettings(),
      quotes: [],
      currentQuoteIndex: 0,
      votes: {},
      submittedBy: new Set(),
      roundNumber: 0,
    };
    room.players.set(socket.id, {
      id: socket.id,
      name: (name || 'Host').slice(0, 24),
      score: 0,
      connected: true,
    });
    rooms.set(code, room);
    socket.data.roomCode = code;
    socket.join(code);
    cb({ ok: true, code });
    broadcast(room);
  });

  socket.on('player:join', ({ code, name }, cb) => {
    const room = rooms.get((code || '').toUpperCase());
    if (!room) {
      cb({ ok: false, error: 'No room with that code.' });
      return;
    }
    if (room.players.size >= 16) {
      cb({ ok: false, error: 'Room is full.' });
      return;
    }
    room.players.set(socket.id, {
      id: socket.id,
      name: (name || 'Player').slice(0, 24),
      score: 0,
      connected: true,
    });
    socket.data.roomCode = room.code;
    socket.join(room.code);
    cb({ ok: true, code: room.code });
    broadcast(room);
  });

  socket.on('host:updateSettings', (settings) => {
    const room = getRoomBySocket(socket);
    if (!room || room.hostId !== socket.id) return;
    if (room.phase !== 'lobby' && room.phase !== 'round-end') return; // only between rounds
    const allowedModes = ['none', 'correct', 'fooling', 'both'];
    if (allowedModes.includes(settings.scoringMode)) {
      room.settings.scoringMode = settings.scoringMode;
    }
    if (Number.isFinite(settings.pointsCorrect)) {
      room.settings.pointsCorrect = Math.max(0, Math.min(1000, settings.pointsCorrect));
    }
    if (Number.isFinite(settings.pointsFool)) {
      room.settings.pointsFool = Math.max(0, Math.min(1000, settings.pointsFool));
    }
    broadcast(room);
  });

  socket.on('host:startRound', () => {
    const room = getRoomBySocket(socket);
    if (!room || room.hostId !== socket.id) return;
    if (room.phase !== 'lobby' && room.phase !== 'round-end') return;
    const connected = Array.from(room.players.values()).filter((p) => p.connected);
    if (connected.length < 2) return;
    resetForNewRound(room);
    broadcast(room);
  });

  socket.on('player:submitQuote', ({ text }) => {
    const room = getRoomBySocket(socket);
    if (!room || room.phase !== 'submitting') return;
    const player = room.players.get(socket.id);
    if (!player || !player.connected) return;
    if (room.submittedBy.has(socket.id)) return; // one quote per player
    const clean = (text || '').trim().slice(0, 300);
    if (!clean) return;
    room.quotes.push({ id: `${socket.id}-${Date.now()}`, text: clean, authorId: socket.id });
    room.submittedBy.add(socket.id);
    broadcast(room);
    moveToVotingIfReady(room);
    if (room.phase === 'voting') broadcast(room);
  });

  socket.on('host:forceStartVoting', () => {
    const room = getRoomBySocket(socket);
    if (!room || room.hostId !== socket.id) return;
    if (room.phase !== 'submitting') return;
    startVoting(room);
    broadcast(room);
  });

  socket.on('player:vote', ({ targetPlayerId }) => {
    const room = getRoomBySocket(socket);
    if (!room || room.phase !== 'voting') return;
    const quote = currentQuote(room);
    if (!quote) return;
    if (socket.id === quote.authorId) return; // author can't vote on own quote
    if (targetPlayerId === socket.id) return; // no self-vote
    if (!room.players.has(targetPlayerId)) return;
    if (!room.votes[quote.id]) room.votes[quote.id] = {};
    if (room.votes[quote.id][socket.id]) return; // one vote per player per quote
    room.votes[quote.id][socket.id] = targetPlayerId;
    broadcast(room);
    moveToRevealIfReady(room);
    if (room.phase === 'reveal') broadcast(room);
  });

  socket.on('host:forceReveal', () => {
    const room = getRoomBySocket(socket);
    if (!room || room.hostId !== socket.id) return;
    if (room.phase !== 'voting') return;
    revealCurrentQuote(room);
    broadcast(room);
  });

  socket.on('host:nextQuote', () => {
    const room = getRoomBySocket(socket);
    if (!room || room.hostId !== socket.id) return;
    if (room.phase !== 'reveal') return;
    advanceQuote(room);
    broadcast(room);
  });

  socket.on('host:backToLobby', () => {
    const room = getRoomBySocket(socket);
    if (!room || room.hostId !== socket.id) return;
    if (room.phase !== 'round-end' && room.phase !== 'lobby') return;
    room.phase = 'lobby';
    broadcast(room);
  });

  socket.on('disconnect', () => {
    const room = getRoomBySocket(socket);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (player) {
      player.connected = false;
    }
    if (room.hostId === socket.id) {
      // Reassign host to the next connected player, if any.
      const nextHost = Array.from(room.players.values()).find((p) => p.connected);
      if (nextHost) {
        room.hostId = nextHost.id;
      } else {
        rooms.delete(room.code);
        return;
      }
    }
    broadcast(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Quote Sleuth running at http://localhost:${PORT}`);
});
