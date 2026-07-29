// Tests for per-bettor exposure (Commit 4).
const assert = require('assert');
const { bettorExposureRows } = require('../server.js');

let failed = 0;
function t(desc, fn) {
  try { fn(); console.log('  ok   - ' + desc); }
  catch (e) { failed++; console.error('  FAIL - ' + desc); console.error('         ' + e.message); }
}
function group(bets, bettors) {
  return { players: [], bets, bettors: bettors || [] };
}

t('open stake and net exposure are computed per bettor', () => {
  const g = group([
    { bettorName: 'Ann', side: 'under', stake: 10, status: 'open' },
    { bettorName: 'Ann', side: 'over',  stake: 4,  status: 'open' },
  ]);
  const ann = bettorExposureRows(g).rows.find(r => r.name === 'Ann');
  assert.strictEqual(ann.openStake, 14);
  assert.strictEqual(ann.netExposure, -6);  // 4 over - 10 under -> net under
});

t('settled balance sums realised even-money P&L', () => {
  const g = group([
    { bettorName: 'Bo', side: 'under', stake: 10, status: 'won',    payout: 20 }, // +10
    { bettorName: 'Bo', side: 'over',  stake: 5,  status: 'lost',   payout: 0 },  // -5
    { bettorName: 'Bo', side: 'under', stake: 8,  status: 'push',   payout: 8 },  //  0
    { bettorName: 'Bo', side: 'over',  stake: 3,  status: 'voided', payout: 3 },  //  0
  ]);
  const bo = bettorExposureRows(g).rows.find(r => r.name === 'Bo');
  assert.strictEqual(bo.settledBalance, 5);
  assert.strictEqual(bo.openStake, 0);
});

t('bettors with no open bets and no settled history are hidden', () => {
  const g = group(
    [{ bettorName: 'Ann', side: 'under', stake: 10, status: 'open' }],
    [{ name: 'Ann', pin: '1' }, { name: 'Zed', pin: '2' }]
  );
  const rows = bettorExposureRows(g).rows;
  assert.ok(rows.find(r => r.name === 'Ann'));
  assert.ok(!rows.find(r => r.name === 'Zed'));
});

t('totals aggregate across bettors', () => {
  const g = group([
    { bettorName: 'Ann', side: 'under', stake: 10, status: 'open' },
    { bettorName: 'Bo',  side: 'over',  stake: 6,  status: 'open' },
  ]);
  const { totals } = bettorExposureRows(g);
  assert.strictEqual(totals.openStake, 16);
  assert.strictEqual(totals.netExposure, -4); // Ann -10 (under), Bo +6 (over)
});

if (failed > 0) { console.error('\n' + failed + ' test(s) failed'); process.exit(1); }
console.log('\nAll bettor-exposure tests passed');
