'use strict';
const crypto = require('node:crypto');

const RANKS = '23456789TJQKA';
const HAND_NAMES = ['High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight', 'Flush', 'Full house', 'Four of a kind', 'Straight flush'];
const STREETS = ['Preflop', 'Flop', 'Turn', 'River'];
// Allowed setting ranges; times are in seconds.
const LIMITS = { sb: [1, 1e6], bb: [1, 1e6], ante: [0, 1e6], minBuy: [1, 1e7], maxBuy: [1, 1e7], actionSecs: [3, 300], bankMax: [0, 3600], bankAdd: [0, 600] };

function newDeck() {
  const d = [];
  for (const r of RANKS) for (const s of 'shdc') d.push(r + s);
  for (let i = d.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

// Returns a comparable array: [category, ...tiebreak ranks].
function score5(cards) {
  const v = cards.map(c => RANKS.indexOf(c[0])).sort((a, b) => b - a);
  const flush = cards.every(c => c[1] === cards[0][1]);
  let straight = -1;
  if (new Set(v).size === 5) {
    if (v[0] - v[4] === 4) straight = v[0];
    else if (v[0] === 12 && v[1] === 3) straight = 3; // wheel A-2-3-4-5
  }
  const counts = {};
  for (const x of v) counts[x] = (counts[x] || 0) + 1;
  const groups = Object.entries(counts).map(([r, c]) => [c, +r]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  const ranks = groups.map(g => g[1]);
  const shape = groups.map(g => g[0]).join('');
  if (straight >= 0 && flush) return [8, straight];
  if (shape === '41') return [7, ...ranks];
  if (shape === '32') return [6, ...ranks];
  if (flush) return [5, ...v];
  if (straight >= 0) return [4, straight];
  if (shape === '311') return [3, ...ranks];
  if (shape === '221') return [2, ...ranks];
  if (shape === '2111') return [1, ...ranks];
  return [0, ...v];
}

function cmp(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? -1) - (b[i] ?? -1);
    if (d) return d;
  }
  return 0;
}

function combos(arr, k, start = 0, cur = [], out = []) {
  if (cur.length === k) return out.push(cur.slice()), out;
  for (let i = start; i < arr.length; i++) {
    cur.push(arr[i]);
    combos(arr, k, i + 1, cur, out);
    cur.pop();
  }
  return out;
}

function bestHand(cards) {
  let best;
  for (const c of combos(cards, 5)) {
    const score = score5(c);
    if (!best || cmp(score, best.score) > 0) best = { score, cards: c };
  }
  best.name = HAND_NAMES[best.score[0]];
  return best;
}

class Table {
  constructor({ seats = 9, sb = 1, bb = 2, ante = 0, actionSecs = 10, bankMax = 60, bankAdd = 5, onHandEnd = () => {} } = {}) {
    Object.assign(this, { sb, bb, ante, actionSecs, bankMax, bankAdd, onHandEnd });
    this.minBuy = bb * 20;
    this.maxBuy = bb * 200;
    this.seats = Array(seats).fill(null);
    this.button = -1;
    this.hand = null;
    this.handNo = 0;
    this.pending = null; // settings waiting for the current hand to end
  }

  get live() { return this.hand && !this.hand.over; }

  get settings() {
    return Object.fromEntries(Object.keys(LIMITS).map(k => [k, this[k]]));
  }

  // Validates and applies settings now, or after the current hand.
  configure(s) {
    s = { ...this.settings, ...s }; // missing keys keep their current value
    const n = {};
    for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
      n[k] = Number(s?.[k]);
      if (!Number.isInteger(n[k]) || n[k] < lo || n[k] > hi) throw new Error(`${k} must be ${lo}–${hi}`);
    }
    if (n.sb > n.bb) throw new Error('Small blind cannot exceed big blind');
    if (n.minBuy < n.bb * 10 || n.maxBuy < n.minBuy) throw new Error('Min buy-in must be ≥ 10 big blinds and ≤ max buy-in');
    if (this.live) this.pending = n;
    else Object.assign(this, n);
    return n;
  }

  sit(seat, owner, name, buyIn, bot = false) {
    name = String(name ?? '').trim().slice(0, 20);
    buyIn = Number(buyIn);
    if (!Number.isInteger(seat) || seat < 0 || seat >= this.seats.length) throw new Error('Bad seat');
    if (this.seats[seat]) throw new Error('Seat taken');
    if (!name) throw new Error('Name required');
    if (!Number.isInteger(buyIn) || buyIn < this.minBuy || buyIn > this.maxBuy) throw new Error(`Buy-in must be ${this.minBuy}–${this.maxBuy}`);
    this.seats[seat] = { owner, name, bot, stack: buyIn, buyIn, pendingChips: 0, startStack: buyIn, cards: [], bet: 0, total: 0, inHand: false, folded: false, allIn: false, acted: false, canRaise: true, shown: false, best: null, leaving: false, sittingOut: false, bank: this.bankMax, timeouts: 0 };
  }

  // A sitting-out player keeps their seat and stack but isn't dealt in.
  setSittingOut(seat, owner, on) {
    const p = this.own(seat, owner);
    p.sittingOut = !!on;
    if (!on) p.timeouts = 0;
  }

  // Top-up / rebuy. Chips added during a hand play from the next hand.
  topUp(seat, owner, amount) {
    const p = this.own(seat, owner);
    amount = Number(amount);
    if (!Number.isInteger(amount) || amount <= 0) throw new Error('Bad amount');
    if (p.leaving) throw new Error('Seat is leaving');
    if (p.stack + p.pendingChips + amount > this.maxBuy) throw new Error(`Stack can't exceed ${this.maxBuy}`);
    p.buyIn += amount;
    if (this.live && p.inHand) p.pendingChips += amount;
    else p.stack += amount;
  }

  // Returns what the player walks away with. Mid-hand, the stack is final once they fold.
  leave(seat, owner) {
    const p = this.own(seat, owner);
    const cashOut = p.stack + p.pendingChips;
    const result = { name: p.name, cashOut, net: cashOut - p.buyIn };
    // Chips already in the pot must stay counted until the hand ends, so keep the seat until then.
    if (this.live && p.inHand) {
      p.leaving = true;
      if (!p.folded) {
        p.folded = true;
        this.log(`${p.name} folds and leaves`);
        this.advance(seat !== this.hand.toAct);
      }
    } else this.seats[seat] = null;
    return result;
  }

  own(seat, owner) {
    const p = this.seats[seat];
    if (!p || p.owner !== owner) throw new Error('Not your seat');
    return p;
  }

  canStart() {
    return !this.live && this.seats.filter(p => p && p.stack > 0 && !p.leaving && !p.sittingOut).length >= 2;
  }

  next(from, pred) {
    const n = this.seats.length;
    for (let i = 1; i <= n; i++) {
      const s = (from + i + n) % n;
      if (this.seats[s] && pred(this.seats[s])) return s;
    }
    return -1;
  }

  startHand(deck = newDeck()) {
    if (!this.canStart()) return false;
    for (const p of this.seats) if (p) Object.assign(p, { cards: [], bet: 0, total: 0, startStack: p.stack, inHand: p.stack > 0 && !p.sittingOut, folded: false, allIn: false, acted: false, canRaise: true, shown: false, best: null, bank: Math.min(this.bankMax, p.bank + this.bankAdd) });
    this.button = this.next(this.button, p => p.inHand);
    const players = this.seats.filter(p => p?.inHand);
    // Heads-up: the button posts the small blind and acts first preflop.
    const sbSeat = players.length === 2 ? this.button : this.next(this.button, p => p.inHand);
    const bbSeat = this.next(sbSeat, p => p.inHand);
    const h = this.hand = { id: ++this.handNo, deck, board: [], street: 0, currentBet: this.bb, minRaise: this.bb, toAct: bbSeat, over: false, log: [], winners: [] };
    for (let r = 0; r < 2; r++) for (const p of players) p.cards.push(deck.pop());
    this.log(`Hand #${h.id} — ${this.seats[this.button].name} has the button`);
    // Antes are dead money: into the pot, but not part of anyone's bet this street.
    if (this.ante) for (const p of players) {
      const a = Math.min(this.ante, p.stack);
      p.stack -= a;
      p.total += a;
      if (!p.stack) p.allIn = true;
      this.log(`${p.name} posts ante ${a}${p.allIn ? ' (all in)' : ''}`);
    }
    this.post(sbSeat, this.sb, 'small blind');
    this.post(bbSeat, this.bb, 'big blind');
    this.advance();
    return true;
  }

  post(seat, amount, label) {
    const p = this.seats[seat];
    const a = Math.min(amount, p.stack);
    this.pay(p, a);
    this.log(`${p.name} posts ${label} ${a}${p.allIn ? ' (all in)' : ''}`);
  }

  pay(p, a) {
    p.stack -= a;
    p.bet += a;
    p.total += a;
    if (p.stack === 0) p.allIn = true;
  }

  // secs: how long the player took to make this move.
  // extra: { seat, act, street } on player decisions, used for stats.
  log(text, secs, extra) { this.hand.log.push({ at: Date.now(), text, secs, ...extra }); }

  // When the current player runs out of move time plus time bank (null if no hand is live).
  get deadline() {
    return this.live ? this.hand.turnStart + (this.actionSecs + this.seats[this.hand.toAct].bank) * 1000 : null;
  }

  // Called once the deadline passes: check if free, otherwise fold. Returns the player.
  timeout() {
    const h = this.hand;
    const p = this.seats[h.toAct];
    this.act(h.toAct, p.owner, h.currentBet === p.bet ? 'check' : 'fold', undefined, true);
    return p;
  }

  // Reveal your hole cards to the table, any time you hold them.
  show(seat, owner) {
    const p = this.own(seat, owner);
    if (!p.cards.length || !this.hand) throw new Error('No cards to show');
    if (p.shown) throw new Error('Already shown');
    p.shown = true;
    this.log(`${p.name} shows ${p.cards.join(' ')}`);
    return p;
  }

  act(seat, owner, type, amount, timedOut = false) {
    const h = this.hand;
    const p = this.own(seat, owner);
    if (!this.live || h.toAct !== seat) throw new Error('Not your turn');
    const secs = Math.round((Date.now() - h.turnStart) / 100) / 10;
    const log = text => this.log(text + (timedOut ? ' (timed out)' : ''), secs, { seat, act: type, street: h.street });
    const toCall = h.currentBet - p.bet;
    if (type === 'allin') {
      type = p.stack <= toCall ? 'call' : 'raise';
      amount = p.bet + p.stack;
    }
    switch (type) {
      case 'fold':
        p.folded = true;
        log(`${p.name} folds`);
        break;
      case 'check':
        if (toCall > 0) throw new Error('Cannot check');
        log(`${p.name} checks`);
        break;
      case 'call': {
        if (toCall <= 0) throw new Error('Nothing to call');
        const a = Math.min(toCall, p.stack);
        this.pay(p, a);
        log(`${p.name} calls ${a}${p.allIn ? ' (all in)' : ''}`);
        break;
      }
      case 'raise': {
        const max = p.bet + p.stack;
        amount = Number(amount);
        if (!p.canRaise || max <= h.currentBet) throw new Error('Cannot raise');
        if (!Number.isInteger(amount)) throw new Error('Bad amount');
        const to = Math.min(amount, max);
        if (to < h.currentBet + h.minRaise && to < max) throw new Error(`Minimum is ${h.currentBet + h.minRaise}`);
        const raise = to - h.currentBet;
        const full = raise >= h.minRaise;
        // shortcut: a short all-in only reopens raising for players who haven't acted; cumulative short raises are not summed (TDA rule), fine for home games.
        for (const o of this.seats) {
          if (!o || o === p || !o.inHand || o.folded || o.allIn) continue;
          if (full) o.canRaise = true;
          else if (o.acted) o.canRaise = false;
          o.acted = false;
        }
        if (full) h.minRaise = raise;
        const verb = h.currentBet === 0 ? 'bets' : 'raises to';
        h.currentBet = to;
        this.pay(p, to - p.bet);
        log(`${p.name} ${verb} ${to}${p.allIn ? ' (all in)' : ''}`);
        break;
      }
      default:
        throw new Error('Bad action');
    }
    p.acted = true;
    p.bank = Math.max(0, Math.round(p.bank - Math.max(0, secs - this.actionSecs))); // overtime comes out of the bank
    p.timeouts = timedOut ? p.timeouts + 1 : 0;
    this.advance();
  }

  // Moves the turn to the next player who owes an action, dealing streets / finishing as needed.
  advance(keep = false) {
    const h = this.hand;
    for (;;) {
      const live = this.seats.filter(p => p?.inHand && !p.folded);
      if (live.length === 1) return this.finish();
      const canAct = live.filter(p => !p.allIn).length;
      const pending = p => p.inHand && !p.folded && !p.allIn && (p.bet < h.currentBet || (!p.acted && canAct > 1));
      if (keep && pending(this.seats[h.toAct])) return;
      const nxt = this.next(h.toAct, pending);
      if (nxt !== -1) return void Object.assign(h, { toAct: nxt, turnStart: Date.now() });
      for (const p of this.seats) if (p) Object.assign(p, { bet: 0, acted: false, canRaise: true });
      h.currentBet = 0;
      h.minRaise = this.bb;
      if (h.street === 3) return this.finish();
      h.street++;
      h.deck.pop(); // burn
      h.board.push(...h.deck.splice(h.street === 1 ? -3 : -1));
      this.log(`${STREETS[h.street]}: ${h.board.join(' ')}`);
      h.toAct = this.button;
      keep = false;
    }
  }

  finish() {
    const h = this.hand;
    const n = this.seats.length;
    h.over = true;
    const inHand = this.seats.map((p, i) => ({ p, i })).filter(x => x.p?.inHand);
    const live = inHand.filter(x => !x.p.folded);
    const showdown = live.length > 1;
    if (showdown) for (const { p } of live) {
      p.shown = true;
      p.best = bestHand([...p.cards, ...h.board]);
    }
    // Side pots: one pot per distinct all-in level among live players.
    const levels = [...new Set(live.map(x => x.p.total))].sort((a, b) => a - b);
    const pots = [];
    let prev = 0;
    for (const L of levels) {
      let amount = 0;
      for (const { p } of inHand) amount += Math.max(0, Math.min(p.total, L) - prev);
      pots.push({ amount, eligible: live.filter(x => x.p.total >= L) });
      prev = L;
    }
    // Chips above the top live level (a player who left after out-betting everyone) go to the last pot.
    for (const { p } of inHand) pots.at(-1).amount += Math.max(0, p.total - prev);

    const dist = i => (i - this.button - 1 + n) % n; // odd chips go to first winner left of the button
    const won = {};
    pots.forEach((pot, k) => {
      let winners = pot.eligible;
      if (showdown && winners.length > 1) {
        const top = winners.reduce((b, x) => (cmp(x.p.best.score, b) > 0 ? x.p.best.score : b), winners[0].p.best.score);
        winners = winners.filter(x => cmp(x.p.best.score, top) === 0);
      }
      winners.sort((a, b) => dist(a.i) - dist(b.i));
      const share = Math.floor(pot.amount / winners.length);
      let odd = pot.amount - share * winners.length;
      for (const w of winners) {
        const amt = share + (odd-- > 0 ? 1 : 0);
        w.p.stack += amt;
        won[w.i] = (won[w.i] || 0) + amt;
      }
      const label = pots.length > 1 ? (k === 0 ? ' main pot' : ` side pot ${k}`) : '';
      const how = showdown && pot.eligible.length > 1 ? ` with ${winners[0].p.best.name}` : '';
      this.log(`${winners.map(w => w.p.name).join(' & ')} win${winners.length > 1 ? '' : 's'}${label} (${pot.amount})${how}`);
    });
    h.winners = Object.entries(won).map(([i, amount]) => ({ seat: +i, name: this.seats[i].name, amount, hand: this.seats[i].best?.name ?? null }));

    this.onHandEnd({
      id: h.id,
      sb: this.sb,
      bb: this.bb,
      board: h.board,
      players: inHand.map(({ p, i }) => ({ seat: i, name: p.name, owner: p.owner, bot: p.bot, cards: p.cards, shown: p.shown, startStack: p.startStack, put: p.total, stack: p.stack })),
      winners: h.winners,
      log: h.log,
    });
    for (const p of this.seats) if (p) Object.assign(p, { total: 0, stack: p.stack + p.pendingChips, pendingChips: 0 });
    this.seats.forEach((p, i) => { if (p?.leaving) this.seats[i] = null; });
    if (this.pending) Object.assign(this, this.pending), this.pending = null;
  }

  // Per-viewer state: hole cards are only included for the viewer's own seats or after showdown.
  view(owner) {
    const h = this.hand;
    const live = this.live;
    const me = live ? this.seats[h.toAct] : null;
    const options = me && me.owner === owner ? {
      seat: h.toAct,
      toCall: Math.min(h.currentBet - me.bet, me.stack),
      canRaise: me.canRaise && me.bet + me.stack > h.currentBet,
      minTo: Math.min(h.currentBet + h.minRaise, me.bet + me.stack),
      maxTo: me.bet + me.stack,
      currentBet: h.currentBet,
      pot: this.seats.reduce((s, p) => s + (p?.total ?? 0), 0),
    } : null;
    return {
      pending: this.pending,
      ...this.settings,
      button: this.button, handNo: this.handNo,
      turn: live ? { seat: h.toAct, deadline: this.deadline, actionEnds: h.turnStart + this.actionSecs * 1000, now: Date.now() } : null,
      board: h?.board ?? [],
      over: !live,
      toAct: live ? h.toAct : -1,
      pot: live ? this.seats.reduce((s, p) => s + (p ? p.total - p.bet : 0), 0) : 0,
      log: h?.log.slice(-40) ?? [],
      winners: h?.over ? h.winners : [],
      options,
      seats: this.seats.map(p => p && {
        name: p.name, stack: p.stack, bet: p.bet, folded: p.folded, allIn: p.allIn, inHand: p.inHand, leaving: p.leaving,
        mine: p.owner === owner, bot: p.bot, shown: p.shown, bank: p.bank, sittingOut: p.sittingOut,
        ...(p.owner === owner && { buyIn: p.buyIn, pendingChips: p.pendingChips, code: p.code }),
        cards: p.owner === owner || p.shown ? p.cards : (live && p.inHand && !p.folded ? ['??', '??'] : []),
        best: p.best ? p.best.name : (p.owner === owner && p.inHand && h.board.length ? bestHand([...p.cards, ...h.board]).name : null),
      }),
    };
  }
}

module.exports = { Table, bestHand, score5, cmp, newDeck };
