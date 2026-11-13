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
  assert.deepEqual(placesOf({}, '/h'), { profile: 'default', id: 'default', configDir: '/h/.config/herdrchat/default', stateDir: '/h/.local/state/herdrchat/default', terminal: 'herdrchat' });
  assert.deepEqual(placesOf({ HERDRCHAT_PROFILE: 'work' }, '/h'), { profile: 'work', id: 'work', configDir: '/h/.config/herdrchat/work', stateDir: '/h/.local/state/herdrchat/work', terminal: 'herdrchat-work' });
  const xdg = placesOf({ XDG_CONFIG_HOME: '/c', XDG_STATE_HOME: '/s' }, '/h');
  assert.equal(xdg.configDir, '/c/herdrchat/default');
  assert.equal(xdg.stateDir, '/s/herdrchat/default');
  const moved = placesOf({ HERDRCHAT_HOME: '/my/hc', HERDRCHAT_PROFILE: 'work' }, '/h');
  assert.equal(moved.configDir, '/my/hc');
  assert.equal(moved.stateDir, '/my/hc/state');
  // a moved setup never shares a terminal or service name with the usual one
  assert.match(moved.id, /^work-[0-9a-f]{6}$/);
  assert.equal(moved.terminal, `herdrchat-${moved.id}`);
  assert.match(xdg.terminal, /^herdrchat-default-[0-9a-f]{6}$/);
  assert.notEqual(placesOf({ HERDRCHAT_HOME: '/other' }, '/h').id, placesOf({ HERDRCHAT_HOME: '/my/hc' }, '/h').id);
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

test('setConfigValue sets one key and keeps every other line, comments too', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { setConfigValue } = await import('../lib/core/config.mjs');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'herdrchat-setvalue-')), 'config.env');
  fs.writeFileSync(file, '# a comment\nTELEGRAM_BOT_TOKEN=\nHERDR_SESSIONS=\n');
  setConfigValue(file, 'TELEGRAM_BOT_TOKEN', '1:abc');
  setConfigValue(file, 'TELEGRAM_OWNER_ID', '42');
  assert.equal(fs.readFileSync(file, 'utf8'), '# a comment\nTELEGRAM_BOT_TOKEN=1:abc\nHERDR_SESSIONS=\nTELEGRAM_OWNER_ID=42\n');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('a pairing code makes one owner, expires, and stops after five wrong guesses', async () => {
  const { startPairing, tryPairing } = await import('../lib/core/pairing.mjs');
  let state = {};
  const store = { read: () => JSON.parse(JSON.stringify(state)), write: (s) => { state = s; } };
  const code = startPairing(store, 1000);
  assert.match(code, /^\d{6}$/);
  assert.equal(tryPairing(store, '000000' === code ? '111111' : '000000', 2000), 'wrong');
  assert.equal(tryPairing(store, ` ${code} `, 2000), 'ok');
  assert.equal(tryPairing(store, code, 2000), 'none', 'used up');
  const later = startPairing(store, 1000);
  assert.equal(tryPairing(store, later, 1000 + 16 * 60 * 1000), 'none', 'expired');
  const guessed = startPairing(store, 1000);
  for (let i = 0; i < 5; i += 1) assert.equal(tryPairing(store, guessed === '999999' ? '000000' : '999999', 2000), 'wrong');
  assert.equal(tryPairing(store, guessed, 2000), 'none', 'locked after five wrong guesses');
});
