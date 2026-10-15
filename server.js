// Lucid Live — realtime Discord member counter + shared floating emojis.
// One process: serves the page, polls Discord, relays emojis over WebSockets.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const PORT = Number(process.env.PORT) || 3000;
const INVITE = process.env.DISCORD_INVITE || 'lucidtrading';
const POLL_MS = Math.max(10_000, Number(process.env.POLL_MS) || 20_000);
const MOCK = process.env.MOCK === '1';
const HISTORY_MAX = 540; // 3 hours at 20s

// ---------------------------------------------------------------- state
const state = {
  guild: { id: null, name: 'Lucid Trading', icon: null, invite: INVITE },
  members: null,
  online: null,
  updatedAt: null,
  history: [], // [t, members, online]
  emojiTotal: 0,
};

// ---------------------------------------------------------------- discord polling
function iconUrl(id, hash) {
  if (!id || !hash) return null;
  const ext = hash.startsWith('a_') ? 'gif' : 'webp';
  return `https://cdn.discordapp.com/icons/${id}/${hash}.${ext}?size=256`;
}

let mockMembers = 196_980;
let mockOnline = 27_355;
async function fetchCounts() {
  if (MOCK) {
    mockMembers += Math.round((Math.random() - 0.35) * 18);
    mockOnline = Math.max(1000, mockOnline + Math.round((Math.random() - 0.5) * 220));
    return { id: '0', name: 'Lucid Trading', icon: null, members: mockMembers, online: mockOnline };
  }
  const res = await fetch(
    `https://discord.com/api/v10/invites/${encodeURIComponent(INVITE)}?with_counts=true`,
    { headers: { 'User-Agent': 'LucidLive (member counter, +https://discord.gg/' + INVITE + ')' } },
  );
  if (res.status === 429) {
    const body = await res.json().catch(() => ({}));
    const err = new Error('rate limited');
    err.retryAfter = Math.ceil((body.retry_after || 30) * 1000);
    throw err;
  }
  if (!res.ok) throw new Error(`Discord answered ${res.status}`);
  const j = await res.json();
  return {
    id: j.guild?.id,
    name: j.guild?.name,
    icon: j.guild?.icon,
    members: j.approximate_member_count,
    online: j.approximate_presence_count,
  };
}

async function poll() {
  let wait = POLL_MS;
  try {
    const c = await fetchCounts();
    if (Number.isFinite(c.members)) {
      state.guild.id = c.id || state.guild.id;
      state.guild.name = c.name || state.guild.name;
      state.guild.icon = iconUrl(c.id, c.icon) || state.guild.icon;
      state.members = c.members;
      state.online = c.online;
      state.updatedAt = Date.now();
      const point = [state.updatedAt, c.members, c.online];
      state.history.push(point);
      if (state.history.length > HISTORY_MAX) state.history.shift();
      broadcast({ type: 'stats', members: c.members, online: c.online, updatedAt: state.updatedAt, point, guild: state.guild });
    }
  } catch (e) {
    if (e.retryAfter) wait = Math.max(wait, e.retryAfter);
    console.warn(`[poll] ${e.message} — retrying in ${Math.round(wait / 1000)}s`);
  }
  setTimeout(poll, wait);
}

// ---------------------------------------------------------------- static files
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, members: state.members, online: state.online, viewers: wss.clients.size, updatedAt: state.updatedAt }));
  }
  if (url.pathname === '/api/stats') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ guild: state.guild, members: state.members, online: state.online, updatedAt: state.updatedAt }));
  }
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'cache-control': file.endsWith('.html') ? 'no-cache' : 'public, max-age=3600',
      'x-content-type-options': 'nosniff',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  }
});

// ---------------------------------------------------------------- websockets
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 512 });

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
}
function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const c of wss.clients) send(c, data);
}

let viewersTimer = null;
function announceViewers() {
  clearTimeout(viewersTimer);
  viewersTimer = setTimeout(() => broadcast({ type: 'viewers', n: wss.clients.size }), 250);
}

// One emoji, nothing else: a single grapheme that is pictographic (flags included).
const seg = new Intl.Segmenter('en', { granularity: 'grapheme' });
function cleanEmoji(s) {
  if (typeof s !== 'string' || s.length === 0 || s.length > 32) return null;
  const parts = [...seg.segment(s.trim())];
  if (parts.length !== 1) return null;
  const g = parts[0].segment;
  if (!/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(g)) return null;
  return g;
}

// Rate limits: per IP token bucket (6 burst, 3/s) + global cap of 45 emojis/s.
const buckets = new Map();
function allowIp(ip) {
  const now = Date.now();
  const b = buckets.get(ip) || { tokens: 6, at: now };
  b.tokens = Math.min(6, b.tokens + ((now - b.at) / 1000) * 3);
  b.at = now;
  buckets.set(ip, b);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}
setInterval(() => { const cut = Date.now() - 60_000; for (const [k, b] of buckets) if (b.at < cut) buckets.delete(k); }, 60_000);
let globalWindow = { at: 0, n: 0 };
function allowGlobal() {
  const now = Date.now();
  if (now - globalWindow.at > 1000) globalWindow = { at: now, n: 0 };
  return ++globalWindow.n <= 45;
}

let emojiSeq = 0;
wss.on('connection', (ws, req) => {
  ws.ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });

  send(ws, {
    type: 'hello',
    guild: state.guild,
    members: state.members,
    online: state.online,
    updatedAt: state.updatedAt,
    pollMs: POLL_MS,
    history: state.history,
    emojiTotal: state.emojiTotal,
    viewers: wss.clients.size,
  });
  announceViewers();

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m?.type !== 'emoji') return;
    const e = cleanEmoji(m.e);
    if (!e) return;
    if (!allowIp(ws.ip) || !allowGlobal()) return send(ws, { type: 'slow' });

    state.emojiTotal += 1;
    const base = {
      type: 'emoji',
      id: ++emojiSeq,
      e,
      x: Math.round((0.04 + Math.random() * 0.92) * 1000) / 1000, // horizontal lane, same for everyone
      s: Math.round((0.85 + Math.random() * 0.6) * 100) / 100,     // size
      d: Math.round((Math.random() * 2 - 1) * 100) / 100,          // sway direction
      total: state.emojiTotal,
    };
    const forOthers = JSON.stringify(base);
    const forSender = JSON.stringify({ ...base, mine: true });
    for (const c of wss.clients) send(c, c === ws ? forSender : forOthers);
  });

  ws.on('close', announceViewers);
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    ws.ping();
  }
}, 30_000);

server.listen(PORT, () => {
  console.log(`Lucid Live on http://localhost:${PORT}  (invite: ${INVITE}, poll every ${POLL_MS / 1000}s${MOCK ? ', MOCK data' : ''})`);
  poll();
});
