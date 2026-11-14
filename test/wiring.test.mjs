import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('every hc call the core makes is wired to the real hc (bin/herdrchat.mjs), not only to the tests\' fake', () => {
  const used = new Set([...read('lib/core/engine.mjs').matchAll(/\bhc\.([a-zA-Z]+)\(/g)].map((m) => m[1]));
  const wired = read('bin/herdrchat.mjs').match(/hc: \{([^}]*)\}/)[1];
  const names = new Set([...wired.matchAll(/\b([a-zA-Z]+)\b(?=\s*[,:]|\s*$)/g)].map((m) => m[1]));
  const missing = [...used].filter((n) => !names.has(n));
  assert.deepEqual(missing, [], `the core calls hc.${missing.join(', hc.')} but bin/herdrchat.mjs does not give it`);
});
