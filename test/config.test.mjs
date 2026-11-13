import assert from 'node:assert/strict';
import test from 'node:test';
import { onOff, placesOf, spacesOf } from '../lib/core/config.mjs';

test('HERDR_MUTED_SPACES and HERDR_SILENT_SPACES: all, none or some spaces, with a default', () => {
  assert.deepEqual(spacesOf(undefined, 'all'), { all: true, spaces: [] });
  assert.deepEqual(spacesOf(undefined, ''), { all: false, spaces: [] });
  assert.deepEqual(spacesOf('all', ''), { all: true, spaces: [] });
  assert.deepEqual(spacesOf('', 'all'), { all: false, spaces: [] });
  assert.deepEqual(spacesOf('none', 'all'), { all: false, spaces: [] });
  assert.deepEqual(spacesOf(' alpha, beta ', 'all'), { all: false, spaces: ['alpha', 'beta'] });
});

test('HERDR_BOT_TAGS and HERDR_USER_TAGS: on or off, with a default', () => {
  assert.equal(onOff(undefined, true), true);
  assert.equal(onOff('', false), false);
  assert.equal(onOff('off', true), false);
  assert.equal(onOff(' ON ', false), true);
  assert.equal(onOff('no', true), false);
  assert.equal(onOff('maybe', true), true);
});

test('places: one folder pair per profile under XDG, or one folder of your choice', () => {
  assert.deepEqual(placesOf({}, '/h'), { profile: 'default', configDir: '/h/.config/herdrchat/default', stateDir: '/h/.local/state/herdrchat/default', terminal: 'herdrchat' });
  assert.deepEqual(placesOf({ HERDRCHAT_PROFILE: 'work' }, '/h'), { profile: 'work', configDir: '/h/.config/herdrchat/work', stateDir: '/h/.local/state/herdrchat/work', terminal: 'herdrchat-work' });
  assert.deepEqual(placesOf({ XDG_CONFIG_HOME: '/c', XDG_STATE_HOME: '/s' }, '/h'), { profile: 'default', configDir: '/c/herdrchat/default', stateDir: '/s/herdrchat/default', terminal: 'herdrchat' });
  assert.deepEqual(placesOf({ HERDRCHAT_HOME: '/my/hc', HERDRCHAT_PROFILE: 'work' }, '/h'), { profile: 'work', configDir: '/my/hc', stateDir: '/my/hc/state', terminal: 'herdrchat-work' });
  assert.deepEqual(placesOf({ HERDRCHAT_HOME: '', XDG_CONFIG_HOME: '' }, '/h').configDir, '/h/.config/herdrchat/default');
  assert.throws(() => placesOf({ HERDRCHAT_PROFILE: '../x' }, '/h'), /letters, digits/);
});

test('HERDR_HISTORY names the parts a new room gets; an unknown one is refused', async () => {
  const { partsOf } = await import('../lib/core/config.mjs');
  const known = ['file', 'folded'];
  assert.deepEqual(partsOf(undefined, 'file,folded', known), { file: true, folded: true });
  assert.deepEqual(partsOf('folded', 'file,folded', known), { file: false, folded: true });
  assert.deepEqual(partsOf('', 'file,folded', known), { file: false, folded: false });
  assert.deepEqual(partsOf('none', 'file,folded', known), { file: false, folded: false });
  assert.throws(() => partsOf('files', 'file,folded', known, 'HERDR_HISTORY'), /HERDR_HISTORY: files is not one of file, folded/);
});
