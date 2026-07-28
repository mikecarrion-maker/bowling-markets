// Tests for the RESET_DATA one-shot wipe (operational tool).
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const dataFile = path.join(__dirname, '..', 'data', 'db.json');
fs.mkdirSync(path.dirname(dataFile), { recursive: true });
fs.writeFileSync(dataFile, JSON.stringify({
  settings: { standardSize: 42, moveIncrement: 1, adminPasscode: '', groupNames: { la: 'A', london: 'B' } },
  bettors: [{ name: 'Sam', pin: '1' }],
  groups: {
    la: {
      players: [{ id: 'p1', name: 'X', bid: 1, offer: 2, status: 'open', bidSize: 1, offerSize: 1 }],
      bets: [{ id: 'b1', playerId: 'p1', bettorName: 'Sam', side: 'under', stake: 5, status: 'open' }],
      bettors: []
    },
    london: { players: [], bets: [], bettors: [] }
  }
}));

process.env.RESET_DATA = 'wipe1';
const { maybeResetData } = require('../server.js');

let failed = 0;
function t(desc, fn) {
  try { fn(); console.log('  ok   - ' + desc); }
  catch (e) { failed++; console.error('  FAIL - ' + desc + '\n         ' + e.message); }
}
const read = () => JSON.parse(fs.readFileSync(dataFile, 'utf8'));

(async () => {
  await maybeResetData();
  const d1 = read();
  t('players cleared', () => assert.strictEqual(d1.groups.la.players.length, 0));
  t('bets cleared', () => assert.strictEqual(d1.groups.la.bets.length, 0));
  t('bettors cleared', () => assert.strictEqual(d1.bettors.length, 0));
  t('settings kept (standardSize)', () => assert.strictEqual(d1.settings.standardSize, 42));
  t('reset token recorded', () => assert.strictEqual(d1.settings._resetApplied, 'wipe1'));

  // Same token must NOT wipe again (idempotent — safe to leave the var set).
  d1.bettors.push({ name: 'New', pin: '9' });
  fs.writeFileSync(dataFile, JSON.stringify(d1));
  await maybeResetData();
  t('same token does not wipe again', () => assert.strictEqual(read().bettors.length, 1));

  // A new token value wipes again.
  process.env.RESET_DATA = 'wipe2';
  await maybeResetData();
  t('a new token wipes again', () => assert.strictEqual(read().bettors.length, 0));

  fs.rmSync(path.dirname(dataFile), { recursive: true, force: true });
  if (failed > 0) { console.error('\n' + failed + ' test(s) failed'); process.exit(1); }
  console.log('\nAll reset tests passed');
})();
