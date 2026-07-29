// Bowling Tournament Markets - server
// Express app. Depth-based bid/offer markets.
// Storage: Postgres (DATABASE_URL) if set, otherwise a local JSON file
//   (falls back automatically so local dev still works without a database).
// Run: npm install && npm start   -> http://localhost:3000
//   /        -> bettor view (share this link)
//   /admin   -> market maker dashboard

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'db.json');
const DATABASE_URL = process.env.DATABASE_URL || '';

const app = express();
app.use(express.json());

// Serve the front-end pages explicitly (keeps data/db.json from ever being
// served as a static file).
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/style.css', (req, res) => {
  res.sendFile(path.join(__dirname, 'style.css'));
});

// ---------- storage ----------

// The groups the app runs. Add a new id here (and a default name below) to add
// another section to both the bettor page and the dashboard.
const GROUP_IDS = ['la', 'london', 'sg'];

function defaultGroup() {
  return { players: [], bets: [], bettors: [] };
}

function defaultData() {
  return {
    settings: {
      standardSize: 10,           // default $ size on each side of a fresh/reset market
      moveIncrement: 1,           // default points the bid & offer shift when a side is exhausted
      adminPasscode: '',          // '' = no passcode set yet, /admin is open
      shadingDollarsPerPoint: 50, // $X of net imbalance per player = 1 point of exposure shading
      autoMoveCap: 5,             // max points the counter-offer algorithm will suggest in one shot
      // When bettors may send a price proposal (RFQ) on a market:
      //   'exhausted-only' (default) - only on a side with no liquidity left
      //   'anytime'                  - on any open side
      // Global default; each player can override via player.allowProposals.
      allowProposals: 'exhausted-only',
      groupNames: { la: 'LA Bowlers', london: 'London Bowlers', sg: 'Singapore Bowlers' }
    },
    // Bettors are a single global list: one name + PIN unlocks every group.
    bettors: [],
    groups: {
      la: defaultGroup(),
      london: defaultGroup(),
      sg: defaultGroup()
    }
  };
}

function normalizeGroup(g) {
  if (!g || typeof g !== 'object') g = defaultGroup();
  if (!Array.isArray(g.bettors)) g.bettors = [];
  // migrate old format (array of name strings) to { name, pin } objects
  g.bettors = g.bettors.map(b => (typeof b === 'string') ? { name: b, pin: '' } : { name: b.name, pin: b.pin || '' });
  if (!Array.isArray(g.players)) g.players = [];
  // Migration for existing records. Existing players keep whatever mode they
  // already had (don't flip live markets); only genuinely missing modes default.
  // allowProposals: null means "use the global settings default".
  g.players = g.players.map(p => ({
    ...p,
    mode: p.mode || 'algo',
    allowProposals: p.allowProposals === undefined ? null : p.allowProposals,
    // Back-fill the opening mid for markets created before this was tracked, so
    // "since open" starts from their current line rather than breaking.
    openingMid: (p.openingMid != null) ? p.openingMid : round2((p.bid + p.offer) / 2)
  }));
  if (!Array.isArray(g.bets)) g.bets = [];
  return g;
}

function normalize(data) {
  if (!data.settings) data.settings = defaultData().settings;
  // Forward-fill any new settings keys that may not exist in older stored data
  const defaults = defaultData().settings;
  Object.keys(defaults).forEach(k => {
    if (k === 'groupNames') {
      if (!data.settings.groupNames) data.settings.groupNames = { ...defaults.groupNames };
      else GROUP_IDS.forEach(gid => {
        if (!data.settings.groupNames[gid]) data.settings.groupNames[gid] = defaults.groupNames[gid];
      });
    } else if (data.settings[k] === undefined) {
      data.settings[k] = defaults[k];
    }
  });

  // Migrate from old flat structure (players/bets/bettors at top level) to groups
  if (!data.groups) {
    data.groups = {
      la: {
        players: Array.isArray(data.players) ? data.players : [],
        bets: Array.isArray(data.bets) ? data.bets : [],
        bettors: (Array.isArray(data.bettors) ? data.bettors : []).map(b =>
          (typeof b === 'string') ? { name: b, pin: '' } : { name: b.name, pin: b.pin || '' }
        )
      },
      london: defaultGroup(),
      sg: defaultGroup()
    };
    delete data.players;
    delete data.bets;
    delete data.bettors;
  } else {
    GROUP_IDS.forEach(gid => { data.groups[gid] = normalizeGroup(data.groups[gid]); });
  }

  // One-time migration to a single global bettor list. Bettors used to live
  // per-group, so anyone in both groups had two (possibly mismatched) PIN
  // entries. Merge them by name; one PIN now unlocks both groups. A non-empty
  // PIN wins over an empty one so nobody is locked out by the merge.
  if (!Array.isArray(data.bettors)) {
    const merged = new Map(); // lowercased name -> { name, pin }
    GROUP_IDS.forEach(gid => {
      const g = data.groups[gid];
      (g && Array.isArray(g.bettors) ? g.bettors : []).forEach(b => {
        const rec = (typeof b === 'string') ? { name: b, pin: '' } : { name: b.name, pin: b.pin || '' };
        const key = rec.name.toLowerCase();
        const existing = merged.get(key);
        if (!existing) merged.set(key, rec);
        else if (!existing.pin && rec.pin) existing.pin = rec.pin;
      });
    });
    data.bettors = [...merged.values()];
  }
  // Normalise shape and drop the now-unused per-group lists so there's one
  // source of truth.
  data.bettors = data.bettors.map(b =>
    (typeof b === 'string') ? { name: b, pin: '' } : { name: b.name, pin: b.pin || '' }
  );
  GROUP_IDS.forEach(gid => { data.groups[gid].bettors = []; });

  return data;
}

// Return the group object for a given group id (defaults to 'la')
function getGroup(data, groupId) {
  return (data.groups && data.groups[groupId]) ? data.groups[groupId] : data.groups.la;
}

let pool = null;
let dbReady = null;

if (DATABASE_URL) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  dbReady = pool.query(`
    CREATE TABLE IF NOT EXISTS app_data (
      id INT PRIMARY KEY,
      data JSONB NOT NULL
    )
  `).then(async () => {
    const res = await pool.query('SELECT data FROM app_data WHERE id = 1');
    if (res.rows.length === 0) {
      await pool.query('INSERT INTO app_data (id, data) VALUES (1, $1)', [JSON.stringify(defaultData())]);
    }
  }).catch(err => {
    console.error('Failed to initialize database:', err);
  });

  console.log('Storage: Postgres (DATABASE_URL set)');
} else {
  console.log('Storage: local JSON file (set DATABASE_URL for persistent storage)');
}

async function loadData() {
  if (pool) {
    if (dbReady) await dbReady;
    const res = await pool.query('SELECT data FROM app_data WHERE id = 1');
    if (res.rows.length === 0) {
      const data = defaultData();
      await saveData(data);
      return data;
    }
    return normalize(res.rows[0].data);
  }
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return normalize(JSON.parse(raw));
  } catch (e) {
    const data = defaultData();
    await saveData(data);
    return data;
  }
}

async function saveData(data) {
  if (pool) {
    await pool.query(
      'INSERT INTO app_data (id, data) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET data = $1',
      [JSON.stringify(data)]
    );
    return;
  }
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function id(prefix) {
  return prefix + '_' + crypto.randomBytes(6).toString('hex');
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ---------- helpers ----------

function effective(player, settings) {
  return {
    standardSize: player.standardSize != null ? player.standardSize : settings.standardSize,
    moveIncrement: player.moveIncrement != null ? player.moveIncrement : settings.moveIncrement
  };
}

// Resolve whether/when bettors can send price proposals on a player's market.
// Player override wins; otherwise the global setting. Falls back to the safe
// default ('exhausted-only') for any unrecognised value.
function effectiveAllowProposals(player, settings) {
  const v = (player && player.allowProposals != null)
    ? player.allowProposals
    : (settings && settings.allowProposals);
  return v === 'anytime' ? 'anytime' : 'exhausted-only';
}

function publicPlayer(p, settings) {
  // Shape sent to the bettor view - price + available size on each side only.
  const mode = p.mode || 'algo';
  const bidExhausted = mode === 'finite' && p.bidSize <= 0;
  const offerExhausted = mode === 'finite' && p.offerSize <= 0;
  const allowProposals = effectiveAllowProposals(p, settings || {});
  // "Since open" market colour: how far the mid has moved from where the market
  // first opened. openingMid is stamped at creation (and back-filled for older
  // markets in normalizeGroup).
  const currentMid = round2((p.bid + p.offer) / 2);
  const openingMid = (p.openingMid != null) ? p.openingMid : currentMid;
  const midChange = round2(currentMid - openingMid);
  return {
    id: p.id,
    name: p.name,
    bid: p.bid,
    bidSize: p.bidSize,
    offer: p.offer,
    offerSize: p.offerSize,
    status: p.status,
    finalScore: p.finalScore,
    openingMid,
    midChange,
    mode,
    // In finite mode, tell the bettor view when a side has no more liquidity
    bidExhausted,
    offerExhausted,
    // Proposal (RFQ) availability, so the bettor view can offer "Propose a bet".
    allowProposals,
    canProposeUnder: p.status === 'open' && (allowProposals === 'anytime' || bidExhausted),
    canProposeOver:  p.status === 'open' && (allowProposals === 'anytime' || offerExhausted)
  };
}

// A side has been exhausted (size hit 0). Either auto-move & reset both sides
// to the standard size at a new level, or (if auto-move is off) just leave
// that side at 0 size until the market maker manually adjusts it.
function handleExhaustion(player, hitSide, settings) {
  const { standardSize, moveIncrement } = effective(player, settings);
  if (!player.autoMoveEnabled || !moveIncrement) {
    // leave the exhausted side at 0; market maker must adjust manually
    return;
  }
  // Heavy "under" hitting (bid side exhausted) -> lots of selling -> move market down.
  // Heavy "over" hitting (offer side exhausted) -> lots of buying -> move market up.
  if (hitSide === 'under') {
    player.bid -= moveIncrement;
    player.offer -= moveIncrement;
  } else {
    player.bid += moveIncrement;
    player.offer += moveIncrement;
  }
  player.bidSize = standardSize;
  player.offerSize = standardSize;
}

function fillBet(player, side, stake, settings) {
  // Consumes size on the given side; if it hits zero (or goes negative,
  // e.g. when accepting a pending bet larger than what's currently shown),
  // triggers handleExhaustion.
  if (side === 'under') {
    player.bidSize = round2(player.bidSize - stake);
    if (player.bidSize <= 0) {
      player.bidSize = 0;
      // In finite mode, no auto-move — market maker re-racks manually
      if ((player.mode || 'algo') !== 'finite') handleExhaustion(player, 'under', settings);
    }
  } else {
    player.offerSize = round2(player.offerSize - stake);
    if (player.offerSize <= 0) {
      player.offerSize = 0;
      if ((player.mode || 'algo') !== 'finite') handleExhaustion(player, 'over', settings);
    }
  }
}

// Grade a single filled ("open") bet against its OWN execution level once the
// final score is known.
//
// This is deliberately NOT graded against the bid/offer spread at settle time.
// The spread is only the market maker's quote at a moment; each bet resolves
// against the exact level it was actually executed at:
//   under = hit the bid      -> wins if the final score comes in BELOW that bid
//   over  = lifted the offer  -> wins if the final score comes in ABOVE that offer
//   score exactly on the level -> push (stake returned)
//
// Example (the bug this fixes): on an 85/95 market a bettor hits the bid at 85.
// The bowler shoots 87. They bet under 85 and the score beat it, so they LOSE.
// The old code graded 87 as "inside the spread" and returned a push.
function gradeBet(score, bet) {
  const price = bet.price || {};
  const level = bet.side === 'under' ? price.bid : price.offer;
  const s = Number(score);
  let outcome; // 'won' | 'lost' | 'push'
  if (level == null || isNaN(Number(level))) {
    // An open bet should always carry an execution price; if one is somehow
    // missing, push rather than silently grading it as a win or a loss.
    outcome = 'push';
  } else if (s === Number(level)) {
    outcome = 'push';
  } else if (bet.side === 'under') {
    outcome = s < Number(level) ? 'won' : 'lost';
  } else {
    outcome = s > Number(level) ? 'won' : 'lost';
  }
  let payout;
  if (outcome === 'won') payout = round2(bet.stake * 2); // stake back + even-money win
  else if (outcome === 'push') payout = round2(bet.stake); // stake returned
  else payout = 0;
  return { outcome, payout };
}

// ---------- auth ----------

// Constant-time string compare. Avoids leaking how much of a secret matched
// via response timing. Lengths are compared first because timingSafeEqual
// throws on mismatched buffer lengths.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// In-memory failed-attempt tracking, keyed by IP + purpose. A 4-digit PIN is
// only 10k guesses, so without this it falls to a script in seconds.
// Note: this is per-process. With multiple Render instances each gets its own
// counter; fine for a single free-tier instance, revisit if you scale out.
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 8;
const failures = new Map();

function clientKey(req, purpose) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = fwd || req.socket.remoteAddress || 'unknown';
  return `${purpose}:${ip}`;
}

function isLockedOut(req, purpose) {
  const rec = failures.get(clientKey(req, purpose));
  if (!rec) return false;
  if (Date.now() - rec.first > FAIL_WINDOW_MS) {
    failures.delete(clientKey(req, purpose));
    return false;
  }
  return rec.count >= MAX_FAILS;
}

function recordFailure(req, purpose) {
  const key = clientKey(req, purpose);
  const rec = failures.get(key);
  if (!rec || Date.now() - rec.first > FAIL_WINDOW_MS) {
    failures.set(key, { count: 1, first: Date.now() });
  } else {
    rec.count++;
  }
}

function clearFailures(req, purpose) {
  failures.delete(clientKey(req, purpose));
}

// The admin passcode comes from the environment first so it never has to live
// in the database blob. settings.adminPasscode stays supported for existing
// deployments, but ADMIN_PASSCODE wins if both are set.
function adminPasscodeFor(data) {
  return process.env.ADMIN_PASSCODE || data.settings.adminPasscode || '';
}

// Session cookie so the /admin page itself can be gated. A browser navigating
// to /admin cannot send a custom header, so the passcode is exchanged for a
// signed cookie at POST /api/admin/login.
function sessionSecret(data) {
  if (!data.settings.sessionSecret) {
    data.settings.sessionSecret = crypto.randomBytes(32).toString('hex');
  }
  return data.settings.sessionSecret;
}

function adminToken(data) {
  return crypto.createHmac('sha256', sessionSecret(data))
    .update(`admin:${adminPasscodeFor(data)}`)
    .digest('hex');
}

function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

function hasAdminCookie(req, data) {
  const token = parseCookies(req).bm_admin;
  return !!token && safeEqual(token, adminToken(data));
}

// FAILS CLOSED. An unset passcode used to mean "admin is open to everyone",
// which left every admin endpoint public on a live deployment.
async function requireAdmin(req, res, next) {
  const data = await loadData();
  const passcode = adminPasscodeFor(data);

  if (!passcode) {
    return res.status(503).json({
      error: 'Admin is locked: no passcode configured. Set ADMIN_PASSCODE in the server environment and restart.'
    });
  }
  if (isLockedOut(req, 'admin')) {
    return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
  }
  if (hasAdminCookie(req, data)) return next();

  const provided = req.headers['x-admin-passcode'] || '';
  if (provided && safeEqual(provided, passcode)) {
    clearFailures(req, 'admin');
    return next();
  }

  recordFailure(req, 'admin');
  return res.status(401).json({ error: 'admin passcode required' });
}

// Resolve and authenticate a bettor from request headers. Returns
// { ok: true, bettor } or { ok: false, status, error }.
// Callers MUST use this rather than trusting a name off the query string.
function authenticateBettor(req, bettors) {
  const rawName = req.headers['x-bettor-name'];
  const name = rawName == null ? '' : String(rawName).trim();
  if (!name) return { ok: false, status: 401, error: 'sign in to view your bets' };

  const bettor = bettors.find(b => b.name.toLowerCase() === name.toLowerCase());
  if (!bettor) return { ok: false, status: 401, error: 'unknown bettor' };

  // NOTE: the per-IP failed-attempt lockout was removed from the bettor flow —
  // normal fumbling (e.g. clicking Bet before a PIN is set) was locking people
  // out. The wrong-PIN check below still applies; the admin passcode still has
  // its own lockout in requireAdmin(). Revisit if brute-forcing 4-digit bettor
  // PINs ever becomes a concern.
  if (!bettor.pin) {
    return { ok: false, status: 403, error: 'no PIN set for this bettor — ask the market maker to set one' };
  }

  const provided = req.headers['x-bettor-pin'];
  if (!safeEqual(provided == null ? '' : String(provided), bettor.pin)) {
    return { ok: false, status: 401, error: 'incorrect pin' };
  }

  return { ok: true, bettor };
}

function sortedBettorNames(data) {
  return data.bettors.map(b => b.name).sort((a, b) => a.localeCompare(b));
}

function adminBettorList(data) {
  return data.bettors
    .map(b => ({ name: b.name, pin: b.pin || '' }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Compute exposure rows for a single group
function exposureRows(group) {
  const rows = group.players
    .filter(p => p.status === 'open' || p.status === 'paused')
    .map(p => {
      const openBets = group.bets.filter(b => b.playerId === p.id && b.status === 'open');
      const underStakes = round2(openBets.filter(b => b.side === 'under').reduce((s, b) => s + b.stake, 0));
      const overStakes  = round2(openBets.filter(b => b.side === 'over').reduce((s, b) => s + b.stake, 0));
      const stakesHeld  = round2(underStakes + overStakes);
      // Net exposure from the market maker's perspective, agnostic to level and
      // final score: positive = the book leans over (house loses if the bowler
      // scores high), negative = leans under.
      const netExposure = round2(overStakes - underStakes);
      return { playerId: p.id, name: p.name, stakesHeld, underStakes, overStakes, netExposure };
    });
  const totals = rows.reduce((acc, r) => ({
    stakesHeld: round2(acc.stakesHeld + r.stakesHeld),
    underStakes: round2(acc.underStakes + r.underStakes),
    overStakes:  round2(acc.overStakes  + r.overStakes),
    netExposure: round2(acc.netExposure + r.netExposure)
  }), { stakesHeld: 0, underStakes: 0, overStakes: 0, netExposure: 0 });
  return { rows, totals };
}

// Per-bettor exposure: counterparty risk, i.e. who owes whom at the end of the
// night. exposureRows() above is score risk per bowler; this is the other axis.
//
// For each bettor, from Mike's (the house's) point of view:
//   openStake      - money they currently have live across all open bets
//   netExposure    - directional lean of their open bets, MM's perspective:
//                    over stakes minus under stakes (+ = this bettor is net over)
//   settledBalance - realised P&L to date across already-graded bets; this is the
//                    running number Mike squares up from. + = house owes them.
// Payouts are even money, so a won bet nets +stake to the bettor, a lost bet
// -stake, and push/void/cancel net 0 (stake returned).
function bettorExposureRows(group) {
  const names = new Set(group.bettors.map(b => b.name));
  group.bets.forEach(b => names.add(b.bettorName));

  const SETTLED = ['won', 'lost', 'push', 'voided', 'cancelled'];
  const rows = [...names].map(name => {
    const lc = name.toLowerCase();
    const mine = group.bets.filter(b => b.bettorName.toLowerCase() === lc);
    const open = mine.filter(b => b.status === 'open');
    const underStakes = round2(open.filter(b => b.side === 'under').reduce((s, b) => s + b.stake, 0));
    const overStakes  = round2(open.filter(b => b.side === 'over').reduce((s, b) => s + b.stake, 0));
    const openStake   = round2(underStakes + overStakes);
    const netExposure = round2(overStakes - underStakes);
    const settledBalance = round2(mine
      .filter(b => SETTLED.includes(b.status))
      .reduce((s, b) => s + ((b.payout == null ? 0 : b.payout) - b.stake), 0));
    return { name, openStake, underStakes, overStakes, netExposure, settledBalance };
  })
  // Hide bettors with nothing live and nothing settled — keeps the table to
  // people actually in action.
  .filter(r => r.openStake !== 0 || r.settledBalance !== 0)
  .sort((a, b) => a.name.localeCompare(b.name));

  const totals = rows.reduce((acc, r) => ({
    openStake:      round2(acc.openStake + r.openStake),
    netExposure:    round2(acc.netExposure + r.netExposure),
    settledBalance: round2(acc.settledBalance + r.settledBalance)
  }), { openStake: 0, netExposure: 0, settledBalance: 0 });

  return { rows, totals };
}

// ---------- public status ----------

app.get('/api/admin/status', async (req, res) => {
  const data = await loadData();
  res.json({ passcodeSet: !!data.settings.adminPasscode });
});

// ---------- settings ----------

app.get('/api/settings', async (req, res) => {
  const data = await loadData();
  // never expose the passcode itself to plain GETs without auth
  const { adminPasscode, ...rest } = data.settings;
  res.json({ ...rest, passcodeSet: !!adminPasscode });
});

app.put('/api/settings', requireAdmin, async (req, res) => {
  const data = await loadData();
  const { standardSize, moveIncrement, adminPasscode, shadingDollarsPerPoint, autoMoveCap, allowProposals, groupNames } = req.body;
  if (standardSize != null) data.settings.standardSize = Number(standardSize);
  if (moveIncrement != null) data.settings.moveIncrement = Number(moveIncrement);
  if (adminPasscode !== undefined) data.settings.adminPasscode = String(adminPasscode || '');
  if (shadingDollarsPerPoint != null) data.settings.shadingDollarsPerPoint = Math.max(1, Number(shadingDollarsPerPoint));
  if (autoMoveCap != null) data.settings.autoMoveCap = Math.max(1, Number(autoMoveCap));
  if (allowProposals != null) {
    data.settings.allowProposals = allowProposals === 'anytime' ? 'anytime' : 'exhausted-only';
  }
  if (groupNames) {
    GROUP_IDS.forEach(gid => {
      if (groupNames[gid]) data.settings.groupNames[gid] = String(groupNames[gid]).trim();
    });
  }
  await saveData(data);
  const { adminPasscode: _omit, ...rest } = data.settings;
  res.json({ ...rest, passcodeSet: !!data.settings.adminPasscode });
});

// ---------- eligible bettors (global list) ----------

// Public: list of names for the bettor-view dropdown. Bettors are global, so
// the ?g param is ignored here.
app.get('/api/bettors', async (req, res) => {
  const data = await loadData();
  res.json(sortedBettorNames(data));
});

// Admin: full list including whether each bettor has a PIN set.
app.get('/api/admin/bettors', requireAdmin, async (req, res) => {
  const data = await loadData();
  res.json(adminBettorList(data));
});

app.post('/api/bettors', requireAdmin, async (req, res) => {
  const data = await loadData();
  const { name, pin } = req.body;
  const trimmed = name == null ? '' : String(name).trim();
  if (!trimmed) return res.status(400).json({ error: 'name is required' });
  if (data.bettors.some(b => b.name.toLowerCase() === trimmed.toLowerCase())) {
    return res.status(400).json({ error: 'that name is already on the list' });
  }
  data.bettors.push({ name: trimmed, pin: pin ? String(pin).trim() : '' });
  await saveData(data);
  res.status(201).json(adminBettorList(data));
});

// Admin: set, change, or clear (empty pin) a bettor's PIN.
app.put('/api/bettors/:name', requireAdmin, async (req, res) => {
  const data = await loadData();
  const target = req.params.name.toLowerCase();
  const bettor = data.bettors.find(b => b.name.toLowerCase() === target);
  if (!bettor) return res.status(404).json({ error: 'name not found' });
  bettor.pin = req.body.pin ? String(req.body.pin).trim() : '';
  await saveData(data);
  res.json(adminBettorList(data));
});

app.delete('/api/bettors/:name', requireAdmin, async (req, res) => {
  const data = await loadData();
  const target = req.params.name.toLowerCase();
  const before = data.bettors.length;
  data.bettors = data.bettors.filter(b => b.name.toLowerCase() !== target);
  if (data.bettors.length === before) return res.status(404).json({ error: 'name not found' });
  await saveData(data);
  res.json(adminBettorList(data));
});

// ---------- players / markets ----------

// Public list (bettor view). ?g=la|london
// Statuses that mean a bet actually filled (a real trade happened), as opposed
// to pending/declined requests or open proposals that never traded.
const FILLED_STATUSES = ['open', 'won', 'lost', 'push', 'cancelled', 'voided'];

app.get('/api/players', async (req, res) => {
  const data = await loadData();
  const group = getGroup(data, req.query.g);
  const trades = {};
  group.bets.forEach(b => {
    if (FILLED_STATUSES.includes(b.status)) trades[b.playerId] = (trades[b.playerId] || 0) + 1;
  });
  res.json(group.players.map(p => ({ ...publicPlayer(p, data.settings), trades: trades[p.id] || 0 })));
});

// Full detail (admin view)
app.get('/api/admin/players', requireAdmin, async (req, res) => {
  const data = await loadData();
  const group = getGroup(data, req.query.g);
  const enriched = group.players.map(p => {
    const bets = group.bets.filter(b => b.playerId === p.id);
    const pendingCount = bets.filter(b => b.status === 'pending').length;
    const proposalCount = bets.filter(b =>
      b.kind === 'proposal' && (b.status === 'proposed' || b.status === 'proposal-countered')
    ).length;
    return { ...p, betCount: bets.length, pendingCount, proposalCount };
  });
  res.json(enriched);
});

app.post('/api/players', requireAdmin, async (req, res) => {
  const data = await loadData();
  const group = getGroup(data, req.query.g);
  const { name, bid, offer, bidSize, offerSize, standardSize, moveIncrement, autoMoveEnabled, mode, allowProposals } = req.body;
  if (!name || bid == null || offer == null) {
    return res.status(400).json({ error: 'name, bid and offer are required' });
  }
  if (Number(offer) < Number(bid)) {
    return res.status(400).json({ error: 'offer must be >= bid' });
  }
  const player = {
    id: id('p'),
    name: String(name).trim(),
    bid: Number(bid),
    offer: Number(offer),
    standardSize: standardSize != null && standardSize !== '' ? Number(standardSize) : null,
    moveIncrement: moveIncrement != null && moveIncrement !== '' ? Number(moveIncrement) : null,
    autoMoveEnabled: autoMoveEnabled !== false,
    // New players default to manual mode. Algo mode is on its way out; markets
    // should feel like real liquidity that the market maker re-racks by hand.
    mode: mode === 'algo' ? 'algo' : 'finite', // 'algo' | 'finite'
    allowProposals: allowProposals === 'anytime' ? 'anytime'
                  : allowProposals === 'exhausted-only' ? 'exhausted-only' : null, // null = use global
    // The mid this market first opened at — fixed for the life of the market.
    openingMid: round2((Number(bid) + Number(offer)) / 2),
    status: 'open', // open | paused | voided | settled
    finalScore: null
  };
  const eff = effective(player, data.settings);
  player.bidSize = bidSize != null && bidSize !== '' ? Number(bidSize) : eff.standardSize;
  player.offerSize = offerSize != null && offerSize !== '' ? Number(offerSize) : eff.standardSize;

  group.players.push(player);
  await saveData(data);
  res.status(201).json(player);
});

// Manual override of a player's market / config / pause-resume
app.put('/api/players/:id', requireAdmin, async (req, res) => {
  const data = await loadData();
  const group = getGroup(data, req.query.g);
  const player = group.players.find(p => p.id === req.params.id);
  if (!player) return res.status(404).json({ error: 'player not found' });
  if (player.status === 'settled' || player.status === 'voided') {
    return res.status(400).json({ error: 'reopen this market before editing it' });
  }

  const {
    name, bid, offer, bidSize, offerSize,
    standardSize, moveIncrement, autoMoveEnabled, status, mode, allowProposals
  } = req.body;

  if (name != null) player.name = String(name).trim();
  if (bid != null) player.bid = Number(bid);
  if (offer != null) player.offer = Number(offer);
  if (player.offer < player.bid) {
    return res.status(400).json({ error: 'offer must be >= bid' });
  }
  // Mode toggle: 'algo' | 'finite'.
  if (mode === 'algo' || mode === 'finite') {
    player.mode = mode;
  }
  // Per-player proposal policy: 'anytime', 'exhausted-only', or null to fall
  // back to the global setting.
  if (allowProposals !== undefined) {
    player.allowProposals = allowProposals === 'anytime' ? 'anytime'
      : allowProposals === 'exhausted-only' ? 'exhausted-only'
      : null;
  }
  if (bidSize != null) player.bidSize = Math.max(0, Number(bidSize));
  if (offerSize != null) player.offerSize = Math.max(0, Number(offerSize));
  if (standardSize !== undefined) player.standardSize = standardSize === '' || standardSize === null ? null : Number(standardSize);
  if (moveIncrement !== undefined) player.moveIncrement = moveIncrement === '' || moveIncrement === null ? null : Number(moveIncrement);
  if (autoMoveEnabled != null) player.autoMoveEnabled = !!autoMoveEnabled;
  if (status != null) {
    if (status !== 'open' && status !== 'paused') {
      return res.status(400).json({ error: "status can only be set to 'open' or 'paused' here" });
    }
    player.status = status;
  }

  await saveData(data);
  res.json(player);
});

app.delete('/api/players/:id', requireAdmin, async (req, res) => {
  const data = await loadData();
  const group = getGroup(data, req.query.g);
  const before = group.players.length;
  group.players = group.players.filter(p => p.id !== req.params.id);
  if (group.players.length === before) return res.status(404).json({ error: 'player not found' });
  group.bets = group.bets.filter(b => b.playerId !== req.params.id);
  await saveData(data);
  res.json({ ok: true });
});

// Settle a player's market: enter the final score, grade all open bets.
app.post('/api/players/:id/settle', requireAdmin, async (req, res) => {
  const data = await loadData();
  const group = getGroup(data, req.query.g);
  const player = group.players.find(p => p.id === req.params.id);
  if (!player) return res.status(404).json({ error: 'player not found' });
  if (player.status === 'settled' || player.status === 'voided') {
    return res.status(400).json({ error: 'market is already settled or voided' });
  }
  const { finalScore } = req.body;
  if (finalScore == null || isNaN(Number(finalScore))) {
    return res.status(400).json({ error: 'finalScore is required' });
  }
  const score = Number(finalScore);
  player.finalScore = score;
  player.status = 'settled';

  let declinedPending = 0;
  group.bets.forEach(b => {
    if (b.playerId !== player.id) return;
    // Auto-decline anything still awaiting a decision: oversized pending bets,
    // countered bets, and open RFQ proposals (proposed / privately countered).
    if (['pending', 'countered', 'proposed', 'proposal-countered'].includes(b.status)) {
      b.status = 'declined';
      b.payout = 0;
      declinedPending++;
      return;
    }
    if (b.status !== 'open') return;
    // Fix-forward only: bets already graded on a previous settle (won/lost/push/
    // voided) are left untouched — we only grade bets still 'open' right now, and
    // each one against its own execution level via gradeBet().
    const { outcome, payout } = gradeBet(score, b);
    b.status = outcome;
    b.payout = payout;
  });

  await saveData(data);
  res.json({ player, bets: group.bets.filter(b => b.playerId === player.id), declinedPending });
});

// Reopen a settled or voided market (undo)
app.post('/api/players/:id/reopen', requireAdmin, async (req, res) => {
  const data = await loadData();
  const group = getGroup(data, req.query.g);
  const player = group.players.find(p => p.id === req.params.id);
  if (!player) return res.status(404).json({ error: 'player not found' });
  player.status = 'open';
  player.finalScore = null;
  group.bets.forEach(b => {
    if (b.playerId === player.id && ['won', 'lost', 'push', 'voided'].includes(b.status)) {
      b.status = 'open';
      b.payout = null;
    }
  });
  await saveData(data);
  res.json(player);
});

// Void a player's market entirely: no contest, refund every open bet.
app.post('/api/players/:id/void', requireAdmin, async (req, res) => {
  const data = await loadData();
  const group = getGroup(data, req.query.g);
  const player = group.players.find(p => p.id === req.params.id);
  if (!player) return res.status(404).json({ error: 'player not found' });
  if (player.status === 'settled' || player.status === 'voided') {
    return res.status(400).json({ error: 'market is already settled or voided' });
  }
  player.status = 'voided';
  player.finalScore = null;
  group.bets.forEach(b => {
    if (b.playerId !== player.id) return;
    if (b.status === 'open') {
      b.status = 'voided';
      b.payout = b.stake; // full refund, no contest
    } else if (['pending', 'countered', 'proposed', 'proposal-countered'].includes(b.status)) {
      b.status = 'declined';
      b.payout = 0;
    }
  });
  await saveData(data);
  res.json({ player, bets: group.bets.filter(b => b.playerId === player.id) });
});

// ---------- exposure / risk ----------

app.get('/api/admin/exposure', requireAdmin, async (req, res) => {
  const data = await loadData();
  const group = getGroup(data, req.query.g);
  res.json(exposureRows(group));
});

// Per-bettor exposure (counterparty risk / who owes whom).
app.get('/api/admin/bettor-exposure', requireAdmin, async (req, res) => {
  const data = await loadData();
  const group = getGroup(data, req.query.g);
  res.json(bettorExposureRows(group));
});

// Combined summary across all groups
app.get('/api/admin/summary', requireAdmin, async (req, res) => {
  const data = await loadData();
  const out = { combined: { stakesHeld: 0, underStakes: 0, overStakes: 0, netExposure: 0 },
                groupNames: data.settings.groupNames };
  GROUP_IDS.forEach(gid => {
    const ex = exposureRows(data.groups[gid]);
    const markets = data.groups[gid].players.filter(p => p.status === 'open' || p.status === 'paused');
    out[gid] = { ...ex, markets: markets.map(p => publicPlayer(p, data.settings)) };
    const t = ex.totals;
    out.combined = {
      stakesHeld:  round2(out.combined.stakesHeld + t.stakesHeld),
      underStakes: round2(out.combined.underStakes + t.underStakes),
      overStakes:  round2(out.combined.overStakes + t.overStakes),
      netExposure: round2(out.combined.netExposure + t.netExposure)
    };
  });
  res.json(out);
});

// ---------- bets ----------

// A bettor's own bets. Always scoped to the authenticated bettor.
//
// This previously applied the PIN check only when ?bettorName was supplied,
// so calling it with no parameters returned the entire book — every bettor's
// name, side and stake — to anyone with the URL. The identity now comes from
// authenticated headers and the filter is unconditional; there is no code path
// that returns another bettor's positions. Admin uses /api/admin/bets.
app.get('/api/bets', async (req, res) => {
  const data = await loadData();
  const group = getGroup(data, req.query.g);

  const auth = authenticateBettor(req, data.bettors);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const mine = auth.bettor.name.toLowerCase();
  let bets = group.bets.filter(b => b.bettorName.toLowerCase() === mine);
  if (req.query.playerId) bets = bets.filter(b => b.playerId === req.query.playerId);

  bets = [...bets].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  const playerNames = Object.fromEntries(group.players.map(p => [p.id, p.name]));
  res.json(bets.map(b => ({ ...b, playerName: playerNames[b.playerId] || '?' })));
});

// Admin-only: full bet list including bettor names, for the admin bets table.
app.get('/api/admin/bets', requireAdmin, async (req, res) => {
  const data = await loadData();
  const group = getGroup(data, req.query.g);
  let bets = [...group.bets].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  const playerNames = Object.fromEntries(group.players.map(p => [p.id, p.name]));
  res.json(bets.map(b => ({ ...b, playerName: playerNames[b.playerId] || '?' })));
});

app.get('/api/admin/pending', requireAdmin, async (req, res) => {
  const data = await loadData();
  const group = getGroup(data, req.query.g);
  let bets = group.bets.filter(b => b.status === 'pending');
  bets = bets.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const playerNames = Object.fromEntries(group.players.map(p => [p.id, p.name]));
  res.json(bets.map(b => ({ ...b, playerName: playerNames[b.playerId] || '?' })));
});

app.post('/api/bets', async (req, res) => {
  const data = await loadData();
  const group = getGroup(data, req.query.g);
  const { playerId, side, stake } = req.body;

  // The bettor's identity comes from their authenticated PIN, not from the
  // request body. Previously any caller could submit a bet under someone
  // else's name and that person would be on the hook for the stake.
  const auth = authenticateBettor(req, data.bettors);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  const canonicalName = auth.bettor.name;

  if (!playerId || !side || stake == null) {
    return res.status(400).json({ error: 'playerId, side and stake are required' });
  }
  if (side !== 'over' && side !== 'under') {
    return res.status(400).json({ error: "side must be 'over' or 'under'" });
  }
  const stakeNum = Number(stake);
  if (!(stakeNum > 0)) {
    return res.status(400).json({ error: 'stake must be a positive number' });
  }
  const player = group.players.find(p => p.id === playerId);
  if (!player) return res.status(404).json({ error: 'player not found' });
  if (player.status !== 'open') {
    return res.status(400).json({ error: 'this market is not open for betting' });
  }

  const remaining = side === 'under' ? player.bidSize : player.offerSize;
  const playerMode = player.mode || 'algo';

  // Finite mode: hard limits — no pending/oversized bets allowed
  if (playerMode === 'finite') {
    if (remaining <= 0) {
      return res.status(409).json({ error: 'No liquidity on that side right now — register your interest instead.' });
    }
    if (stakeNum > remaining) {
      return res.status(400).json({ error: `Only $${remaining} available on that side — reduce your stake.` });
    }
  }

  const bet = {
    id: id('b'),
    playerId,
    bettorName: canonicalName,
    side,
    stake: stakeNum,
    timestamp: new Date().toISOString(),
    payout: null
  };

  if (playerMode === 'finite' || stakeNum <= remaining) {
    bet.status = 'open';
    bet.price = { bid: player.bid, offer: player.offer };
    bet.requestedPrice = null;
    fillBet(player, side, stakeNum, data.settings);
  } else {
    // Algo mode only: oversized bet goes pending for market maker review
    bet.status = 'pending';
    bet.price = null;
    bet.requestedPrice = { bid: player.bid, offer: player.offer };
  }

  group.bets.push(bet);
  await saveData(data);
  res.status(201).json({ bet, player });
});

// Accept a pending bet: locks in the CURRENT price, consumes size, may trigger auto-move.
app.post('/api/bets/:id/accept', requireAdmin, async (req, res) => {
  const data = await loadData();
  const group = getGroup(data, req.query.g);
  const bet = group.bets.find(b => b.id === req.params.id);
  if (!bet) return res.status(404).json({ error: 'bet not found' });
  if (bet.status !== 'pending') return res.status(400).json({ error: 'bet is not pending' });
  const player = group.players.find(p => p.id === bet.playerId);
  if (!player) return res.status(404).json({ error: 'player not found' });
  if (player.status !== 'open') return res.status(400).json({ error: 'market is not open' });

  bet.price = { bid: player.bid, offer: player.offer };
  bet.status = 'open';
  fillBet(player, bet.side, bet.stake, data.settings);

  await saveData(data);
  res.json({ bet, player });
});

app.post('/api/bets/:id/decline', requireAdmin, async (req, res) => {
  const data = await loadData();
  const group = getGroup(data, req.query.g);
  const bet = group.bets.find(b => b.id === req.params.id);
  if (!bet) return res.status(404).json({ error: 'bet not found' });
  if (bet.status !== 'pending') return res.status(400).json({ error: 'bet is not pending' });
  bet.status = 'declined';
  bet.payout = 0;
  await saveData(data);
  res.json({ bet });
});

// Counter a pending bet: market maker sets a new market for the player, which goes
// live immediately. The bet flips to "countered" and waits for the bettor to accept/decline.
app.post('/api/bets/:id/counter', requireAdmin, async (req, res) => {
  const data = await loadData();
  const group = getGroup(data, req.query.g);
  const bet = group.bets.find(b => b.id === req.params.id);
  if (!bet) return res.status(404).json({ error: 'bet not found' });
  if (bet.status !== 'pending') return res.status(400).json({ error: 'bet is not pending' });
  const player = group.players.find(p => p.id === bet.playerId);
  if (!player) return res.status(404).json({ error: 'player not found' });
  if (player.status !== 'open') return res.status(400).json({ error: 'market is not open' });

  const newBid = Number(req.body.newBid);
  const newOffer = Number(req.body.newOffer);
  if (isNaN(newBid) || isNaN(newOffer)) return res.status(400).json({ error: 'newBid and newOffer are required' });
  if (newOffer < newBid) return res.status(400).json({ error: 'offer must be >= bid' });

  // Update the player's market live for everyone to see.
  player.bid = newBid;
  player.offer = newOffer;

  // Capture the counter price on the bet and flip its status.
  bet.counterPrice = { bid: newBid, offer: newOffer };
  bet.status = 'countered';

  await saveData(data);
  res.json({ bet, player });
});

// Bettor accepts a countered bet: confirmed at the counter price.
app.post('/api/bets/:id/accept-counter', async (req, res) => {
  const data = await loadData();
  const group = getGroup(data, req.query.g);
  const bet = group.bets.find(b => b.id === req.params.id);
  if (!bet) return res.status(404).json({ error: 'bet not found' });
  if (bet.status !== 'countered') return res.status(400).json({ error: 'bet is not countered' });

  // Authenticate, then confirm the caller actually owns this bet — otherwise
  // any signed-in bettor could accept someone else's counter.
  const auth = authenticateBettor(req, data.bettors);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  if (auth.bettor.name.toLowerCase() !== bet.bettorName.toLowerCase()) {
    return res.status(403).json({ error: 'not your bet' });
  }

  const player = group.players.find(p => p.id === bet.playerId);
  if (!player) return res.status(404).json({ error: 'player not found' });

  bet.price = bet.counterPrice;
  bet.status = 'open';
  fillBet(player, bet.side, bet.stake, data.settings);

  await saveData(data);
  res.json({ bet, player });
});

// Bettor declines a countered bet: no action, stake returned.
app.post('/api/bets/:id/decline-counter', async (req, res) => {
  const data = await loadData();
  const group = getGroup(data, req.query.g);
  const bet = group.bets.find(b => b.id === req.params.id);
  if (!bet) return res.status(404).json({ error: 'bet not found' });
  if (bet.status !== 'countered') return res.status(400).json({ error: 'bet is not countered' });

  const auth = authenticateBettor(req, data.bettors);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  if (auth.bettor.name.toLowerCase() !== bet.bettorName.toLowerCase()) {
    return res.status(403).json({ error: 'not your bet' });
  }

  bet.status = 'declined';
  bet.payout = 0;

  await saveData(data);
  res.json({ bet });
});

// Cancel an open (filled) bet: refund the stake. Does not unwind any market move
// that already happened as a result of this bet.
app.post('/api/bets/:id/cancel', requireAdmin, async (req, res) => {
  const data = await loadData();
  const group = getGroup(data, req.query.g);
  const bet = group.bets.find(b => b.id === req.params.id);
  if (!bet) return res.status(404).json({ error: 'bet not found' });
  if (bet.status !== 'open') return res.status(400).json({ error: 'only open bets can be cancelled' });
  bet.status = 'cancelled';
  bet.payout = bet.stake;
  await saveData(data);
  res.json({ bet });
});

// ---------- proposals (RFQ) ----------
//
// Replaces the old "ping for interest" flow. A bettor names a level AND a size
// on a market (typically a side with no liquidity left) and the market maker can
// accept it, privately counter it, or decline it. One round only.
//
// Proposals live in group.bets so they show up in the bettor's own bet list and,
// once accepted, in the exposure/settlement math automatically. Lifecycle:
//   proposed            -> bettor's open RFQ, awaiting the market maker
//   proposal-countered  -> market maker countered privately, awaiting the bettor
//   open                -> agreed; a live bet at the agreed level (NO book size
//                          consumed, NO auto-move) that settles like any other
//   declined            -> ended with no trade
//
// A proposal carries a single side + level, so its price only fills the relevant
// leg; gradeBet() reads price.bid for unders and price.offer for overs.
function levelPrice(side, level) {
  return side === 'under' ? { bid: level, offer: null } : { bid: null, offer: level };
}

// Bettor sends a price proposal on a market.
app.post('/api/players/:id/propose', async (req, res) => {
  const data = await loadData();
  const group = getGroup(data, req.query.g);
  const player = group.players.find(p => p.id === req.params.id);
  if (!player) return res.status(404).json({ error: 'player not found' });
  if (player.status !== 'open') {
    return res.status(400).json({ error: 'market is not open' });
  }

  const auth = authenticateBettor(req, data.bettors);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  const canonicalName = auth.bettor.name;

  const { side } = req.body;
  const level = Number(req.body.level);
  const size = Number(req.body.size);
  if (side !== 'over' && side !== 'under') return res.status(400).json({ error: "side must be 'over' or 'under'" });
  if (!(level > 0)) return res.status(400).json({ error: 'level must be a positive number' });
  if (!(size > 0)) return res.status(400).json({ error: 'size must be a positive number' });

  // Gate on the market's proposal policy.
  const policy = effectiveAllowProposals(player, data.settings);
  if (policy === 'exhausted-only') {
    const remaining = side === 'under' ? player.bidSize : player.offerSize;
    if (remaining > 0) {
      return res.status(400).json({ error: 'there is still liquidity on that side — place a bet instead' });
    }
  }

  const proposal = {
    id: id('b'),
    playerId: player.id,
    bettorName: canonicalName,
    side,
    stake: size,
    kind: 'proposal',
    status: 'proposed',
    proposedLevel: level,
    price: null,
    counterPrice: null,
    requestedPrice: null,
    timestamp: new Date().toISOString(),
    payout: null
  };
  group.bets.push(proposal);
  await saveData(data);
  res.status(201).json({ proposal });
});

// Admin: list open proposals (awaiting the market maker or the bettor).
app.get('/api/admin/proposals', requireAdmin, async (req, res) => {
  const data = await loadData();
  const group = getGroup(data, req.query.g);
  const playerNames = Object.fromEntries(group.players.map(p => [p.id, p.name]));
  const proposals = group.bets
    .filter(b => b.kind === 'proposal' && (b.status === 'proposed' || b.status === 'proposal-countered'))
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
    .map(b => ({ ...b, playerName: playerNames[b.playerId] || '?' }));
  res.json(proposals);
});

function findProposal(group, id) {
  return group.bets.find(b => b.id === id && b.kind === 'proposal');
}

// Admin accepts a proposal at the level and size the bettor named. Agreed
// proposals do NOT consume book size and do NOT trigger an auto-move — they are
// a private trade layered on top of the public market.
app.post('/api/proposals/:id/accept', requireAdmin, async (req, res) => {
  const data = await loadData();
  const group = getGroup(data, req.query.g);
  const bet = findProposal(group, req.params.id);
  if (!bet) return res.status(404).json({ error: 'proposal not found' });
  if (bet.status !== 'proposed') return res.status(400).json({ error: 'proposal is not awaiting the market maker' });
  const player = group.players.find(p => p.id === bet.playerId);
  if (!player) return res.status(404).json({ error: 'player not found' });
  if (player.status !== 'open') return res.status(400).json({ error: 'market is not open' });

  bet.price = levelPrice(bet.side, bet.proposedLevel);
  bet.status = 'open';
  await saveData(data);
  res.json({ bet });
});

// Admin counters a proposal PRIVATELY. Unlike /api/bets/:id/counter this does
// NOT touch player.bid / player.offer, so the public board is unchanged. The
// counter can adjust the level and, optionally, the size.
app.post('/api/proposals/:id/counter', requireAdmin, async (req, res) => {
  const data = await loadData();
  const group = getGroup(data, req.query.g);
  const bet = findProposal(group, req.params.id);
  if (!bet) return res.status(404).json({ error: 'proposal not found' });
  if (bet.status !== 'proposed') return res.status(400).json({ error: 'proposal is not awaiting the market maker' });

  const level = Number(req.body.level);
  if (!(level > 0)) return res.status(400).json({ error: 'counter level must be a positive number' });
  let size = bet.stake;
  if (req.body.size !== undefined && req.body.size !== null && req.body.size !== '') {
    size = Number(req.body.size);
    if (!(size > 0)) return res.status(400).json({ error: 'counter size must be a positive number' });
  }

  bet.counterPrice = { level, size };
  bet.status = 'proposal-countered';
  await saveData(data);
  res.json({ bet });
});

// Admin declines a proposal (at either stage).
app.post('/api/proposals/:id/decline', requireAdmin, async (req, res) => {
  const data = await loadData();
  const group = getGroup(data, req.query.g);
  const bet = findProposal(group, req.params.id);
  if (!bet) return res.status(404).json({ error: 'proposal not found' });
  if (bet.status !== 'proposed' && bet.status !== 'proposal-countered') {
    return res.status(400).json({ error: 'proposal is not open' });
  }
  bet.status = 'declined';
  bet.payout = 0;
  await saveData(data);
  res.json({ bet });
});

// Bettor accepts the market maker's private counter. One round: this ends it.
app.post('/api/proposals/:id/accept-counter', async (req, res) => {
  const data = await loadData();
  const group = getGroup(data, req.query.g);
  const bet = findProposal(group, req.params.id);
  if (!bet) return res.status(404).json({ error: 'proposal not found' });
  if (bet.status !== 'proposal-countered') return res.status(400).json({ error: 'proposal is not countered' });

  const auth = authenticateBettor(req, data.bettors);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  if (auth.bettor.name.toLowerCase() !== bet.bettorName.toLowerCase()) {
    return res.status(403).json({ error: 'not your proposal' });
  }
  const player = group.players.find(p => p.id === bet.playerId);
  if (!player) return res.status(404).json({ error: 'player not found' });
  if (player.status !== 'open') return res.status(400).json({ error: 'market is not open' });

  bet.stake = bet.counterPrice.size;
  bet.price = levelPrice(bet.side, bet.counterPrice.level);
  bet.status = 'open';
  await saveData(data);
  res.json({ bet });
});

// Bettor declines the market maker's counter.
app.post('/api/proposals/:id/decline-counter', async (req, res) => {
  const data = await loadData();
  const group = getGroup(data, req.query.g);
  const bet = findProposal(group, req.params.id);
  if (!bet) return res.status(404).json({ error: 'proposal not found' });
  if (bet.status !== 'proposal-countered') return res.status(400).json({ error: 'proposal is not countered' });

  const auth = authenticateBettor(req, data.bettors);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  if (auth.bettor.name.toLowerCase() !== bet.bettorName.toLowerCase()) {
    return res.status(403).json({ error: 'not your proposal' });
  }
  bet.status = 'declined';
  bet.payout = 0;
  await saveData(data);
  res.json({ bet });
});

// ---------- pages ----------

// Exchange the passcode for a signed session cookie. A browser navigating to
// /admin cannot attach a custom header, so the page gate needs a cookie.
app.post('/api/admin/login', async (req, res) => {
  const data = await loadData();
  const passcode = adminPasscodeFor(data);
  if (!passcode) {
    return res.status(503).json({ error: 'Admin is locked: no passcode configured. Set ADMIN_PASSCODE in the server environment.' });
  }
  if (isLockedOut(req, 'admin')) {
    return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
  }
  if (!safeEqual(req.body && req.body.passcode, passcode)) {
    recordFailure(req, 'admin');
    return res.status(401).json({ error: 'incorrect passcode' });
  }
  clearFailures(req, 'admin');

  const token = adminToken(data);
  await saveData(data); // persists sessionSecret on first login
  const secure = process.env.NODE_ENV === 'production' ? ' Secure;' : '';
  res.setHeader('Set-Cookie',
    `bm_admin=${token}; HttpOnly; SameSite=Strict; Path=/;${secure} Max-Age=${12 * 60 * 60}`);
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'bm_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ ok: true });
});

// The dashboard HTML is no longer served to anonymous visitors. Previously
// anyone with the URL got the full market-maker page.
app.get('/admin', async (req, res) => {
  const data = await loadData();
  const passcode = adminPasscodeFor(data);

  if (!passcode) {
    return res.status(503).send(lockedPage(
      'Admin is locked',
      'No passcode is configured. Set <code>ADMIN_PASSCODE</code> in the server environment and restart.'
    ));
  }
  if (hasAdminCookie(req, data)) {
    return res.sendFile(path.join(__dirname, 'admin.html'));
  }
  return res.status(401).send(loginPage());
});

function lockedPage(title, message) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:system-ui,sans-serif;max-width:26rem;margin:15vh auto;padding:0 1rem;color:#222}
h1{font-size:1.25rem}code{background:#f1f1f1;padding:.1rem .3rem;border-radius:3px}</style>
</head><body><h1>${title}</h1><p>${message}</p></body></html>`;
}

function loginPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Market maker sign in</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:system-ui,sans-serif;max-width:22rem;margin:15vh auto;padding:0 1rem;color:#222}
h1{font-size:1.25rem}input,button{font-size:1rem;padding:.55rem;width:100%;box-sizing:border-box;margin-top:.5rem}
button{cursor:pointer;background:#111;color:#fff;border:0;border-radius:4px}
.err{color:#b00020;margin-top:.75rem;min-height:1.2em;font-size:.9rem}</style>
</head><body>
<h1>Market maker sign in</h1>
<form id="f" autocomplete="off">
  <input type="password" id="p" placeholder="Passcode" autofocus aria-label="Passcode" />
  <button type="submit">Sign in</button>
</form>
<div class="err" id="e"></div>
<script>
document.getElementById('f').addEventListener('submit', async function (ev) {
  ev.preventDefault();
  var e = document.getElementById('e');
  e.textContent = '';
  var r = await fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passcode: document.getElementById('p').value })
  });
  if (r.ok) { location.reload(); return; }
  var d = await r.json().catch(function () { return {}; });
  e.textContent = d.error || 'Sign in failed.';
});
</script>
</body></html>`;
}

// Operational one-shot data reset, triggered by the RESET_DATA env var. Set it
// to any token (e.g. "wipe-2026-07") in the Render environment to clear every
// player, bet, and bettor on the next boot while KEEPING settings (sizes, group
// names, proposal policy, passcode). It applies once per distinct token value:
// once a token has run, restarts won't wipe again, so it's safe to leave set —
// change the token to a new value to wipe again. No browser or sign-in needed.
async function maybeResetData() {
  const token = process.env.RESET_DATA;
  if (!token) return;
  const data = await loadData();
  if (data.settings._resetApplied === token) return; // this token already ran
  data.bettors = [];
  GROUP_IDS.forEach(gid => { data.groups[gid] = defaultGroup(); });
  data.settings._resetApplied = token;
  await saveData(data);
  console.log(`RESET_DATA token "${token}" applied: cleared all players, bets, and bettors (settings kept).`);
}

// Only start the HTTP server when run directly (node server.js). When this file
// is require()'d by a test, we export the app and helpers instead of listening,
// so tests can exercise the pure logic without opening a port or a DB.
if (require.main === module) {
  maybeResetData()
    .catch(err => console.error('RESET_DATA failed:', err))
    .finally(() => {
      app.listen(PORT, () => {
        console.log(`Bowling markets app running at http://localhost:${PORT}`);
        console.log(`Admin dashboard:        http://localhost:${PORT}/admin`);
      });
    });
}

module.exports = {
  app, gradeBet, exposureRows, bettorExposureRows,
  levelPrice, effectiveAllowProposals, normalize, defaultData, maybeResetData
};
