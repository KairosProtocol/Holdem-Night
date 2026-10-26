'use strict';
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(process.env.POKER_DB || path.join(__dirname, 'poker.db'));
db.exec(`CREATE TABLE IF NOT EXISTS hands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hand_no INTEGER,
  ended_at TEXT DEFAULT CURRENT_TIMESTAMP,
  board TEXT,
  record TEXT -- full JSON: players (incl. owner ids and mucked cards), winners, action log
);
CREATE TABLE IF NOT EXISTS chat (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT DEFAULT CURRENT_TIMESTAMP,
  name TEXT,
  text TEXT
)`);
const insertHand = db.prepare('INSERT INTO hands (hand_no, board, record) VALUES (?, ?, ?)');
const insertChat = db.prepare('INSERT INTO chat (name, text) VALUES (?, ?)');
const recent = db.prepare('SELECT id, ended_at, record FROM hands ORDER BY id DESC LIMIT ?');
const one = db.prepare('SELECT id, ended_at, record FROM hands WHERE id = ?');

function parse(row) {
  if (!row) return null;
  const r = JSON.parse(row.record);
  return { ...r, handNo: r.id, id: row.id, endedAt: row.ended_at.replace(' ', 'T') + 'Z' };
}

exports.logHand = r => insertHand.run(r.id, r.board.join(' '), JSON.stringify(r));
const update = db.prepare('UPDATE hands SET record = ? WHERE id = ?');
exports.updateHand = (rowId, r) => update.run(JSON.stringify(r), rowId);
exports.logChat = (name, text) => insertChat.run(name, text);
exports.recentHands = (limit = 50) => recent.all(limit).map(parse);
exports.getHand = id => parse(one.get(id));
