# QuoteGuesser

A "who wrote this quote?" party game. No accounts, nothing saved permanently.

## How it plays

1. Host creates a room and shares the code.
2. Each round, every player submits one quote.
3. The game cycles through the quotes one at a time; everyone except the
   author votes on who they think wrote it (no voting for yourself).
4. After each quote, the author is revealed along with everyone's guesses.
5. The host picks how scoring works for each round (points for guessing
   correctly, points for fooling people, both, or just for fun) — this can
   be changed between rounds from the settings panel.

There are two ways to run this. Pick whichever fits:

- **Self-host** — run it yourself with one command, friends join over WiFi
  or a tunnel. Zero setup beyond Node.
- **Deploy to Vercel** — a real hosted URL, no terminal needed to play,
  works from anywhere. Needs a (free-tier) Redis add-on — see below for why.

## Option A: Self-host

Requires [Node.js](https://nodejs.org) 18+.

```bash
npm install
npm start
```

This starts the server at `http://localhost:3000`. Open that in your
browser to host. Room state lives in memory in this one process.

### Letting friends join

**Same WiFi (simplest):**

1. Find your computer's local IP address:
   - **Mac/Linux:** `ipconfig getifaddr en0` (Mac Wi-Fi) or `hostname -I` (Linux)
   - **Windows:** `ipconfig` and look for "IPv4 Address"
2. Share `http://<your-local-ip>:3000` with friends on the same WiFi.
   Example: `http://192.168.1.42:3000`

**Over the internet:** use a tunnel like [ngrok](https://ngrok.com):

```bash
# in a second terminal, while the server is running
npx ngrok http 3000
```

ngrok prints a public `https://...ngrok-free.app` URL — share that instead.

## Option B: Deploy to Vercel

Vercel runs this as a serverless Function instead of one long-lived
process, which changes two things:

- **Shared state is required.** A different player's connection can land
  on a different Function instance with its own memory, so room state
  (who's in the room, scores, votes) is kept in **Redis** instead of a
  local `Map`, and broadcasts use `@socket.io/redis-adapter` so a message
  from one instance still reaches players connected to another. Without
  Redis configured, the app still runs but will behave inconsistently
  (players occasionally not seeing a room their host just created) as
  soon as Vercel scales past one instance.
- **Connections get recycled.** Vercel force-closes a WebSocket after
  300 seconds (5 min) on the free Hobby plan, longer on Pro. The app
  reconnects automatically and silently resumes the same player (same
  name, score, and host role) — you may just notice a flash of
  "Reconnecting…" every few minutes.

### Setup

1. **Add a Redis store** in the Vercel dashboard: your project →
   **Storage** tab → **Create Database** → choose **Redis** (the
   marketplace integration backed by Upstash has a free tier). Connect
   it to this project — Vercel will add a `REDIS_URL` (or `KV_URL`)
   environment variable automatically.
2. **Deploy** — push to this repo with Vercel's GitHub integration
   connected, or run `vercel deploy` / `vercel --prod` from this folder.
3. Open the deployed URL to host. Join links work the same as local
   play, just with a real domain instead of a local IP.

No vercel.json routing changes are needed — `public/` is served as
static assets and `api/socket-io.js` is the realtime backend
automatically.

## Notes

- Self-hosted room state lives in memory only; restarting the process
  clears all rooms. On Vercel, rooms expire from Redis after 6 hours of
  inactivity.
- Supports small groups well (tested logic assumes roughly 2–16 players).
- The player who creates a room stays host even through a dropped/
  reconnected connection. If the host closes their tab for good mid-game,
  nobody else can take over — someone will need to start a fresh room.
