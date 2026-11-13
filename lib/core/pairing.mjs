// Pairing: how the bot learns who its owner is without anyone copying an id. `herdrchat
// setup` shows a short code and keeps it in state.json; the first person who sends that
// code to the bot becomes its owner. The code lasts PAIR_MINUTES and allows PAIR_TRIES
// wrong guesses, so nobody can guess their way in.
import crypto from 'node:crypto';

export const PAIR_MINUTES = 15;
export const PAIR_TRIES = 5;

// store: {read, write} of state.json
export function startPairing(store, now = Date.now()) {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const state = store.read();
  state.pairing = { code, until: now + PAIR_MINUTES * 60 * 1000, tries: 0 };
  store.write(state);
  return code;
}

// 'ok' (the code, used up), 'wrong' (a guess counted), or 'none' (no pairing running)
export function tryPairing(store, text, now = Date.now()) {
  const state = store.read();
  const p = state.pairing;
  if (!p || now > p.until) return 'none';
  if (String(text || '').trim() === p.code) {
    delete state.pairing;
    store.write(state);
    return 'ok';
  }
  p.tries = (p.tries || 0) + 1;
  if (p.tries >= PAIR_TRIES) delete state.pairing;
  store.write(state);
  return 'wrong';
}

export const pairingRunning = (store, now = Date.now()) => Boolean(store.read().pairing && now <= store.read().pairing.until);
