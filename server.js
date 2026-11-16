const express = require('express'), http = require('http'), { Server } = require('socket.io'),
  QR = require('qrcode'), os = require('os'), path = require('path');
const app = express(), srv = http.createServer(app), io = new Server(srv);
const PORT = process.env.PORT || 3000, A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

// ---- Dictionnaire (sans accents, 3 à 6 lettres) ----
const norm = w => w.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/œ/g, 'oe').replace(/æ/g, 'ae').toUpperCase();
const DICT = new Set();
for (const w of require('an-array-of-french-words')) if (/^[a-zéèêëàâäîïôöùûüçœæ]{3,6}$/.test(w)) DICT.add(norm(w));
console.log('Dictionnaire :', DICT.size, 'mots');

// Mots de départ courants (les réponses sont validées avec le dictionnaire complet)
const ST = {};
Object.entries({
  3: 'ROI LIT VIN MER SEL BUS RAT DOS NEZ RUE FEU JEU EAU AIR MUR PIE ANE ARC BAL BOL CRI DON FIN GAZ LAC MOT NID PEU SAC',
  4: 'CHAT PAIN LUNE MAIN PORT VENT ROSE TOUR BOIS FILM SOIR PAGE LOUP PORC RIRE CAFE JOUR NOIR CIEL DENT FOUR GARE MOIS PEUR TAXI ROBE MUSE LION',
  5: 'TABLE PORTE LIVRE TERRE PLAGE CHIEN FLEUR POMME ROUTE NUAGE SALLE TRAIN PLUME CARTE LAINE FORET GRAND PIANO ROUGE TIGRE VERRE FRUIT SABLE',
  6: 'MAISON JARDIN CHEVAL BATEAU MOTEUR CHAISE SOLEIL PLANTE VALISE ORANGE BANANE BOUTON CAMION TOMATE POULET CASQUE'
}).forEach(([l, s]) => ST[l] = s.split(' '));

// 20 défis par manche : s = 1 lettre à changer, t = 2 lettres à changer, a = 1 lettre à ajouter
const SPECS = [['s',4],['s',4],['a',3],['s',4],['s',4],['a',3],['s',5],['a',4],['s',5],['a',4],
  ['s',5],['a',4],['t',5],['s',6],['a',5],['t',5],['s',6],['t',5],['a',5],['t',6]];

function solve(w, t, pos) {
  const out = new Set();
  if (t === 'a') { for (const c of A) { const x = w.slice(0, pos[0]) + c + w.slice(pos[0]); if (DICT.has(x)) out.add(x); } }
  else { const rec = (i, cur) => {
    if (i === pos.length) { if (DICT.has(cur)) out.add(cur); return; }
    for (const c of A) if (c !== w[pos[i]]) rec(i + 1, cur.slice(0, pos[i]) + c + cur.slice(pos[i] + 1));
  }; rec(0, w); }
  return [...out];
}
function mk(t, l, used, min, n = 400) {
  const pool = ST[l];
  for (let k = 0; k < n; k++) {
    const w = pool[Math.random() * pool.length | 0]; if (used.has(w)) continue;
    let pos;
    if (t === 'a') pos = [Math.random() * (l + 1) | 0];
    else if (t === 's') pos = [Math.random() * l | 0];
    else { const a = Math.random() * l | 0; let b; do b = Math.random() * l | 0; while (b === a); pos = [a, b].sort((x, y) => x - y); }
    const sols = solve(w, t, pos);
    if (sols.length >= min) return { word: w, type: t, pos, sols };
  }
  return null;
}
function gen() {
  const used = new Set(), out = [];
  for (const [t, l] of SPECS) {
    const c = mk(t, l, used, out.length < 12 ? 2 : 1) || mk(t, l, used, 1, 1500) || mk('s', 4, new Set(), 1, 5000);
    used.add(c.word); out.push(c);
  }
  return out;
}

// ---- Salons ----
const MODES = { solo: { min: 1, max: 1 }, duel: { min: 2, max: 2 }, duo: { min: 4, max: 4 }, group: { min: 2, max: 20 } };
const rooms = new Map(), rid = () => Math.random().toString(36).slice(2, 10);
const CH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() { let c; do c = Array.from({ length: 4 }, () => CH[Math.random() * CH.length | 0]).join(''); while (rooms.has(c)); return c; }
function newRoom() {
  const r = { code: newCode(), tok: rid(), phase: 'lobby', mode: 'group', dur: 25, auto: false, round: 1, idx: 0, ch: [],
    players: new Map(), t: null, startAt: 0, endAt: 0, ord: 0, res: null, winners: [], last: Date.now() };
  rooms.set(r.code, r); return r;
}
const sorted = r => [...r.players.values()].sort((a, b) => b.score - a.score || a.ms - b.ms);
const teamScore = (r, t) => sorted(r).filter(p => p.team === t).reduce((s, p) => s + p.score, 0);
function pub(r) {
  const c = r.ch[r.idx], showG = r.phase === 'result' || r.phase === 'roundEnd';
  return { code: r.code, phase: r.phase, mode: r.mode, dur: r.dur, auto: r.auto, round: r.round, idx: r.idx, total: 20,
    now: Date.now(), startAt: r.startAt, endAt: r.endAt,
    players: sorted(r).map((p, i) => ({ id: p.id, name: p.name, av: p.av, col: p.col, team: p.team, on: p.on,
      score: p.score, ok: p.ok, ms: p.ms, rank: i + 1, ans: p.ans, gain: showG ? p.gain : 0 })),
    teams: r.mode === 'duo' ? ['A', 'B'].map(t => ({ t, score: teamScore(r, t) })) : null,
    ch: c && ['playing', 'result', 'roundEnd'].includes(r.phase) ? { word: c.word, type: c.type, pos: c.pos } : null,
    res: showG ? r.res : null, winners: r.winners };
}
function emit(r) { r.last = Date.now(); io.to(r.code).emit('state', pub(r)); }
function balance(r) { let i = 0; for (const p of r.players.values()) p.team = r.mode === 'duo' ? (i++ % 2 ? 'B' : 'A') : null; }
function resetScores(r) { for (const p of r.players.values()) Object.assign(p, { score: 0, ok: 0, ms: 0, ans: null, gain: 0 }); }

function begin(r) { clearTimeout(r.t); resetScores(r); r.ch = gen(); r.idx = 0; r.res = null; r.phase = 'ready';
  if (r.auto) r.t = setTimeout(() => launch(r), 2500); }
function launch(r) {
  if (r.phase !== 'ready') return;
  clearTimeout(r.t);
  for (const p of r.players.values()) Object.assign(p, { ans: null, gain: 0, bad: 0, lock: 0, ord: 0, w: null });
  r.ord = 0; r.phase = 'countdown'; r.startAt = Date.now() + 3500; r.endAt = r.startAt + r.dur * 1000;
  emit(r);
  r.t = setTimeout(() => { r.phase = 'playing'; emit(r); r.t = setTimeout(() => fin(r), r.dur * 1000); }, 3500);
}
function fin(r) {
  if (r.phase !== 'playing') return;
  clearTimeout(r.t);
  const c = r.ch[r.idx], fast = [];
  for (const p of r.players.values()) {
    if (p.ans != null) { p.score += p.gain; p.ok++; p.ms += p.ans; fast.push({ id: p.id, w: p.w, ms: p.ans, gain: p.gain }); }
    else p.gain = 0;
  }
  fast.sort((a, b) => a.ms - b.ms);
  r.res = { sols: c.sols.slice(0, 6), fast }; r.phase = 'result'; emit(r);
  if (r.auto) r.t = setTimeout(() => next(r), 7000);
}
function next(r) {
  clearTimeout(r.t);
  if (r.idx >= 19) {
    r.phase = 'roundEnd';
    const top = sorted(r)[0];
    const name = r.mode === 'duo' ? (teamScore(r, 'A') >= teamScore(r, 'B') ? 'Équipe Rouge' : 'Équipe Blanche') : top ? top.name : '';
    r.winners.push({ round: r.round, name });
  } else { r.idx++; r.phase = 'ready'; if (r.auto) r.t = setTimeout(() => launch(r), 2500); }
  emit(r);
}
const chk = r => { if (r.phase !== 'playing') return;
  const on = [...r.players.values()].filter(p => p.on);
  if (on.length && on.every(p => p.ans != null)) fin(r); };

// ---- HTTP ----
const lan = () => Object.values(os.networkInterfaces()).flat()
  .filter(i => (i.family === 'IPv4' || i.family === 4) && !i.internal).map(i => i.address);
app.get(['/', '/host', '/play', '/screen'], (q, s) => s.sendFile(path.join(__dirname, 'index.html')));
app.get('/api/info', (q, s) => s.json({ lan: lan(), port: PORT, pub: process.env.PUBLIC_URL || null }));
app.get('/api/qr', async (q, s) => {
  const t = String(q.query.t || '');
  if (!/^https?:\/\//.test(t) || t.length > 300) return s.status(400).end();
  s.type('image/svg+xml').send(await QR.toString(t, { type: 'svg', margin: 1, color: { dark: '#000000', light: '#ffffff' } }));
});

// ---- Temps réel ----
io.on('connection', s => {
  s.on('create', cb => { const r = newRoom(); s.data = { room: r.code, host: 1 }; s.join(r.code); cb({ code: r.code, tok: r.tok }); emit(r); });
  s.on('resume', (d, cb) => {
    const r = rooms.get(d && d.code);
    if (!r || r.tok !== d.tok) return cb({ err: 1 });
    s.data = { room: r.code, host: 1 }; s.join(r.code); cb({ code: r.code }); emit(r);
  });
  s.on('watch', (d, cb) => {
    const r = rooms.get(String((d && d.code) || '').toUpperCase());
    if (!r) return cb({ err: 'Code inconnu' });
    s.data = { room: r.code }; s.join(r.code); cb({}); emit(r);
  });
  s.on('join', (d, cb) => {
    d = d || {};
    const r = rooms.get(String(d.code || '').toUpperCase());
    if (!r) return cb({ err: 'Code inconnu' });
    let p = d.pid && r.players.get(d.pid);
    if (p) { p.on = true; p.sid = s.id; clearTimeout(p.rm); }
    else {
      if (!['lobby', 'roundEnd'].includes(r.phase)) return cb({ err: 'Partie en cours' });
      if (r.players.size >= MODES[r.mode].max) return cb({ err: 'Salon complet' });
      let name = String(d.name || '').replace(/[<>&"]/g, '').trim().slice(0, 14) || 'Joueur', n = name, k = 2;
      while ([...r.players.values()].some(q => q.name === n)) n = name.slice(0, 12) + k++;
      const vs = [...r.players.values()];
      p = { id: rid(), sid: s.id, name: n, av: Math.min(23, Math.max(0, d.av | 0)), col: Math.min(5, Math.max(0, d.col | 0)),
        on: true, score: 0, ok: 0, ms: 0, ans: null, gain: 0, bad: 0, lock: 0, ord: 0,
        team: r.mode === 'duo' ? (vs.filter(q => q.team === 'A').length <= vs.filter(q => q.team === 'B').length ? 'A' : 'B') : null };
      r.players.set(p.id, p);
    }
    s.data = { room: r.code, pid: p.id }; s.join(r.code); cb({ pid: p.id }); emit(r);
  });
  s.on('ans', (d, cb) => {
    const r = rooms.get(s.data.room), p = r && r.players.get(s.data.pid);
    if (!p || r.phase !== 'playing' || p.ans != null) return cb({ msg: 'Défi terminé' });
    const c = r.ch[r.idx], n = c.type === 't' ? 2 : 1, L = d && d.l, t = Date.now();
    if (t < p.lock) return cb({ msg: 'Trop vite' });
    if (!Array.isArray(L) || L.length !== n || !L.every(x => typeof x === 'string' && /^[A-Z]$/.test(x))) return cb({ msg: 'Remplis les lettres' });
    let w = c.word;
    if (c.type === 'a') w = w.slice(0, c.pos[0]) + L[0] + w.slice(c.pos[0]);
    else c.pos.forEach((q, i) => w = w.slice(0, q) + L[i] + w.slice(q + 1));
    if (!c.sols.includes(w)) { p.bad++; p.lock = t + 700; return cb({ msg: 'Mot inconnu' }); }
    const el = Math.max(0, t - r.startAt);
    p.ans = el; p.w = w; p.ord = ++r.ord;
    p.gain = Math.max(30, 100 + Math.round(100 * (1 - el / (r.dur * 1000))) + ([40, 25, 10][p.ord - 1] || 0) - 20 * p.bad);
    cb({ ok: 1 }); emit(r); chk(r);
  });
  // Mode animateur : commandes réservées au créateur du salon
  s.on('cmd', (d, cb) => {
    const r = rooms.get(s.data.room); cb = cb || (() => {});
    if (!r || !s.data.host || !d) return cb({});
    const M = MODES[r.mode], n = r.players.size;
    const need = n < M.min || n > M.max ? `Il faut ${M.min === M.max ? M.min : M.min + ' à ' + M.max} joueur(s) pour ce mode (actuellement ${n})` : null;
    switch (d.a) {
      case 'mode':
        if (r.phase !== 'lobby' || !MODES[d.v]) break;
        if (n > MODES[d.v].max) return cb({ err: `Retire des joueurs d'abord (max ${MODES[d.v].max})` });
        r.mode = d.v; balance(r); break;
      case 'dur': if ([15, 25, 40].includes(d.v)) r.dur = d.v; break;
      case 'auto': r.auto = !!d.v; break;
      case 'kick': { const p = r.players.get(d.v); if (p) { io.to(p.sid).emit('kicked'); r.players.delete(p.id); if (r.mode === 'duo') balance(r); } break; }
      case 'team': { const p = r.players.get(d.v);
        if (p && r.mode === 'duo' && r.phase === 'lobby') {
          const o = p.team === 'A' ? 'B' : 'A';
          if ([...r.players.values()].filter(q => q.team === o).length < 2) p.team = o;
        } break; }
      case 'start': if (r.phase !== 'lobby') break; if (need) return cb({ err: need }); begin(r); break;
      case 'launch': launch(r); break;
      case 'next': if (r.phase === 'result') next(r); break;
      case 'newround': if (r.phase !== 'roundEnd') break; if (need) return cb({ err: need }); r.round++; begin(r); break;
      case 'lobby': if (r.phase === 'roundEnd') { resetScores(r); r.phase = 'lobby'; r.round++; } break;
    }
    emit(r); cb({});
  });
  s.on('disconnect', () => {
    const r = rooms.get(s.data && s.data.room), p = r && r.players.get(s.data.pid);
    if (!p || p.sid !== s.id) return;
    p.on = false;
    if (r.phase === 'lobby') p.rm = setTimeout(() => { if (!p.on) { r.players.delete(p.id); emit(r); } }, 20000);
    emit(r); chk(r);
  });
});
setInterval(() => { for (const [k, r] of rooms) if (Date.now() - r.last > 4 * 3600e3) rooms.delete(k); }, 600000);

srv.listen(PORT, '0.0.0.0', () => {
  console.log(`KURNIWORD RACE prêt : http://localhost:${PORT}/host`);
  lan().forEach(ip => console.log(`  Sur le réseau local : http://${ip}:${PORT}/host`));
});
