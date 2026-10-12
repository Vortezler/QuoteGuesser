const socket = io({
  path: '/api/socket-io/socket.io',
  transports: ['websocket'],
});

// Identity is a persistent playerId + token (not the raw socket id), so a
// reconnect — expected periodically on Vercel, where a Function instance
// can only hold a connection open for a few minutes — resumes the same
// player instead of creating a new one.
let myId = null;
let isHost = false;
let lastState = null;
let selectedVoteTarget = null;
let submittedThisRound = false;
let mySession = loadSession(); // {code, playerId, token} | null

function loadSession() {
  try {
    const raw = sessionStorage.getItem('quoteguesser:lastSession');
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function saveSession(session) {
  mySession = session;
  try {
    sessionStorage.setItem('quoteguesser:lastSession', JSON.stringify(session));
  } catch (e) {
    /* ignore */
  }
}

function clearSession() {
  mySession = null;
  try {
    sessionStorage.removeItem('quoteguesser:lastSession');
  } catch (e) {
    /* ignore */
  }
}

const screens = {
  start: document.getElementById('screen-start'),
  lobby: document.getElementById('screen-lobby'),
  submitting: document.getElementById('screen-submitting'),
  voting: document.getElementById('screen-voting'),
  reveal: document.getElementById('screen-reveal'),
  roundend: document.getElementById('screen-roundend'),
};

function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.add('hidden'));
  screens[name].classList.remove('hidden');
}

// On first load (or a dropped connection getting a fresh socket), try to
// silently resume whatever room we were last in before showing the "host
// or join" screen at all.
if (mySession) {
  document.getElementById('reconnecting').classList.remove('hidden');
  document.getElementById('startForms').classList.add('hidden');
}

socket.on('connect', () => {
  if (!mySession) return;
  socket.emit('player:reconnect', mySession, (res) => {
    if (res.ok) {
      myId = res.playerId;
      saveSession({ code: res.code, playerId: res.playerId, token: res.token });
    } else {
      clearSession();
      document.getElementById('reconnecting').classList.add('hidden');
      document.getElementById('startForms').classList.remove('hidden');
    }
  });
});

// ---------- Start screen ----------

document.getElementById('btnHost').addEventListener('click', () => {
  const name = document.getElementById('hostName').value.trim() || 'Host';
  socket.emit('host:create', { name }, (res) => {
    if (!res.ok) {
      document.getElementById('startError').textContent = res.error || 'Could not create room.';
      return;
    }
    myId = res.playerId;
    saveSession({ code: res.code, playerId: res.playerId, token: res.token });
  });
});

document.getElementById('btnJoin').addEventListener('click', () => {
  const code = document.getElementById('joinCode').value.trim().toUpperCase();
  const name = document.getElementById('joinName').value.trim() || 'Player';
  if (!code) {
    document.getElementById('startError').textContent = 'Enter a room code.';
    return;
  }
  socket.emit('player:join', { code, name }, (res) => {
    if (!res.ok) {
      document.getElementById('startError').textContent = res.error || 'Could not join room.';
      return;
    }
    myId = res.playerId;
    saveSession({ code: res.code, playerId: res.playerId, token: res.token });
  });
});

// ---------- Lobby / settings ----------

function readSettingsForm(suffix) {
  return {
    scoringMode: document.getElementById('scoringMode' + suffix).value,
    pointsCorrect: Number(document.getElementById('pointsCorrect' + suffix).value),
    pointsFool: Number(document.getElementById('pointsFool' + suffix).value),
  };
}

function applySettingsToForm(suffix, settings) {
  document.getElementById('scoringMode' + suffix).value = settings.scoringMode;
  document.getElementById('pointsCorrect' + suffix).value = settings.pointsCorrect;
  document.getElementById('pointsFool' + suffix).value = settings.pointsFool;
}

['', '2'].forEach((suffix) => {
  const mode = document.getElementById('scoringMode' + suffix);
  if (mode) {
    mode.addEventListener('change', () => socket.emit('host:updateSettings', readSettingsForm(suffix)));
  }
  ['pointsCorrect', 'pointsFool'].forEach((field) => {
    const el = document.getElementById(field + suffix);
    if (el) {
      el.addEventListener('change', () => socket.emit('host:updateSettings', readSettingsForm(suffix)));
    }
  });
});

document.getElementById('btnStartRound').addEventListener('click', () => {
  socket.emit('host:startRound');
});
document.getElementById('btnNextRound').addEventListener('click', () => {
  socket.emit('host:startRound');
});

// ---------- Submitting ----------

document.getElementById('btnSubmitQuote').addEventListener('click', () => {
  const text = document.getElementById('quoteText').value.trim();
  if (!text) return;
  socket.emit('player:submitQuote', { text });
  submittedThisRound = true;
  document.getElementById('submitStatus').textContent = 'Quote submitted — waiting on everyone else...';
  document.getElementById('quoteText').disabled = true;
  document.getElementById('btnSubmitQuote').disabled = true;
});

document.getElementById('btnForceVoting').addEventListener('click', () => {
  socket.emit('host:forceStartVoting');
});

// ---------- Voting ----------

document.getElementById('btnForceReveal').addEventListener('click', () => {
  socket.emit('host:forceReveal');
});

// ---------- Reveal ----------

document.getElementById('btnNextQuote').addEventListener('click', () => {
  socket.emit('host:nextQuote');
});

// ---------- State rendering ----------

socket.on('room:state', (state) => {
  lastState = state;
  isHost = myId !== null && state.hostId === myId;
  render(state);
});

function render(state) {
  document.getElementById('roomCode').textContent = state.code;

  if (state.phase === 'lobby') {
    submittedThisRound = false;
    selectedVoteTarget = null;
    showScreen('lobby');
    document.getElementById('hostSettingsCard').classList.toggle('hidden', !isHost);
    document.getElementById('playerCount').textContent = state.players.length;
    renderPlayerList(state);
    if (isHost) applySettingsToForm('', state.settings);
    document.getElementById('btnStartRound').disabled = state.players.filter((p) => p.connected).length < 2;
    document.getElementById('btnStartRound').classList.toggle('hidden', !isHost);
  }

  if (state.phase === 'submitting') {
    showScreen('submitting');
    document.getElementById('roundNumSubmit').textContent = state.roundNumber;
    document.getElementById('submittedCount').textContent = state.submittedCount;
    document.getElementById('totalPlayers').textContent = state.totalPlayers;
    document.getElementById('btnForceVoting').classList.toggle('hidden', !isHost);
    if (!submittedThisRound) {
      document.getElementById('quoteText').disabled = false;
      document.getElementById('btnSubmitQuote').disabled = false;
      document.getElementById('submitStatus').textContent = '';
    }
  }

  if (state.phase === 'voting') {
    showScreen('voting');
    renderVoting(state);
  }

  if (state.phase === 'reveal') {
    showScreen('reveal');
    renderReveal(state);
  }

  if (state.phase === 'round-end') {
    showScreen('roundend');
    renderScoreboard(state);
    document.getElementById('hostRoundEndControls').classList.toggle('hidden', !isHost);
    document.getElementById('waitHostHint').classList.toggle('hidden', isHost);
    if (isHost) applySettingsToForm('2', state.settings);
  }
}

function renderPlayerList(state) {
  const ul = document.getElementById('playerList');
  ul.innerHTML = '';
  state.players.forEach((p) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = p.name + (p.connected ? '' : ' (left)');
    if (p.isHost) {
      const badge = document.createElement('span');
      badge.className = 'player-badge';
      badge.textContent = 'HOST';
      name.appendChild(badge);
    }
    const score = document.createElement('span');
    score.textContent = state.roundNumber > 0 ? p.score : '';
    li.appendChild(name);
    li.appendChild(score);
    ul.appendChild(li);
  });
}

function renderVoting(state) {
  document.getElementById('roundNumVote').textContent = state.roundNumber;
  document.getElementById('quoteNumVote').textContent = state.quoteIndex + 1;
  document.getElementById('quoteTotalVote').textContent = state.totalQuotes;
  document.getElementById('votingQuoteText').textContent = '"' + state.currentQuote.text + '"';
  document.getElementById('votedCount').textContent = state.votedCount;
  document.getElementById('eligibleVoters').textContent = state.eligibleVoters;
  document.getElementById('btnForceReveal').classList.toggle('hidden', !isHost);

  // We don't know server-side who the author is on this screen (kept secret),
  // but we know it's "my quote" if I can't tell who wrote it... actually the
  // server simply won't let me vote if I'm the author; show a waiting message
  // if my vote attempt would be rejected. We infer via a vote attempt instead:
  // simplest UX is to always show options, and the "author waiting" message
  // is shown once the server confirms (no explicit signal needed since author
  // never appears as a voter). We optimistically show options to everyone and
  // let the click handler react if it's a no-op for the author by comparing
  // their own submitted quote text isn't exposed; instead we just always show
  // voting options — the author can tell it's their own quote and can simply
  // not click (server ignores author votes anyway).
  const area = document.getElementById('votingArea');
  area.innerHTML = '';
  area.classList.remove('hidden');
  document.getElementById('authorWaiting').classList.add('hidden');

  state.players
    .filter((p) => p.connected && p.id !== myId)
    .forEach((p) => {
      const btn = document.createElement('button');
      btn.className = 'vote-option';
      btn.textContent = p.name;
      if (selectedVoteTarget === p.id) btn.classList.add('selected');
      btn.addEventListener('click', () => {
        selectedVoteTarget = p.id;
        socket.emit('player:vote', { targetPlayerId: p.id });
        Array.from(area.children).forEach((c) => c.classList.remove('selected'));
        btn.classList.add('selected');
        Array.from(area.children).forEach((c) => (c.disabled = true));
      });
      area.appendChild(btn);
    });
}

function renderReveal(state) {
  document.getElementById('revealQuoteText').textContent = '"' + state.currentQuote.text + '"';
  const author = state.players.find((p) => p.id === state.currentQuote.authorId);
  document.getElementById('revealAuthor').textContent = author ? author.name : 'Unknown';

  const ul = document.getElementById('revealVotes');
  ul.innerHTML = '';
  Object.entries(state.votes || {}).forEach(([voterId, targetId]) => {
    const voter = state.players.find((p) => p.id === voterId);
    const target = state.players.find((p) => p.id === targetId);
    if (!voter || !target) return;
    const correct = targetId === state.currentQuote.authorId;
    const li = document.createElement('li');
    li.className = correct ? 'correct' : 'wrong';
    li.innerHTML = `<span>${voter.name} guessed ${target.name}</span><span>${correct ? '✓' : '✗'}</span>`;
    ul.appendChild(li);
  });

  selectedVoteTarget = null;
  const isLast = state.quoteIndex + 1 >= state.totalQuotes;
  const nextBtn = document.getElementById('btnNextQuote');
  nextBtn.textContent = isLast ? 'See Scoreboard (host)' : 'Next Quote (host)';
  nextBtn.classList.toggle('hidden', !isHost);
}

function renderScoreboard(state) {
  const ol = document.getElementById('scoreboard');
  ol.innerHTML = '';
  const sorted = [...state.players].sort((a, b) => b.score - a.score);
  sorted.forEach((p) => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${p.name}</span><span>${p.score} pts</span>`;
    ol.appendChild(li);
  });
}
