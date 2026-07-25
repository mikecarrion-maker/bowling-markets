// Tests for settlement grading (Commit 2).
// Run with: npm test
//
// These cover the money path that matters most: how a filled bet resolves once
// the final score is in. Grading is per-bet against the level it executed at.
const assert = require('assert');
const { gradeBet } = require('../server.js');

let failed = 0;
function t(desc, fn) {
  try {
    fn();
    console.log('  ok   - ' + desc);
  } catch (e) {
    failed++;
    console.error('  FAIL - ' + desc);
    console.error('         ' + e.message);
  }
}

// --- The bug this commit fixes -------------------------------------------
// 85/95 market, bowler shoots 87.
t('under that hit the bid at 85 LOSES when the score is 87 (was a push before)', () => {
  const r = gradeBet(87, { side: 'under', stake: 10, price: { bid: 85, offer: 95 } });
  assert.strictEqual(r.outcome, 'lost');
  assert.strictEqual(r.payout, 0);
});
t('over that lifted the offer at 95 LOSES when the score is 87', () => {
  const r = gradeBet(87, { side: 'over', stake: 10, price: { bid: 85, offer: 95 } });
  assert.strictEqual(r.outcome, 'lost');
  assert.strictEqual(r.payout, 0);
});

// --- Straightforward wins ------------------------------------------------
t('under wins when the final score is below the bid it hit', () => {
  const r = gradeBet(80, { side: 'under', stake: 10, price: { bid: 85, offer: 95 } });
  assert.strictEqual(r.outcome, 'won');
  assert.strictEqual(r.payout, 20);
});
t('over wins when the final score is above the offer it lifted', () => {
  const r = gradeBet(100, { side: 'over', stake: 25, price: { bid: 85, offer: 95 } });
  assert.strictEqual(r.outcome, 'won');
  assert.strictEqual(r.payout, 50);
});

// --- Push: exactly on the level -----------------------------------------
t('under exactly on its bid is a push (stake returned)', () => {
  const r = gradeBet(85, { side: 'under', stake: 10, price: { bid: 85, offer: 95 } });
  assert.strictEqual(r.outcome, 'push');
  assert.strictEqual(r.payout, 10);
});
t('over exactly on its offer is a push (stake returned)', () => {
  const r = gradeBet(95, { side: 'over', stake: 10, price: { bid: 85, offer: 95 } });
  assert.strictEqual(r.outcome, 'push');
  assert.strictEqual(r.payout, 10);
});

// --- Per-bet independence: same market, different execution levels --------
t('two unders executed at different bids grade against their own levels', () => {
  const a = gradeBet(88, { side: 'under', stake: 10, price: { bid: 90, offer: 100 } });
  const b = gradeBet(88, { side: 'under', stake: 10, price: { bid: 85, offer: 95 } });
  assert.strictEqual(a.outcome, 'won');  // 88 < 90 -> under wins
  assert.strictEqual(b.outcome, 'lost'); // 88 > 85 -> under loses
});

// --- Defensive: a missing price never mis-grades as a win/loss -----------
t('a bet with no execution price pushes rather than mis-grading', () => {
  const r = gradeBet(87, { side: 'under', stake: 10, price: null });
  assert.strictEqual(r.outcome, 'push');
});

if (failed > 0) {
  console.error('\n' + failed + ' test(s) failed');
  process.exit(1);
}
console.log('\nAll settlement grading tests passed');
