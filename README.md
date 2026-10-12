# QuoteGuesser

A "who wrote this quote?" party game. No accounts, nothing saved — the host
runs a small local server and friends join with a 4-letter room code.

## How it plays

1. Host creates a room and shares the code.
2. Each round, every player submits one quote.
3. The game cycles through the quotes one at a time; everyone except the
   author votes on who they think wrote it (no voting for yourself).
4. After each quote, the author is revealed along with everyone's guesses.
5. The host picks how scoring works for each round (points for guessing
   correctly, points for fooling people, both, or just for fun) — this can
   be changed between rounds from the settings panel.

## Run it

Requires [Node.js](https://nodejs.org) 18+.

```bash
npm install
npm start
```

This starts the server at `http://localhost:3000`. Open that in your
browser to host.

## Letting friends join

### Same WiFi (simplest)

1. Find your computer's local IP address:
   - **Mac/Linux:** `ipconfig getifaddr en0` (Mac Wi-Fi) or `hostname -I` (Linux)
   - **Windows:** `ipconfig` and look for "IPv4 Address"
2. Share `http://<your-local-ip>:3000` with friends on the same WiFi/network.
   Example: `http://192.168.1.42:3000`
3. They open that link, enter the room code, and join.

No internet exposure, no port forwarding needed — this only works for
people on the same network as the host.

### Over the internet

If people aren't on the same WiFi, you need to expose your local server
publicly. The easiest way is a tunnel like [ngrok](https://ngrok.com):

```bash
# in a second terminal, while the server is running
npx ngrok http 3000
```

ngrok prints a public `https://...ngrok-free.app` URL — share that instead
of your local IP. Anyone with that link can join from anywhere, and it goes
away when you stop ngrok. (Any similar tunnel tool, or port-forwarding your
router to port 3000, works too — ngrok is just the least setup.)

## Notes

- Game state lives in memory only; restarting the server clears all rooms.
- Supports small groups well (tested logic assumes roughly 2–16 players).
- If the host's tab disconnects, host duties pass to another connected
  player automatically.
