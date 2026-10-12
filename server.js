// Local dev / self-hosted entrypoint: `npm start` runs this directly as a
// normal long-lived Node process (no Vercel, no Redis needed — room state
// just lives in memory). The actual game logic lives in lib/ and is shared
// with the Vercel serverless entrypoint at api/socket-io.js.

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { getStore } = require('./lib/store');
const { attachSocketHandlers } = require('./lib/attachSocketHandlers');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // Same path as the Vercel deployment so public/client.js can use one
  // set of connection options everywhere.
  path: '/api/socket-io/socket.io',
});

app.use(express.static(path.join(__dirname, 'public')));

attachSocketHandlers(io, getStore());

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Quote Sleuth running at http://localhost:${PORT}`);
});
