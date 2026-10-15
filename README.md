# Lucid Live

A liquid-glass website showing the Lucid Trading Discord member count live. Anyone on the page can tap an emoji and everyone else watching sees it float up the background in real time.

## How it works

- `server.js` polls Discord's public invite endpoint (`discord.gg/lucidtrading`) every 20 seconds and pushes the member and online counts to every open page over a WebSocket. No bot or token needed.
- Emojis are sent over the same WebSocket. The server accepts one real emoji per message (text, links and HTML are dropped), limits each visitor to 6 quick taps then 3 per second, and caps the whole site at 45 per second.
- `public/index.html` is the whole front end: rolling counter, online share, live viewer count, emoji total, a member trend line since the server started, and the emoji dock (10 quick picks, 40 more, or paste any emoji).

Discord only refreshes its own approximate counts every few minutes, so the number moves in small steps rather than every second. Polling faster than ~15s won't make it more accurate and risks rate limits.

## Run it on your computer

Needs Node 18.17 or newer.

```
npm install
npm start          # real Discord numbers → http://localhost:3000
npm run dev        # fake numbers that wiggle, for testing the look
```

Open two browser tabs and tap emojis in one to see them appear in the other.

## Put it online (free, ~5 minutes) — Render

1. Push this folder to a new GitHub repo.
2. On render.com: **New → Web Service**, pick the repo.
3. Runtime **Node**, Build command `npm install`, Start command `npm start`, instance type **Free**.
4. Deploy. You get a link like `https://lucid-live.onrender.com` to share.

The free tier sleeps after 15 minutes with no visitors; the first visit after that takes ~30s to wake. The trend line restarts when the server restarts. Railway, Fly.io or any VPS also work the same way (`npm install`, `npm start`; WebSockets must be allowed).

## Settings (environment variables)

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port to listen on (hosts set this for you) |
| `DISCORD_INVITE` | `lucidtrading` | Invite code of the server to track |
| `POLL_MS` | `20000` | How often to ask Discord, in ms (minimum 10000) |
| `MOCK` | off | `1` = fake numbers for testing |

`/health` and `/api/stats` return the current numbers as JSON.
