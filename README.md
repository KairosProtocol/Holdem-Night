# Hold'em Night

No-limit Texas Hold'em for a group of friends. Node 22.13+, no npm dependencies.

```
npm start   # http://localhost:3000 — friends on your network use http://<your-ip>:3000
npm test
```

Hosted on Render from `render.yaml` (free plan: sleeps after 15 idle minutes, and hand history resets when it restarts).

- `engine.js` — rules: blinds, betting, min-raise, side pots, showdown, hand ranking.
- `server.js` — HTTP + Server-Sent Events; each browser only receives its own hole cards.
- `bot.js` — very basic test bot (hand strength vs. pot odds).
- `db.js` — every finished hand (`hands` table, full JSON record) and chat message (`chat` table) is logged to `poker.db`.
- `public/` — `index.html` (landing, table, menu, hand viewer; `/?hand=<id>` is the pop-out), `themes.css`, `charts.js`, `sound.js`.

Click any empty "Sit" to take a seat (or seat a bot there); you can sit in several seats from one browser and act for each.

**Move clock:** 10s per move plus a 60s time bank; each hand adds 5s to everyone's bank (capped at the max).
Running out checks if free, otherwise folds; two timeouts in a row and the player is sat out (seat and stack kept).

**Rejoining:** every seat has a rejoin code (Menu → My chips). Enter it on the start screen of any browser to take
the seat back with the same stack. The same browser keeps its seats automatically.

**Stats & graphs** (Menu): per-player VPIP, PFR, aggression, showdown win %, bb/100, decision speed and more,
plus charts, computed from the hand log by `stats.js`. A live chip-count graph sits beside the table.

**Graphics & sound** (Menu, saved per browser): backgrounds (or upload your own), felt colours, card faces and
backs, card size, animations on/off, and synthesized sound packs (`public/sound.js`, no audio files).

**Votes:** settings changes and kicks are put to a vote shown in a bar under the header. Each browser with an active
seat gets one vote, every bot seat votes yes, the player being kicked can't vote, and a majority passes.

**Settings** (blinds, ante, buy-in range, move time, time bank) change by majority vote of seated players, or immediately with the
override password (`hypergamicFoid`, or set `POKER_PASSWORD=...` to change it).
Changes apply from the next hand.
