import assert from 'node:assert/strict';
import test from 'node:test';
import { coreViews } from '../lib/core/views.mjs';

const link = (name, id, state = 'connected') => ({ name, id, state });

// three sessions on one computer: "main" reaches the other two as machines, and all
// three reach the same server
const cores = new Map([
  ['main', { self: 'core-main', links: [link('box-a', 'core-a'), link('box-b', 'core-b'), link('server', 'core-srv')] }],
  ['a', { self: 'core-a', links: [link('server', 'core-srv')] }],
  ['b', { self: 'core-b', links: [link('server', 'core-srv')] }],
]);

test('one terminal seen through another session is followed only in its own session', () => {
  const v = coreViews(['main', 'a', 'b'], cores);
  assert.equal(v.identity('a', 't37'), v.identity('main', 'box-a/t37'));
  assert.equal(v.owns('a', 't37'), true);
  assert.equal(v.owns('main', 'box-a/t37'), false);
  assert.equal(v.owns('b', 't1'), true);
  assert.equal(v.owns('main', 'box-b/t1'), false);
  assert.equal(v.owns('main', 't4'), true);
});

test('a machine is followed once, by the first session, whatever each session calls it', () => {
  const named = new Map([
    ['a', { self: 'core-a', links: [link('server', 'core-srv')] }],
    ['b', { self: 'core-b', links: [link('agent', 'core-srv')] }],
  ]);
  const v = coreViews(['a', 'b'], named);
  assert.equal(v.identity('a', 'server/t5'), v.identity('b', 'agent/t5'));
  assert.equal(v.owns('a', 'server/t5'), true);
  assert.equal(v.owns('b', 'agent/t5'), false);
});

test('the order of HERDR_SESSIONS does not matter for a session that is followed itself', () => {
  const v = coreViews(['main', 'a', 'b'], cores);
  const w = coreViews(['a', 'b', 'main'], cores);
  for (const x of [v, w]) {
    assert.equal(x.owns('a', 't37'), true);
    assert.equal(x.owns('main', 'box-a/t37'), false);
  }
  assert.equal(v.owns('main', 'server/t5'), true);
  assert.equal(w.owns('a', 'server/t5'), true);
});

test('a dropped connection hands its terminals to the next session connected to that core', () => {
  const dropped = new Map([
    ['a', { self: 'core-a', links: [link('server', 'core-srv', 'disconnected')] }],
    ['b', { self: 'core-b', links: [link('server', 'core-srv')] }],
  ]);
  const v = coreViews(['a', 'b'], dropped);
  assert.equal(v.owns('a', 'server/t5'), false);
  assert.equal(v.owns('b', 'server/t5'), true);
});

test('a session followed only through a machine is followed there', () => {
  const v = coreViews(['main'], cores);
  assert.equal(v.owns('main', 'box-a/t37'), true);
});

test('what the cores cannot tell is left to the caller', () => {
  const v = coreViews(['main', 'x'], cores);
  assert.equal(v.owns('x', 't1'), null); // cores of x unknown
  assert.equal(v.owns('main', 'nowhere/t1'), null); // no such machine
  assert.equal(v.owns('main', 'server/inner/t1'), null); // a machine behind a machine
  assert.equal(v.identity('x', 't1'), null);
});

test('a terminal behind a link that is down is not reachable; one here always is', () => {
  const down = new Map([
    ['a', { self: 'core-a', links: [link('server', 'core-srv', 'unreachable')] }],
    ['b', { self: 'core-b', links: [link('server', 'core-srv')] }],
  ]);
  const v = coreViews(['a', 'b'], down);
  assert.equal(v.reachable('a', 'server/t5'), false);
  assert.equal(v.reachable('b', 'server/t5'), true);
  assert.equal(v.reachable('a', 't1'), true);
  assert.equal(v.reachable('x', 'server/t5'), true); // nothing known: not held back
});
