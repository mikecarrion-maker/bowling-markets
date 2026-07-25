// Integration test for the RFQ / proposal flow (Commit 3).
// Starts the real app on an ephemeral port and drives the endpoints over HTTP,
// so it covers routing, auth, and the money-path invariants:
//   - a proposal is gated by the market's allowProposals policy
//   - a private counter does NOT move the public board
//   - an accepted proposal becomes an open bet at the agreed level
//   - it does NOT consume book size / trigger auto-move
//   - it shows up in exposure and settles against its own level
//
// Uses the local JSON-file store; we wipe it first for a clean slate. (data/ is
// gitignored, so this never gets committed.)
const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.ADMIN_PASSCODE = 'testpass';
try { fs.rmSync(path.join(__dirname, '..', 'data'), { recursive: true, force: true }); } catch (e) {}

const { app } = require('../server.js');

const ADMIN = { 'X-Admin-Passcode': 'testpass', 'Content-Type': 'application/json' };
const BETTOR = { 'X-Bettor-Name': 'Tess', 'X-Bettor-Pin': '1234', 'Content-Type': 'application/json' };

let base;
let failed = 0;
async function req(method, pathname, headers, body) {
  const res = await fetch(base + pathname, {
    method,
    headers: headers || {},
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  try { json = await res.json(); } catch (e) {}
  return { status: res.status, json };
}
function check(desc, cond) {
  if (cond) { console.log('  ok   - ' + desc); }
  else { failed++; console.error('  FAIL - ' + desc); }
}

(async () => {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  base = 'http://127.0.0.1:' + server.address().port;

  // Setup: a bettor with a PIN, and a manual-mode market with the UNDER side
  // exhausted (bidSize 0) but the OVER side still live (offerSize 10).
  await req('POST', '/api/bettors?g=la', ADMIN, { name: 'Tess', pin: '1234' });
  const mk = await req('POST', '/api/players?g=la', ADMIN, {
    name: 'Baller', bid: 80, offer: 90, bidSize: 0, offerSize: 10
  });
  const pid = mk.json.id;
  check('new player defaults to manual (finite) mode', mk.json.mode === 'finite');

  // exhausted-only policy: proposing on the still-liquid OVER side is rejected.
  const badOver = await req('POST', `/api/players/${pid}/propose?g=la`, BETTOR, { side: 'over', level: 95, size: 5 });
  check('proposal on a side with liquidity is rejected under exhausted-only', badOver.status === 400);

  // Proposing on the exhausted UNDER side is allowed.
  const prop = await req('POST', `/api/players/${pid}/propose?g=la`, BETTOR, { side: 'under', level: 78, size: 25 });
  check('proposal on the exhausted side is accepted', prop.status === 201);
  const propId = prop.json.proposal.id;

  // It appears in the admin proposal queue.
  const q1 = await req('GET', '/api/admin/proposals?g=la', ADMIN);
  check('proposal shows in the admin queue', q1.json.length === 1 && q1.json[0].id === propId);

  // Admin counters privately at 76 / size 20.
  const ctr = await req('POST', `/api/proposals/${propId}/counter?g=la`, ADMIN, { level: 76, size: 20 });
  check('counter sets status to proposal-countered', ctr.json.bet.status === 'proposal-countered');

  // The public board is UNCHANGED by the private counter.
  const board = await req('GET', '/api/players?g=la', null);
  const shown = board.json.find(p => p.id === pid);
  check('private counter does not move the public bid', shown.bid === 80);
  check('private counter does not move the public offer', shown.offer === 90);

  // Bettor accepts the counter -> open bet at 76, size 20.
  const acc = await req('POST', `/api/proposals/${propId}/accept-counter?g=la`, BETTOR, {});
  check('accepted counter becomes an open bet', acc.json.bet.status === 'open');
  check('accepted at the countered stake', acc.json.bet.stake === 20);
  check('accepted at the countered level (under -> price.bid)', acc.json.bet.price.bid === 76);

  // Book size on the exhausted side is still 0 (no size consumed, no auto-move).
  const board2 = await req('GET', '/api/players?g=la', null);
  const shown2 = board2.json.find(p => p.id === pid);
  check('accepted proposal did not consume book size / auto-move', shown2.bidSize === 0 && shown2.bid === 80);

  // It shows in exposure as under risk.
  const exp = await req('GET', '/api/admin/exposure?g=la', ADMIN);
  const row = exp.json.rows.find(r => r.playerId === pid);
  check('accepted proposal appears in exposure under stakes', row && row.underStakes === 20);

  // Settle at 70: under at 76 wins (70 < 76), even-money payout 40.
  const st = await req('POST', `/api/players/${pid}/settle?g=la`, ADMIN, { finalScore: 70 });
  const settled = st.json.bets.find(b => b.id === propId);
  check('accepted proposal settles against its own level (won)', settled.status === 'won' && settled.payout === 40);

  // Decline path on a fresh proposal.
  await req('POST', '/api/players?g=la', ADMIN, { name: 'B2', bid: 50, offer: 60, bidSize: 0, offerSize: 0 });
  const players = (await req('GET', '/api/admin/players?g=la', ADMIN)).json;
  const p2 = players.find(p => p.name === 'B2').id;
  const prop2 = await req('POST', `/api/players/${p2}/propose?g=la`, BETTOR, { side: 'over', level: 65, size: 10 });
  const declined = await req('POST', `/api/proposals/${prop2.json.proposal.id}/decline?g=la`, ADMIN, {});
  check('admin can decline a proposal', declined.json.bet.status === 'declined');

  server.close();
  if (failed > 0) { console.error('\n' + failed + ' proposal test(s) failed'); process.exit(1); }
  console.log('\nAll proposal (RFQ) flow tests passed');
})();
