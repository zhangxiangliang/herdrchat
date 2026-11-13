import assert from 'node:assert/strict';
import test from 'node:test';
import { machineOf, splitWhere } from '../lib/core/hc.mjs';

test('splitWhere', () => {
  assert.deepEqual(splitWhere('alpha / 2'), { space: 'alpha', tab: '2' });
  assert.deepEqual(splitWhere('a / b / c'), { space: 'a', tab: 'b / c' });
  assert.equal(splitWhere(undefined), null);
});

test('machineOf', () => {
  assert.equal(machineOf('t37'), null);
  assert.equal(machineOf('box/t4t'), 'box');
});
