// Storage abstraction for room state.
//
// Locally (no REDIS_URL set) this is a plain in-memory Map — fine for a
// single long-running `node server.js` process.
//
// On Vercel, each WebSocket connection can land on a different Function
// instance with its own memory, so room state has to live somewhere all
// instances can reach: Redis. Set REDIS_URL (e.g. from the Vercel Redis
// marketplace integration) to switch into that mode automatically.

const { randomCode } = require('./game');

const ROOM_TTL_SECONDS = 6 * 60 * 60; // expire abandoned rooms after 6h

function createMemoryStore() {
  const rooms = new Map();
  return {
    mode: 'memory',
    async get(code) {
      return rooms.get(code) || null;
    },
    async save(room) {
      rooms.set(room.code, room);
    },
    async delete(code) {
      rooms.delete(code);
    },
    async newCode() {
      let code;
      do {
        code = randomCode();
      } while (rooms.has(code));
      return code;
    },
  };
}

function createRedisStore(redisUrl) {
  const Redis = require('ioredis');
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 3 });
  const key = (code) => `quoteguesser:room:${code}`;

  return {
    mode: 'redis',
    client: redis,
    async get(code) {
      const raw = await redis.get(key(code));
      return raw ? JSON.parse(raw) : null;
    },
    async save(room) {
      await redis.set(key(room.code), JSON.stringify(room), 'EX', ROOM_TTL_SECONDS);
    },
    async delete(code) {
      await redis.del(key(code));
    },
    async newCode() {
      let code;
      let exists = true;
      do {
        code = randomCode();
        exists = (await redis.exists(key(code))) === 1;
      } while (exists);
      return code;
    },
  };
}

let store = null;

function getStore() {
  if (store) return store;
  const redisUrl = process.env.REDIS_URL || process.env.KV_URL;
  store = redisUrl ? createRedisStore(redisUrl) : createMemoryStore();
  return store;
}

module.exports = { getStore };
