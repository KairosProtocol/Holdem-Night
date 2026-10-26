'use strict';
// Aggregates logged hand records (oldest first) into per-player stats and chart series.
// Players are keyed by name: owner ids never leave the server.

function computeStats(hands) {
  const P = new Map();
  const get = (name, bot) => {
    if (!P.has(name)) P.set(name, { name, bot: !!bot, hands: 0, tracked: 0, net: 0, bbNet: 0, potsWon: 0, vpip: 0, pfr: 0, aggr: 0, calls: 0, showdowns: 0, wonSd: 0, biggest: 0, secs: 0, decisions: 0, timeouts: 0 });
    return P.get(name);
  };
  const series = [];   // cumulative net chips per player after each hand
  const pots = [];     // total pot per hand
  const handTypes = {}; // winning hand categories at showdown

  for (const h of hands) {
    const bySeat = new Map(h.players.map(p => [p.seat, p]));
    const won = new Map(h.winners.map(w => [w.seat, w.amount]));
    const showdown = h.winners.some(w => w.hand);
    const vp = new Set(), pr = new Set();
    const tracked = h.log.some(l => l?.act); // old records carry no per-action data
    for (const l of h.log) {
      const p = l && bySeat.get(l.seat);
      if (!p || !l.act) continue; // old records have no structured actions
      const s = get(p.name, p.bot);
      s.decisions++;
      s.secs += l.secs || 0;
      if (l.text.endsWith('(timed out)')) s.timeouts++;
      if (l.street === 0 && (l.act === 'call' || l.act === 'raise')) vp.add(l.seat);
      if (l.street === 0 && l.act === 'raise') pr.add(l.seat);
      if (l.street > 0 && l.act === 'raise') s.aggr++;
      if (l.street > 0 && l.act === 'call') s.calls++;
    }
    for (const p of h.players) {
      const s = get(p.name, p.bot);
      const w = won.get(p.seat) || 0;
      const net = w - p.put;
      s.hands++;
      if (tracked) s.tracked++;
      s.net += net;
      s.bbNet += net / (h.bb || 2);
      if (net > 0) s.potsWon++;
      s.biggest = Math.max(s.biggest, w);
      if (vp.has(p.seat)) s.vpip++;
      if (pr.has(p.seat)) s.pfr++;
      if (showdown && p.shown) {
        s.showdowns++;
        if (w > 0) s.wonSd++;
      }
    }
    for (const w of h.winners) if (w.hand) handTypes[w.hand] = (handTypes[w.hand] || 0) + 1;
    pots.push({ hand: h.handNo, at: h.endedAt, pot: h.players.reduce((a, p) => a + p.put, 0) });
    series.push({ hand: h.handNo, at: h.endedAt, net: Object.fromEntries([...P.values()].map(s => [s.name, s.net])) });
  }

  const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);
  const players = [...P.values()].map(s => ({
    name: s.name, bot: s.bot, hands: s.hands, net: s.net, biggest: s.biggest, timeouts: s.timeouts, potsWon: s.potsWon,
    bb100: s.hands ? Math.round((s.bbNet / s.hands) * 1000) / 10 : null,
    vpip: pct(s.vpip, s.tracked),
    pfr: pct(s.pfr, s.tracked),
    af: s.calls ? Math.round((s.aggr / s.calls) * 10) / 10 : s.aggr ? null : 0, // null = infinite (never called)
    wsd: pct(s.wonSd, s.showdowns),
    avgSecs: s.decisions ? Math.round((s.secs / s.decisions) * 10) / 10 : null,
  })).sort((a, b) => b.net - a.net);
  return { players, series, pots, handTypes, hands: hands.length };
}

module.exports = { computeStats };
