'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Table } = require('./engine');
const bot = require('./bot');
const db = require('./db');
const { computeStats } = require('./stats');

const PORT = process.env.PORT || 3000;
const NEXT_HAND_MS = 4000;
const PASSWORD = process.env.POKER_PASSWORD || 'hypergamicFoid';
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const passwordOk = pw => crypto.timingSafeEqual(sha(pw), sha(PASSWORD));

let lastHand = null; // { rowId, rec } so cards shown after the hand still reach the log
const stackHistory = []; // [{ hand, stacks: { name: chips } }] for the live chip graph
const table = new Table({
  onHandEnd: rec => {
    stackHistory.push({ hand: rec.id, stacks: Object.fromEntries(table.seats.filter(Boolean).map(p => [p.name, p.stack])) });
    if (stackHistory.length > 100) stackHistory.shift();
    try { lastHand = { rowId: db.logHand(rec).lastInsertRowid, rec }; } catch (e) { console.error('hand log failed', e); }
  },
});

// Chat (system messages included), kept in memory for the live view and logged to the DB.
const chat = [];
function say(name, text) {
  chat.push({ at: Date.now(), name, text });
  if (chat.length > 100) chat.shift();
  try { db.logChat(name, text); } catch (e) { console.error('chat log failed', e); }
}
const sys = text => say(null, text);
const describe = s => `blinds ${s.sb}/${s.bb}${s.ante ? ` ante ${s.ante}` : ''}, buy-in ${s.minBuy}–${s.maxBuy}, ${s.actionSecs}s per move, ${s.bankMax}s time bank (+${s.bankAdd}s/hand)`;

// Votes (settings or kick): one vote per human client with an active seat, and one per bot seat.
// Bots always vote yes. A simple majority passes; a vote left open over 2 minutes can be replaced.
let proposal = null; // { kind, text, settings?, seat?, target?, exclude?, by, at, votes: Map<voterKey, boolean> }
function voters() {
  const v = new Set();
  table.seats.forEach((p, i) => { if (p && !p.sittingOut) v.add(p.bot ? `bot:${i}` : p.owner); });
  if (proposal?.exclude) v.delete(proposal.exclude); // the player being kicked doesn't vote
  return v;
}
function counts() {
  const v = voters();
  for (const k of v) if (k.startsWith('bot:')) proposal.votes.set(k, true);
  let yes = 0, no = 0;
  for (const [id, b] of proposal.votes) if (v.has(id)) b ? yes++ : no++;
  return { yes, no, voters: v.size };
}
function tally() {
  if (!proposal) return;
  const { yes, no, voters: n } = counts();
  const need = Math.floor(n / 2) + 1;
  if (yes >= need) {
    const pr = proposal;
    proposal = null;
    if (pr.kind === 'settings') {
      table.configure(pr.settings);
      sys(`Vote passed: ${pr.text}${table.live ? ' (from next hand)' : ''}`);
    } else if (table.live && pr.target.inHand) {
      pendingKicks.push(pr); // never kick mid-hand
      sys(`Vote passed: ${pr.target.name} will be removed after this hand`);
    } else kickNow(pr);
  } else if (yes + (n - yes - no) < need) {
    sys(`Vote failed: ${proposal.text}`);
    proposal = null;
  }
}
const pendingKicks = [];
function kickNow(pr) {
  if (table.seats[pr.seat] !== pr.target) return; // already gone
  const r = table.leave(pr.seat, pr.target.owner);
  sys(`${r.name} was kicked by vote (cashed out ${r.cashOut})`);
}

function startVote(m, prop) {
  if (!voters().has(m.id)) throw new Error('Take a seat to start a vote');
  if (proposal && Date.now() - proposal.at < 120_000) throw new Error('A vote is already open');
  proposal = { ...prop, by: String(m.name ?? '').slice(0, 20) || 'Someone', at: Date.now(), votes: new Map([[m.id, true]]) };
  sys(`${proposal.by} calls a vote: ${proposal.text}`);
  tally();
}

function state(id) {
  const v = table.view(id);
  v.chat = chat.slice(-60);
  v.canVote = voters().has(id);
  v.stackHistory = stackHistory;
  if (proposal) v.proposal = { kind: proposal.kind, text: proposal.text, by: proposal.by, ...counts(), myVote: proposal.votes.get(id) ?? null };
  return v;
}

const clients = new Map(); // SSE response -> client id
// Comment lines keep idle SSE connections open through hosting proxies.
setInterval(() => { for (const res of clients.keys()) res.write(': ping\n\n'); }, 25_000);
function broadcast() {
  for (const [res, id] of clients) res.write(`data: ${JSON.stringify(state(id))}\n\n`);
}

const botBuyIn = () => Math.min(table.maxBuy, Math.max(table.minBuy, table.bb * 100));

let timer = null;
function kick() {
  if (timer || !table.canStart()) return;
  timer = setTimeout(() => {
    timer = null;
    table.startHand();
    changed(); // a hand can end instantly (blinds put everyone all in)
  }, NEXT_HAND_MS);
}

let botTimer = null;
function driveBots() {
  if (botTimer || !table.live) return;
  const seat = table.hand.toAct;
  const p = table.seats[seat];
  if (!p.bot) return;
  botTimer = setTimeout(() => {
    botTimer = null;
    if (table.live && table.hand.toAct === seat && table.seats[seat] === p) {
      const o = table.view('bot').options;
      const d = bot.decide(o, p.cards, table.hand.board);
      try { table.act(seat, 'bot', d.type, d.amount); } catch { table.act(seat, 'bot', o.toCall ? 'fold' : 'check'); }
    }
    changed();
  }, 600 + Math.random() * 900);
}

// Auto-check/fold whoever runs out of time; two timeouts in a row and they're sat out (seat and stack kept).
let turnTimer = null;
function armTurnTimer() {
  clearTimeout(turnTimer);
  if (!table.live) return;
  turnTimer = setTimeout(() => {
    if (!table.live || Date.now() < table.deadline) return armTurnTimer();
    const p = table.timeout();
    if (p.timeouts >= 2 && !p.bot && !p.sittingOut) {
      p.sittingOut = true;
      sys(`${p.name} timed out twice and is sitting out`);
      tally();
    }
    changed();
  }, table.deadline - Date.now());
}

function changed() {
  if (!table.live) pendingKicks.splice(0).forEach(kickNow);
  if (!table.live) table.seats.forEach((p, i) => { if (p?.bot && !p.stack) table.topUp(i, 'bot', botBuyIn()); });
  broadcast();
  kick();
  driveBots();
  armTurnTimer();
}

function addBot(seat) {
  const used = new Set(table.seats.map(p => p?.name));
  const name = 'Bot ' + (bot.NAMES.find(n => !used.has('Bot ' + n)) ?? seat + 1);
  table.sit(seat, 'bot', name, botBuyIn(), true);
}

const ops = {
  sit: (m) => {
    table.sit(m.seat, m.id, m.name, m.buyIn);
    table.seats[m.seat].code = crypto.randomBytes(4).toString('hex').toUpperCase();
  },
  // Reclaim a seat (same place, same stack) from a new browser or device.
  rejoin: (m) => {
    const code = String(m.code ?? '').replace(/[^0-9a-f]/gi, '').toUpperCase();
    const i = table.seats.findIndex(p => p && !p.bot && code.length === 8 && p.code === code);
    if (i < 0) throw new Error('No seat with that code');
    const p = table.seats[i];
    Object.assign(p, { owner: m.id, sittingOut: false, timeouts: 0 });
    sys(`${p.name} rejoined seat ${i + 1}`);
    tally();
  },
  sitOut: (m) => {
    table.setSittingOut(m.seat, m.id, m.on);
    sys(`${table.seats[m.seat].name} ${m.on ? 'is sitting out' : 'is back'}`);
    tally();
  },
  act: (m) => table.act(m.seat, m.id, m.type, m.amount),
  topUp: (m) => {
    table.topUp(m.seat, m.id, m.amount);
    sys(`${table.seats[m.seat].name} added ${m.amount} chips${table.seats[m.seat].pendingChips ? ' (from next hand)' : ''}`);
  },
  leave: (m) => {
    const isBot = table.seats[m.seat]?.bot;
    const r = table.leave(m.seat, isBot ? 'bot' : m.id);
    sys(isBot ? `${r.name} removed` : `${r.name} cashed out ${r.cashOut} (${r.net >= 0 ? '+' : ''}${r.net})`);
    tally(); // a voter may have left
  },
  bot: (m) => {
    if (m.seat !== undefined) return addBot(m.seat);
    table.seats.forEach((p, i) => { if (!p) addBot(i); });
  },
  show: (m) => {
    const p = table.show(m.seat, m.id);
    const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' };
    sys(`${p.name} shows ${p.cards.map(c => c[0].replace('T', '10') + SUIT[c[1]]).join(' ')}`);
    const rp = !table.live && lastHand?.rec.players.find(x => x.seat === m.seat && x.owner === m.id);
    if (rp) {
      rp.shown = true;
      db.updateHand(lastHand.rowId, lastHand.rec);
    }
  },
  clearBots: () => table.seats.forEach((p, i) => { if (p?.bot) table.leave(i, 'bot'); }),
  chat: (m) => {
    const name = String(m.name ?? '').trim().slice(0, 20) || 'Guest';
    const text = String(m.text ?? '').trim().slice(0, 300);
    if (!text) throw new Error('Empty message');
    say(name, text);
  },
  propose: (m) => {
    const settings = new Table().configure({ ...table.settings, ...m.settings }); // validate only
    startVote(m, { kind: 'settings', settings, text: describe(settings) });
  },
  kick: (m) => {
    const p = table.seats[m.seat];
    if (!p) throw new Error('That seat is empty');
    if (p.owner === m.id) throw new Error("You can't kick yourself");
    startVote(m, { kind: 'kick', seat: m.seat, target: p, text: `kick ${p.name}`, exclude: p.bot ? `bot:${m.seat}` : p.owner });
  },
  vote: (m) => {
    if (!proposal) throw new Error('No open vote');
    if (!voters().has(m.id)) throw new Error('Only seated players can vote');
    proposal.votes.set(m.id, !!m.yes);
    tally();
  },
  override: (m) => {
    if (!passwordOk(m.password)) throw new Error('Wrong password');
    const s = table.configure(m.settings);
    if (proposal?.kind === 'settings') proposal = null;
    sys(`Settings overridden: ${describe(s)}${table.live ? ' (from next hand)' : ''}`);
  },
};

const validId = id => typeof id === 'string' && /^[a-f0-9]{16,64}$/.test(id);

// Hole cards a player never showed stay hidden, except from the player who held them.
function forViewer(h, viewer) {
  return { ...h, players: h.players.map(({ owner, ...p }) => ({ ...p, mine: owner === viewer, cards: p.shown || owner === viewer ? p.cards : [] })) };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => {
      body += c;
      if (body.length > 10_000) reject(new Error('Too large')), req.destroy();
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { reject(new Error('Bad JSON')); }
    });
  });
}

const json = (res, code, body) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
const index = path.join(__dirname, 'public', 'index.html');

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const id = url.searchParams.get('id');
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return fs.createReadStream(index).pipe(res);
  }
  // Static scripts/styles next to index.html; the pattern allows no slashes, so no path traversal.
  const asset = /^\/([\w-]+\.(js|css))$/.exec(url.pathname);
  if (req.method === 'GET' && asset && fs.existsSync(path.join(__dirname, 'public', asset[1]))) {
    res.writeHead(200, { 'Content-Type': asset[2] === 'js' ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8' });
    return fs.createReadStream(path.join(__dirname, 'public', asset[1])).pipe(res);
  }
  if (req.method === 'GET' && url.pathname === '/events') {
    if (!validId(id)) return res.writeHead(400).end();
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    clients.set(res, id);
    res.write(`data: ${JSON.stringify(state(id))}\n\n`);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/hands') {
    return json(res, 200, db.recentHands(50).map(h => ({ id: h.id, handNo: h.handNo, endedAt: h.endedAt, board: h.board, winners: h.winners })));
  }
  if (req.method === 'GET' && url.pathname === '/stats') {
    const limit = Math.min(5000, Math.max(1, Number(url.searchParams.get('limit')) || 200));
    return json(res, 200, computeStats(db.recentHands(limit).reverse()));
  }
  if (req.method === 'GET' && url.pathname === '/hand') {
    const h = db.getHand(Number(url.searchParams.get('h')));
    return h ? json(res, 200, forViewer(h, id)) : json(res, 404, { error: 'No such hand' });
  }
  if (req.method === 'POST' && url.pathname === '/api') {
    try {
      const m = await readJson(req);
      if (!validId(m.id)) throw new Error('Bad client id');
      if (!Object.hasOwn(ops, m.op)) throw new Error('Bad op');
      ops[m.op](m);
      changed();
      json(res, 200, { ok: true });
    } catch (e) {
      json(res, 400, { error: e.message });
    }
    return;
  }
  res.writeHead(404).end();
}).listen(PORT, () => console.log(`Poker table on http://localhost:${PORT}`));
