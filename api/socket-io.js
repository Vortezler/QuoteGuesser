// Vercel Function entrypoint. Deployed at /api/socket-io; socket.io's own
// path convention makes the real endpoint /api/socket-io/socket.io, which
// public/client.js is configured to hit directly (see client.js).
//
// Vercel's docs for this exact pattern:
// https://vercel.com/docs/functions/websockets

const http = require('http');
const { Server } = require('socket.io');
const { getStore } = require('../lib/store');
const { attachSocketHandlers } = require('../lib/attachSocketHandlers');

const server = http.createServer();
const io = new Server(server, {
  path: '/api/socket-io/socket.io',
  // Serverless routing doesn't keep a session across separate HTTP
  // requests the way long-polling needs, so require a real WebSocket.
  transports: ['websocket'],
});

// A WebSocket connection is pinned to one Function instance, but a new
// connection (or a reconnect) can land on a different one. Redis +
// @socket.io/redis-adapter keeps room state and broadcasts consistent
// across however many instances end up running. REDIS_URL is provided by
// the Vercel Redis marketplace integration — see README for setup.
const redisUrl = process.env.REDIS_URL || process.env.KV_URL;
if (redisUrl) {
  const Redis = require('ioredis');
  const { createAdapter } = require('@socket.io/redis-adapter');
  const pubClient = new Redis(redisUrl, { maxRetriesPerRequest: 3 });
  const subClient = pubClient.duplicate();
  io.adapter(createAdapter(pubClient, subClient));
} else {
  console.warn(
    'REDIS_URL is not set — falling back to in-memory room state, which will ' +
      'behave inconsistently once Vercel scales to more than one Function ' +
      'instance. Add a Redis integration and set REDIS_URL before relying on ' +
      'this in production. See README.md.'
  );
}

attachSocketHandlers(io, getStore());

module.exports = server;
