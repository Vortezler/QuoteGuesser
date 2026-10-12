const game = require('./game');

/**
 * Wires up all Quote Sleuth socket.io events against a given `io` server
 * and room `store`. Shared between the local dev server and the Vercel
 * serverless entrypoint so the two never drift apart.
 */
function attachSocketHandlers(io, store) {
  async function broadcast(room) {
    io.to(room.code).emit('room:state', game.buildStateFor(room));
  }

  io.on('connection', (socket) => {
    socket.on('host:create', async ({ name }, cb) => {
      const code = await store.newCode();
      const room = game.newRoom(code);
      const { playerId, token } = game.addPlayer(room, name, { asHost: true });
      await store.save(room);
      socket.data.roomCode = code;
      socket.data.playerId = playerId;
      socket.join(code);
      cb({ ok: true, code, playerId, token });
      await broadcast(room);
    });

    socket.on('player:join', async ({ code, name }, cb) => {
      const room = await store.get((code || '').toUpperCase());
      if (!room) {
        cb({ ok: false, error: 'No room with that code.' });
        return;
      }
      if (Object.keys(room.players).length >= 16) {
        cb({ ok: false, error: 'Room is full.' });
        return;
      }
      const { playerId, token } = game.addPlayer(room, name);
      await store.save(room);
      socket.data.roomCode = room.code;
      socket.data.playerId = playerId;
      socket.join(room.code);
      cb({ ok: true, code: room.code, playerId, token });
      await broadcast(room);
    });

    socket.on('player:reconnect', async ({ code, playerId, token }, cb) => {
      const room = await store.get((code || '').toUpperCase());
      if (!room || !game.reconnectPlayer(room, playerId, token)) {
        cb({ ok: false });
        return;
      }
      await store.save(room);
      socket.data.roomCode = room.code;
      socket.data.playerId = playerId;
      socket.join(room.code);
      cb({ ok: true, code: room.code, playerId, token });
      await broadcast(room);
    });

    socket.on('host:updateSettings', async (settings) => {
      const room = await store.get(socket.data.roomCode);
      if (!room || room.hostId !== socket.data.playerId) return;
      if (game.updateSettings(room, settings)) {
        await store.save(room);
        await broadcast(room);
      }
    });

    socket.on('host:startRound', async () => {
      const room = await store.get(socket.data.roomCode);
      if (!room || room.hostId !== socket.data.playerId) return;
      if (room.phase !== 'lobby' && room.phase !== 'round-end') return;
      if (game.connectedPlayers(room).length < 2) return;
      game.resetForNewRound(room);
      await store.save(room);
      await broadcast(room);
    });

    socket.on('player:submitQuote', async ({ text }) => {
      const room = await store.get(socket.data.roomCode);
      if (!room) return;
      if (!game.submitQuote(room, socket.data.playerId, text)) return;
      game.maybeStartVoting(room);
      await store.save(room);
      await broadcast(room);
    });

    socket.on('host:forceStartVoting', async () => {
      const room = await store.get(socket.data.roomCode);
      if (!room || room.hostId !== socket.data.playerId) return;
      if (room.phase !== 'submitting') return;
      game.startVoting(room);
      await store.save(room);
      await broadcast(room);
    });

    socket.on('player:vote', async ({ targetPlayerId }) => {
      const room = await store.get(socket.data.roomCode);
      if (!room) return;
      if (!game.castVote(room, socket.data.playerId, targetPlayerId)) return;
      game.maybeReveal(room);
      await store.save(room);
      await broadcast(room);
    });

    socket.on('host:forceReveal', async () => {
      const room = await store.get(socket.data.roomCode);
      if (!room || room.hostId !== socket.data.playerId) return;
      if (room.phase !== 'voting') return;
      game.revealCurrentQuote(room);
      await store.save(room);
      await broadcast(room);
    });

    socket.on('host:nextQuote', async () => {
      const room = await store.get(socket.data.roomCode);
      if (!room || room.hostId !== socket.data.playerId) return;
      if (room.phase !== 'reveal') return;
      game.advanceQuote(room);
      await store.save(room);
      await broadcast(room);
    });

    socket.on('disconnect', async () => {
      const code = socket.data.roomCode;
      const playerId = socket.data.playerId;
      if (!code || !playerId) return;
      const room = await store.get(code);
      if (!room) return;
      game.markDisconnected(room, playerId);
      await store.save(room);
      await broadcast(room);
    });
  });
}

module.exports = { attachSocketHandlers };
