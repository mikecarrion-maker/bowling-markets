// Bowling Tournament Markets - server
// Express app with JSON-file storage. Depth-based bid/offer markets.
// Run: npm install && npm start   -> http://localhost:3000
//   /        -> bettor view (share this link)
//   /admin   -> market maker dashboard

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'db.json');

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

function defaultData() {
  return {
    settings: {
      standardSize: 10,   // default $ size on each side of a fresh/reset market (a "10x10" market)
      moveIncrement: 1,   // default points the bid & offer shift when a side is exhausted
      adminPasscode: ''   // '' = no passcode set yet, /admin is open
    },
    players: [],
    bets: [],
    bettors: []
  };
}

function loadData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.bettors)) data.bettors = [];
    return data;
  } catch (e) {
    const data = defaultData();
    saveData(data);
    return data;
  }
}

function saveData(data) {
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

function publicPlayer(p) {
  // Shape sent to the bettor view - price + available size on each side only.
  return {
    id: p.id,
    name: p.name,
    bid: p.bid,
    bidSize: p.bidSize,
    offer: p.offer,
    offerSize: p.offerSize,
    status: p.status,
    finalScore: p.finalScore
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
      handleExhaustion(player, 'under', settings);
    }
  } else {
    player.offerSize = round2(player.offerSize - stake);
    if (player.offerSize <= 0) {
      player.offerSize = 0;
      handleExhaustion(player, 'over', settings);
    }
  }
}

function requireAdmin(req, res, next) {
  const data = loadData();
  const passcode = data.settings.adminPasscode || '';
  if (!passcode) return next(); // not configured yet - admin is open
  const provided = req.headers['x-admin-passcode'] || '';
  if (provided && provided === passcode) return next();
  return res.status(401).json({ error: 'admin passcode required' });
}

// ---------- public status ----------

app.get('/api/admin/status', (req, res) => {
  const data = loadData();
  res.json({ passcodeSet: !!data.settings.adminPasscode });
});

// ---------- settings ----------

app.get('/api/settings', (req, res) => {
  const data = loadData();
  // never expose the passcode itself to plain GETs without auth
  const { adminPasscode, ...rest } = data.settings;
  res.json({ ...rest, passcodeSet: !!adminPasscode });
});

app.put('/api/settings', requireAdmin, (req, res) => {
  const data = loadData();
  const { standardSize, moveIncrement, adminPasscode } = req.body;
  if (standardSize != null) data.settings.standardSize = Number(standardSize);
  if (moveIncrement != null) data.settings.moveIncrement = Number(moveIncrement);
  if (adminPasscode !== undefined) data.settings.adminPasscode = String(adminPasscode || '');
  saveData(data);
  const { adminPasscode: _omit, ...rest } = data.settings;
  res.json({ ...rest, passcodeSet: !!data.settings.adminPasscode });
});

// ---------- eligible bettors ----------

// Public: list of names for the bettor-view dropdown.
app.get('/api/bettors', (req, res) => {
  const data = loadData();
  res.json([...data.bettors].sort((a, b) => a.localeCompare(b)));
});

app.post('/api/bettors', requireAdmin, (req, res) => {
  const data = loadData();
  const { name } = req.body;
  const trimmed = name == null ? '' : String(name).trim();
  if (!trimmed) return res.status(400).json({ error: 'name is required' });
  if (data.bettors.some(b => b.toLowerCase() === trimmed.toLowerCase())) {
    return res.status(400).json({ error: 'that name is already on the list' });
  }
  data.bettors.push(trimmed);
  saveData(data);
  res.status(201).json([...data.bettors].sort((a, b) => a.localeCompare(b)));
});

app.delete('/api/bettors/:name', requireAdmin, (req, res) => {
  const data = loadData();
  const target = req.params.name.toLowerCase();
  const before = data.bettors.length;
  data.bettors = data.bettors.filter(b => b.toLowerCase() !== target);
  if (data.bettors.length === before) return res.status(404).json({ error: 'name not found' });
  saveData(data);
  res.json([...data.bettors].sort((a, b) => a.localeCompare(b)));
});

// ---------- players / markets ----------

// Public list (bettor view)
app.get('/api/players', (req, res) => {
  const data = loadData();
  res.json(data.players.map(publicPlayer));
});

// Full detail (admin view)
app.get('/api/admin/players', requireAdmin, (req, res) => {
  const data = loadData();
  const enriched = data.players.map(p => {
    const bets = data.bets.filter(b => b.playerId === p.id);
    const pendingCount = bets.filter(b => b.status === 'pending').length;
    return { ...p, betCount: bets.length, pendingCount };
  });
  res.json(enriched);
});

app.post('/api/players', requireAdmin, (req, res) => {
  const data = loadData();
  const { name, bid, offer, bidSize, offerSize, standardSize, moveIncrement, autoMoveEnabled } = req.body;
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
    status: 'open', // open | paused | voided | settled
    finalScore: null
  };
  const eff = effective(player, data.settings);
  player.bidSize = bidSize != null && bidSize !== '' ? Number(bidSize) : eff.standardSize;
  player.offerSize = offerSize != null && offerSize !== '' ? Number(offerSize) : eff.standardSize;

  data.players.push(player);
  saveData(data);
  res.status(201).json(player);
});

// Manual override of a player's market / config / pause-resume
app.put('/api/players/:id', requireAdmin, (req, res) => {
  const data = loadData();
  const player = data.players.find(p => p.id === req.params.id);
  if (!player) return res.status(404).json({ error: 'player not found' });
  if (player.status === 'settled' || player.status === 'voided') {
    return res.status(400).json({ error: 'reopen this market before editing it' });
  }

  const {
    name, bid, offer, bidSize, offerSize,
    standardSize, moveIncrement, autoMoveEnabled, status
  } = req.body;

  if (name != null) player.name = String(name).trim();
  if (bid != null) player.bid = Number(bid);
  if (offer != null) player.offer = Number(offer);
  if (player.offer < player.bid) {
    return res.status(400).json({ error: 'offer must be >= bid' });
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

  saveData(data);
  res.json(player);
});

app.delete('/api/players/:id', requireAdmin, (req, res) => {
  const data = loadData();
  const before = data.players.length;
  data.players = data.players.filter(p => p.id !== req.params.id);
  if (data.players.length === before) return res.status(404).json({ error: 'player not found' });
  data.bets = data.bets.filter(b => b.playerId !== req.params.id);
  saveData(data);
  res.json({ ok: true });
});

// Settle a player's market: enter the final score, grade all open bets.
app.post('/api/players/:id/settle', requireAdmin, (req, res) => {
  const data = loadData();
  const player = data.players.find(p => p.id === req.params.id);
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
  data.bets.forEach(b => {
    if (b.playerId !== player.id) return;
    if (b.status === 'pending') {
      // can't honor unaccepted requests once the market is settled
      b.status = 'declined';
      b.payout = 0;
      declinedPending++;
      return;
    }
    if (b.status !== 'open') return;
    let outcome; // 'won' | 'lost' | 'push'
    if (score < b.price.bid) {
      outcome = b.side === 'under' ? 'won' : 'lost';
    } else if (score > b.price.offer) {
      outcome = b.side === 'over' ? 'won' : 'lost';
    } else {
      outcome = 'push';
    }
    b.status = outcome;
    if (outcome === 'won') b.payout = b.stake * 2; // stake returned + even-money win
    else if (outcome === 'push') b.payout = b.stake; // stake returned
    else b.payout = 0;
  });

  saveData(data);
  res.json({ player, bets: data.bets.filter(b => b.playerId === player.id), declinedPending });
});

// Reopen a settled or voided market (undo)
app.post('/api/players/:id/reopen', requireAdmin, (req, res) => {
  const data = loadData();
  const player = data.players.find(p => p.id === req.params.id);
  if (!player) return res.status(404).json({ error: 'player not found' });
  player.status = 'open';
  player.finalScore = null;
  data.bets.forEach(b => {
    if (b.playerId === player.id && ['won', 'lost', 'push', 'voided'].includes(b.status)) {
      b.status = 'open';
      b.payout = null;
    }
  });
  saveData(data);
  res.json(player);
});

// Void a player's market entirely: no contest, refund every open bet.
app.post('/api/players/:id/void', requireAdmin, (req, res) => {
  const data = loadData();
  const player = data.players.find(p => p.id === req.params.id);
  if (!player) return res.status(404).json({ error: 'player not found' });
  if (player.status === 'settled' || player.status === 'voided') {
    return res.status(400).json({ error: 'market is already settled or voided' });
  }
  player.status = 'voided';
  player.finalScore = null;
  data.bets.forEach(b => {
    if (b.playerId !== player.id) return;
    if (b.status === 'open') {
      b.status = 'voided';
      b.payout = b.stake; // full refund, no contest
    } else if (b.status === 'pending') {
      b.status = 'declined';
      b.payout = 0;
    }
  });
  saveData(data);
  res.json({ player, bets: data.bets.filter(b => b.playerId === player.id) });
});

// ---------- exposure / risk ----------

app.get('/api/admin/exposure', requireAdmin, (req, res) => {
  const data = loadData();
  const rows = data.players
    .filter(p => p.status === 'open' || p.status === 'paused')
    .map(p => {
      const openBets = data.bets.filter(b => b.playerId === p.id && b.status === 'open');
      const underStakes = round2(openBets.filter(b => b.side === 'under').reduce((s, b) => s + b.stake, 0));
      const overStakes = round2(openBets.filter(b => b.side === 'over').reduce((s, b) => s + b.stake, 0));
      const stakesHeld = round2(underStakes + overStakes);
      // If the score lands below everyone's bid: all "under" bets win (paid 2x), all "over" bets lose.
      const netIfLow = round2(overStakes - underStakes);
      // If the score lands above everyone's offer: all "over" bets win (paid 2x), all "under" bets lose.
      const netIfHigh = round2(underStakes - overStakes);
      return { playerId: p.id, name: p.name, stakesHeld, underStakes, overStakes, netIfLow, netIfHigh };
    });
  const totals = rows.reduce((acc, r) => ({
    stakesHeld: round2(acc.stakesHeld + r.stakesHeld),
    underStakes: round2(acc.underStakes + r.underStakes),
    overStakes: round2(acc.overStakes + r.overStakes),
    netIfLow: round2(acc.netIfLow + r.netIfLow),
    netIfHigh: round2(acc.netIfHigh + r.netIfHigh)
  }), { stakesHeld: 0, underStakes: 0, overStakes: 0, netIfLow: 0, netIfHigh: 0 });
  res.json({ rows, totals });
});

// ---------- bets ----------

app.get('/api/bets', (req, res) => {
  const data = loadData();
  let bets = data.bets;
  if (req.query.playerId) bets = bets.filter(b => b.playerId === req.query.playerId);
  if (req.query.bettorName) bets = bets.filter(b => b.bettorName.toLowerCase() === String(req.query.bettorName).toLowerCase());
  bets = [...bets].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  const playerNames = Object.fromEntries(data.players.map(p => [p.id, p.name]));
  res.json(bets.map(b => ({ ...b, playerName: playerNames[b.playerId] || '?' })));
});

// Admin-only: full bet list including bettor names, for the admin bets table.
app.get('/api/admin/bets', requireAdmin, (req, res) => {
  const data = loadData();
  let bets = [...data.bets].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  const playerNames = Object.fromEntries(data.players.map(p => [p.id, p.name]));
  res.json(bets.map(b => ({ ...b, playerName: playerNames[b.playerId] || '?' })));
});

app.get('/api/admin/pending', requireAdmin, (req, res) => {
  const data = loadData();
  let bets = data.bets.filter(b => b.status === 'pending');
  bets = bets.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const playerNames = Object.fromEntries(data.players.map(p => [p.id, p.name]));
  res.json(bets.map(b => ({ ...b, playerName: playerNames[b.playerId] || '?' })));
});

app.post('/api/bets', (req, res) => {
  const data = loadData();
  const { playerId, bettorName, side, stake } = req.body;

  if (!playerId || !bettorName || !side || stake == null) {
    return res.status(400).json({ error: 'playerId, bettorName, side and stake are required' });
  }
  if (side !== 'over' && side !== 'under') {
    return res.status(400).json({ error: "side must be 'over' or 'under'" });
  }
  let canonicalName = String(bettorName).trim();
  if (data.bettors.length > 0) {
    const match = data.bettors.find(b => b.toLowerCase() === canonicalName.toLowerCase());
    if (!match) {
      return res.status(400).json({ error: 'select your name from the bettors list' });
    }
    canonicalName = match;
  }
  const stakeNum = Number(stake);
  if (!(stakeNum > 0)) {
    return res.status(400).json({ error: 'stake must be a positive number' });
  }
  const player = data.players.find(p => p.id === playerId);
  if (!player) return res.status(404).json({ error: 'player not found' });
  if (player.status !== 'open') {
    return res.status(400).json({ error: 'this market is not open for betting' });
  }

  const remaining = side === 'under' ? player.bidSize : player.offerSize;
  const bet = {
    id: id('b'),
    playerId,
    bettorName: canonicalName,
    side,
    stake: stakeNum,
    timestamp: new Date().toISOString(),
    payout: null
  };

  if (stakeNum <= remaining) {
    bet.status = 'open';
    bet.price = { bid: player.bid, offer: player.offer };
    bet.requestedPrice = null;
    fillBet(player, side, stakeNum, data.settings);
  } else {
    bet.status = 'pending';
    bet.price = null;
    bet.requestedPrice = { bid: player.bid, offer: player.offer };
  }

  data.bets.push(bet);
  saveData(data);
  res.status(201).json({ bet, player });
});

// Accept a pending bet: locks in the CURRENT price, consumes size, may trigger auto-move.
app.post('/api/bets/:id/accept', requireAdmin, (req, res) => {
  const data = loadData();
  const bet = data.bets.find(b => b.id === req.params.id);
  if (!bet) return res.status(404).json({ error: 'bet not found' });
  if (bet.status !== 'pending') return res.status(400).json({ error: 'bet is not pending' });
  const player = data.players.find(p => p.id === bet.playerId);
  if (!player) return res.status(404).json({ error: 'player not found' });
  if (player.status !== 'open') return res.status(400).json({ error: 'market is not open' });

  bet.price = { bid: player.bid, offer: player.offer };
  bet.status = 'open';
  fillBet(player, bet.side, bet.stake, data.settings);

  saveData(data);
  res.json({ bet, player });
});

app.post('/api/bets/:id/decline', requireAdmin, (req, res) => {
  const data = loadData();
  const bet = data.bets.find(b => b.id === req.params.id);
  if (!bet) return res.status(404).json({ error: 'bet not found' });
  if (bet.status !== 'pending') return res.status(400).json({ error: 'bet is not pending' });
  bet.status = 'declined';
  bet.payout = 0;
  saveData(data);
  res.json({ bet });
});

// Cancel an open (filled) bet: refund the stake. Does not unwind any market move
// that already happened as a result of this bet.
app.post('/api/bets/:id/cancel', requireAdmin, (req, res) => {
  const data = loadData();
  const bet = data.bets.find(b => b.id === req.params.id);
  if (!bet) return res.status(404).json({ error: 'bet not found' });
  if (bet.status !== 'open') return res.status(400).json({ error: 'only open bets can be cancelled' });
  bet.status = 'cancelled';
  bet.payout = bet.stake;
  saveData(data);
  res.json({ bet });
});

// ---------- pages ----------

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.listen(PORT, () => {
  console.log(`Bowling markets app running at http://localhost:${PORT}`);
  console.log(`Admin dashboard:        http://localhost:${PORT}/admin`);
});
