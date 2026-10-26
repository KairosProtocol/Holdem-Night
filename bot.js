'use strict';
// Very basic test bot: rough hand strength vs. pot odds, plus some noise.
const { bestHand } = require('./engine');

const RANKS = '23456789TJQKA';
const NAMES = ['Ada', 'Bluffy', 'Chip', 'Dot', 'Echo', 'Fizz', 'Gus', 'Hex', 'Ivy'];

function strength(cards, board) {
  if (!board.length) {
    const [a, b] = cards.map(c => RANKS.indexOf(c[0])).sort((x, y) => y - x);
    if (a === b) return 0.5 + a / 24;
    return (a + b) / 30 + (cards[0][1] === cards[1][1] ? 0.06 : 0) + (a - b === 1 ? 0.04 : 0);
  }
  return [0.15, 0.45, 0.65, 0.78, 0.85, 0.88, 0.93, 0.97, 1][bestHand([...cards, ...board]).score[0]];
}

// o: the options object from Table.view() for the bot's seat.
function decide(o, cards, board, rand = Math.random) {
  const s = strength(cards, board) + (rand() - 0.5) * 0.2;
  const r = rand();
  if (o.canRaise && s > 0.75 && r < 0.6) {
    const to = Math.round(o.currentBet + (o.pot + o.toCall) * (0.5 + r));
    return { type: 'raise', amount: Math.max(o.minTo, Math.min(o.maxTo, to)) };
  }
  if (o.toCall === 0) return o.canRaise && s > 0.55 && r < 0.3 ? { type: 'raise', amount: o.minTo } : { type: 'check' };
  return s > o.toCall / (o.pot + o.toCall) + 0.2 || r < 0.05 ? { type: 'call' } : { type: 'fold' };
}

module.exports = { decide, NAMES };
