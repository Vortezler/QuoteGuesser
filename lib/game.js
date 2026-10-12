// Pure-ish game logic operating on a plain-JSON room object.
// Every player is identified by a persistent `playerId` (survives
// reconnects / new socket ids), not by the underlying socket id.

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I confusion

function randomId() {
  return (
    Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10)
  );
}

function randomCode() {
  return Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
}

function defaultSettings() {
  return { scoringMode: 'both', pointsCorrect: 100, pointsFool: 50 };
}

function newRoom(code) {
  return {
    code,
    hostId: null,
    players: {}, // playerId -> {id, name, score, connected, token}
    phase: 'lobby',
    settings: defaultSettings(),
    quotes: [], // {id, text, authorId}
    currentQuoteIndex: 0,
    votes: {}, // quoteId -> { voterId: targetId }
    submittedBy: [],
    roundNumber: 0,
  };
}

function addPlayer(room, name, { asHost } = {}) {
  const playerId = randomId();
  const token = randomId();
  room.players[playerId] = {
    id: playerId,
    name: (name || 'Player').slice(0, 24),
    score: 0,
    connected: true,
    token,
  };
  if (asHost || !room.hostId) {
    room.hostId = playerId;
  }
  return { playerId, token };
}

function reconnectPlayer(room, playerId, token) {
  const player = room.players[playerId];
  if (!player || player.token !== token) return false;
  player.connected = true;
  return true;
}

function markDisconnected(room, playerId) {
  const player = room.players[playerId];
  if (!player) return;
  player.connected = false;
  // Host stays sticky to this player even while disconnected. Connections
  // are expected to drop and come back constantly on Vercel (a Function
  // instance only holds a WebSocket open for a few minutes), so handing
  // host duties to someone else the instant that happens would mean the
  // host randomly loses control mid-game. They regain it automatically
  // the moment they reconnect (same token -> same playerId -> same
  // hostId). The tradeoff: if a host leaves for good, nobody else can
  // take over — see README.
}

function connectedPlayers(room) {
  return Object.values(room.players).filter((p) => p.connected);
}

function currentQuote(room) {
  return room.quotes[room.currentQuoteIndex] || null;
}

function eligibleVoterIds(room, quote) {
  return connectedPlayers(room)
    .filter((p) => p.id !== quote.authorId)
    .map((p) => p.id);
}

function publicPlayers(room) {
  return Object.values(room.players).map((p) => ({
    id: p.id,
    name: p.name,
    score: p.score,
    connected: p.connected,
    isHost: p.id === room.hostId,
  }));
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
    submittedCount: room.submittedBy.length,
    totalPlayers: connectedPlayers(room).length,
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

function resetForNewRound(room) {
  room.phase = 'submitting';
  room.quotes = [];
  room.votes = {};
  room.submittedBy = [];
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

function submitQuote(room, playerId, text) {
  if (room.phase !== 'submitting') return false;
  const player = room.players[playerId];
  if (!player || !player.connected) return false;
  if (room.submittedBy.includes(playerId)) return false;
  const clean = (text || '').trim().slice(0, 300);
  if (!clean) return false;
  room.quotes.push({ id: `${playerId}-${Date.now()}-${randomId().slice(0, 4)}`, text: clean, authorId: playerId });
  room.submittedBy.push(playerId);
  return true;
}

function startVoting(room) {
  room.quotes = shuffle(room.quotes);
  room.currentQuoteIndex = 0;
  room.phase = room.quotes.length > 0 ? 'voting' : 'round-end';
}

function maybeStartVoting(room) {
  const connected = connectedPlayers(room);
  if (room.phase === 'submitting' && room.submittedBy.length >= connected.length && connected.length >= 2) {
    startVoting(room);
    return true;
  }
  return false;
}

function castVote(room, voterId, targetId) {
  if (room.phase !== 'voting') return false;
  const quote = currentQuote(room);
  if (!quote) return false;
  if (voterId === quote.authorId) return false; // author can't vote on own quote
  if (voterId === targetId) return false; // no self-vote
  if (!room.players[targetId]) return false;
  if (!room.votes[quote.id]) room.votes[quote.id] = {};
  if (room.votes[quote.id][voterId]) return false; // one vote per player per quote
  room.votes[quote.id][voterId] = targetId;
  return true;
}

function maybeReveal(room) {
  if (room.phase !== 'voting') return false;
  const quote = currentQuote(room);
  if (!quote) return false;
  const votesForQuote = room.votes[quote.id] || {};
  const eligible = eligibleVoterIds(room, quote);
  if (eligible.length === 0 || Object.keys(votesForQuote).length >= eligible.length) {
    revealCurrentQuote(room);
    return true;
  }
  return false;
}

function revealCurrentQuote(room) {
  const quote = currentQuote(room);
  if (!quote) return;
  room.phase = 'reveal';
  const votesForQuote = room.votes[quote.id] || {};
  const author = room.players[quote.authorId];
  if (!author) return;

  const { scoringMode, pointsCorrect, pointsFool } = room.settings;
  let wrongCount = 0;

  Object.entries(votesForQuote).forEach(([voterId, targetId]) => {
    const voter = room.players[voterId];
    if (!voter) return;
    if (targetId === quote.authorId) {
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
}

function advanceQuote(room) {
  if (room.currentQuoteIndex + 1 < room.quotes.length) {
    room.currentQuoteIndex += 1;
    room.phase = 'voting';
  } else {
    room.phase = 'round-end';
  }
}

function updateSettings(room, settings) {
  if (room.phase !== 'lobby' && room.phase !== 'round-end') return false;
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
  return true;
}

module.exports = {
  randomCode,
  defaultSettings,
  newRoom,
  addPlayer,
  reconnectPlayer,
  markDisconnected,
  connectedPlayers,
  currentQuote,
  eligibleVoterIds,
  buildStateFor,
  resetForNewRound,
  submitQuote,
  startVoting,
  maybeStartVoting,
  castVote,
  maybeReveal,
  revealCurrentQuote,
  advanceQuote,
  updateSettings,
};
