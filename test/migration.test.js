// Tests for the global-bettor migration (Commit 5).
const assert = require('assert');
const { normalize } = require('../server.js');

let failed = 0;
function t(desc, fn) {
  try { fn(); console.log('  ok   - ' + desc); }
  catch (e) { failed++; console.error('  FAIL - ' + desc); console.error('         ' + e.message); }
}

t('per-group bettors merge into one global list; a non-empty PIN wins', () => {
  const data = normalize({
    groups: {
      la:     { players: [], bets: [], bettors: [{ name: 'Sam', pin: '' }, { name: 'Kim', pin: '1111' }] },
      london: { players: [], bets: [], bettors: [{ name: 'Sam', pin: '2222' }, { name: 'Lee', pin: '3333' }] }
    }
  });
  assert.deepStrictEqual(data.bettors.map(b => b.name).sort(), ['Kim', 'Lee', 'Sam']);
  assert.strictEqual(data.bettors.find(b => b.name === 'Sam').pin, '2222'); // empty LA pin filled from London
  assert.deepStrictEqual(data.groups.la.bettors, []);
  assert.deepStrictEqual(data.groups.london.bettors, []);
});

t('an existing global list is preserved and idempotent', () => {
  const once = normalize({
    bettors: [{ name: 'Ann', pin: '9' }],
    groups: { la: { players: [], bets: [], bettors: [] }, london: { players: [], bets: [], bettors: [] } }
  });
  const twice = normalize(once);
  assert.strictEqual(twice.bettors.length, 1);
  assert.strictEqual(twice.bettors[0].pin, '9');
});

if (failed > 0) { console.error('\n' + failed + ' test(s) failed'); process.exit(1); }
console.log('\nAll migration tests passed');
