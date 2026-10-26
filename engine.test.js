'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Table, bestHand, cmp } = require('./engine');

const score = cards => bestHand(cards.split(' ')).score;

test('hand ranking', () => {
  assert.equal(bestHand('As Ks Qs Js Ts 2d 3c'.split(' ')).name, 'Straight flush');
  assert(cmp(score('Ah 2d 3c 4s 5h Kd Kc'), score('2h 3d 4c 5s 6h Kd Qc')) < 0, 'wheel loses to 6-high straight');
  assert(cmp(score('Ah Kh 2h 7h 9h Qd Qc'), score('9d Td Jc Qs Kh 2c 2s')) > 0, 'flush beats straight');
  assert(cmp(score('Ah Ad Kc Kd 9s 2c 3c'), score('Ah Ad Kc Kd 8s 2c 3c')) > 0, 'two pair kicker');
  assert(cmp(score('Kh Kd Kc 2s 2h 7c 8c'), score('Ah Ad Ac Qs Jh 7c 8c')) > 0, 'full house beats trips');
  assert.equal(cmp(score('Ah Kd 2c 3s 9h Tc Jc'), score('As Kc 2d 3h 9s Th Jh')), 0, 'split');
});

function table(...stacks) {
  const t = new Table();
  stacks.forEach((s, i) => t.sit(i, 'me', 'P' + i, s));
  return t;
}

test('side pots with three players', () => {
  const t = table(40, 100, 100);
  t.startHand();
  const h = t.hand;
  assert.equal(t.button, 0);
  assert.equal(h.toAct, 0, 'UTG (button in 3-handed) acts first');
  [t.seats[0].cards, t.seats[1].cards, t.seats[2].cards] = [['As', 'Ah'], ['Ks', 'Kh'], ['Qs', 'Qh']];
  h.deck = ['Jd', '8d', '9c', '5c', '7h', '3d', '2c', '4c'];
  t.act(0, 'me', 'allin');
  t.act(1, 'me', 'allin');
  t.act(2, 'me', 'call');
  assert(h.over);
  assert.deepEqual(h.board, ['7h', '3d', '2c', '9c', 'Jd']);
  assert.deepEqual(t.seats.slice(0, 3).map(p => p.stack), [120, 120, 0]);
});

test('heads-up: button posts SB and acts first preflop, last postflop', () => {
  const t = table(100, 100);
  t.startHand();
  assert.equal(t.button, 0);
  assert.equal(t.seats[0].bet, 1);
  assert.equal(t.seats[1].bet, 2);
  assert.equal(t.hand.toAct, 0);
  t.act(0, 'me', 'call');
  assert.equal(t.hand.toAct, 1, 'BB gets the option');
  t.act(1, 'me', 'check');
  assert.equal(t.hand.board.length, 3);
  assert.equal(t.hand.toAct, 1, 'BB acts first postflop');
});

test('everyone folds to the big blind', () => {
  const t = table(100, 100, 100);
  t.startHand();
  t.act(0, 'me', 'fold');
  t.act(1, 'me', 'fold');
  assert(t.hand.over);
  assert.deepEqual(t.seats.slice(0, 3).map(p => p.stack), [100, 99, 101]);
});

test('min raise and turn enforcement', () => {
  const t = table(100, 100, 100);
  t.startHand();
  assert.throws(() => t.act(1, 'me', 'call'), /turn/);
  assert.throws(() => t.act(0, 'x', 'call'), /seat/);
  assert.throws(() => t.act(0, 'me', 'raise', 3), /Minimum/);
  t.act(0, 'me', 'raise', 6);
  assert.throws(() => t.act(1, 'me', 'raise', 9), /Minimum is 10/);
});

test('top-up mid-hand waits for the next hand; settings too', () => {
  const t = table(100, 100);
  t.startHand();
  t.topUp(0, 'me', 50);
  assert.throws(() => t.topUp(1, 'me', 500), /exceed/);
  t.configure({ sb: 5, bb: 10, minBuy: 100, maxBuy: 1000 });
  assert.equal(t.bb, 2, 'blinds unchanged mid-hand');
  t.act(0, 'me', 'fold');
  assert.equal(t.seats[0].stack, 149);
  assert.equal(t.bb, 10);
  assert.deepEqual(t.leave(0, 'me'), { name: 'P0', cashOut: 149, net: -1 });
  assert.throws(() => t.configure({ sb: 5, bb: 10, minBuy: 50, maxBuy: 1000 }), /Min buy-in/);
});

test('move timer, time bank and timeouts', () => {
  const t = table(100, 100, 100);
  t.startHand();
  assert.equal(t.seats[0].bank, 60, 'bank is capped at the max');
  t.hand.turnStart = Date.now() - 25_000; // 10s move time + 15s of bank
  t.act(0, 'me', 'call');
  assert.equal(t.seats[0].bank, 45);
  assert.equal(t.deadline, t.hand.turnStart + 70_000, 'P1 has 10s + 60s bank');
  t.hand.turnStart -= 70_000;
  t.timeout();
  assert(t.seats[1].folded, 'facing a bet, a timeout folds');
  assert.equal(t.seats[1].bank, 0);
  assert.equal(t.seats[1].timeouts, 1);
  assert.match(t.hand.log.at(-1).text, /timed out/);
  t.timeout(); // BB can check for free
  assert(!t.seats[2].folded);
  t.act(2, 'me', 'fold'); // flop: first to act after the button
  t.startHand();
  assert.equal(t.seats[1].bank, 5, 'each hand adds 5s');
  assert.equal(t.seats[0].bank, 50);
  t.show(0, 'me');
  assert.deepEqual(t.view('other').seats[0].cards, t.seats[0].cards, 'shown cards are public');
  assert.throws(() => t.configure({ ...t.settings, actionSecs: 1 }), /actionSecs/);
});

test('sitting out skips the deal but keeps the seat', () => {
  const t = table(100, 100, 100);
  t.setSittingOut(1, 'me', true);
  t.startHand();
  assert(!t.seats[1].inHand);
  assert.equal(t.seats[1].stack, 100);
  t.setSittingOut(2, 'me', true);
  t.act(t.hand.toAct, 'me', 'fold');
  assert(!t.canStart(), 'only one active player');
  t.setSittingOut(1, 'me', false);
  assert(t.canStart());
});

test('bots play legal moves and conserve chips', () => {
  const { decide } = require('./bot');
  const t = new Table({ seats: 6 });
  for (let i = 0; i < 6; i++) t.sit(i, 'bot', 'B' + i, 100, true);
  for (let n = 0; n < 500; n++) {
    t.seats.forEach(p => { if (!p.stack) t.topUp(t.seats.indexOf(p), 'bot', 100); });
    t.startHand();
    while (t.live) {
      const seat = t.hand.toAct, p = t.seats[seat];
      const d = decide(t.view('bot').options, p.cards, t.hand.board);
      t.act(seat, 'bot', d.type, d.amount);
    }
    assert.equal(t.seats.reduce((s, p) => s + p.stack, 0), t.seats.reduce((s, p) => s + p.buyIn, 0));
  }
});

test('antes go to the pot as dead money', () => {
  const t = new Table({ ante: 5 });
  [100, 100, 3].forEach((s, i) => t.sit(i, 'me', 'P' + i, 40 + s));
  t.startHand();
  assert.equal(t.hand.currentBet, 2, 'ante is not part of the bet to call');
  assert.equal(t.seats[0].bet, 0);
  t.act(0, 'me', 'fold');
  t.act(1, 'me', 'fold');
  assert.deepEqual(t.seats.slice(0, 3).map(p => p.stack), [135, 134, 54], 'BB collects 3 antes + SB');
  assert.equal(t.hand.log.find(l => l.act === 'fold').street, 0);
});

test('stats from logged hands', () => {
  const { computeStats } = require('./stats');
  const hands = [];
  const t = new Table({ onHandEnd: r => hands.push({ ...r, handNo: r.id }) });
  t.sit(0, 'me', 'A', 100); t.sit(1, 'me', 'B', 100); t.sit(2, 'me', 'C', 100);
  t.startHand();
  t.act(0, 'me', 'raise', 6); // A opens
  t.act(1, 'me', 'fold');
  t.act(2, 'me', 'fold');
  const s = computeStats(hands);
  const A = s.players.find(p => p.name === 'A');
  assert.deepEqual([A.hands, A.net, A.vpip, A.pfr, A.potsWon], [1, 3, 100, 100, 1]);
  assert.equal(s.players.find(p => p.name === 'C').net, -2);
  assert.equal(s.series[0].net.B, -1);
  assert.equal(s.pots[0].pot, 9);
});

test('random play conserves chips', () => {
  const t = new Table({ seats: 6, ante: 1 });
  let total = 0;
  for (let i = 0; i < 6; i++) t.sit(i, 'o' + (i % 2), 'P' + i, 100), total += 100;
  for (let n = 0; n < 2000; n++) {
    t.seats.forEach((p, i) => {
      if (p && p.stack === 0) { t.leave(i, p.owner); t.sit(i, 'o' + (i % 2), 'P' + i, 100); total += 100; }
    });
    assert(t.startHand());
    const leavers = [];
    for (let steps = 0; t.live; steps++) {
      assert(steps < 200, 'hand terminates');
      const seat = t.hand.toAct;
      const p = t.seats[seat];
      const o = t.view(p.owner).options;
      const r = Math.random();
      if (r < 0.01) t.leave(seat, p.owner), leavers.push(p);
      else if (r < 0.15) t.act(seat, p.owner, 'fold');
      else if (r < 0.3 && o.canRaise) t.act(seat, p.owner, 'raise', o.minTo + Math.floor(Math.random() * (o.maxTo - o.minTo + 1)));
      else if (r < 0.35 && o.canRaise) t.act(seat, p.owner, 'allin');
      else t.act(seat, p.owner, o.toCall ? 'call' : 'check');
    }
    for (const p of leavers) total -= p.stack; // they walk away with their stack
    assert.equal(t.seats.reduce((s, p) => s + (p?.stack ?? 0), 0), total, `hand ${n}`);
    // Refill anyone who left so the table keeps running.
    for (let i = 0; i < 6; i++) if (!t.seats[i]) { t.sit(i, 'o' + (i % 2), 'P' + i, 100); total += 100; }
  }
});
