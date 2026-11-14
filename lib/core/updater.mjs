// The bot's side of updating (./update.mjs does the installing):
//   - once connected, it says so when it runs a version other than last time ("herdrchat
//     is now 1.11.0, was 1.10.2"), whatever updated it;
//   - every minute it looks at its code on disk: once that is another version, a bot
//     something starts again (its service, or `herdrchat start`'s loop) stops to run it;
//     one run by hand says so once instead, and keeps running;
//   - when npm installed it, it asks npm daily for a newer version, and offers it once
//     per version: a card in the direct chat with an "Update to …" button. Never by itself:
//     the bot is the only way to the terminals, and a bad version would cut that.
import { compareVersions, installKind, keptRunning, latestVersion, runCommand, update, versionAt } from './update.mjs';

const WATCH_MS = 60 * 1000;
const OFFER_FIRST_MS = 60 * 1000;
const OFFER_MS = 24 * 60 * 60 * 1000;
const RELEASES = 'https://github.com/zhangxiangliang/herdrchat/releases/tag/v';

export function createUpdater({ root, store, chat, log, logWarn, logError, run = runCommand, refreshHook = () => null, env = process.env, exit = (code) => process.exit(code) }) {
  const loaded = versionAt(root);
  let busy = false;
  let saidStale = false;
  const timers = [];

  async function announce() {
    const state = store.read();
    const was = state.ranVersion;
    if (was === loaded) return;
    state.ranVersion = loaded;
    store.write(state);
    if (was) await chat.tellOwner({ title: '✅ herdrchat updated', tone: 'good', markdown: `herdrchat is now ${loaded} (was ${was}). What changed: ${RELEASES}${loaded}` });
  }

  // Its code on disk is another version now: start again on it, or say so.
  async function checkCode() {
    let now;
    try {
      now = versionAt(root);
    } catch {
      return; // being written by npm: next time
    }
    if (now === loaded) return;
    if (keptRunning(env)) {
      log(`herdrchat ${now} is installed (this bot runs ${loaded}); starting again on it`);
      exit(0);
      return;
    }
    if (saidStale) return;
    saidStale = true;
    logWarn(`herdrchat ${now} is installed, but this bot runs ${loaded} and nothing starts it again`);
    await chat.tellOwner({ title: '⚠️ herdrchat needs a restart', tone: 'needs', markdown: `herdrchat ${now} is installed, but this bot still runs ${loaded}, and it was started by hand, so nothing starts it again if it stops. Restart it: \`herdrchat start\` (or stop \`herdrchat run\` and run it again).` });
  }

  // npm has a newer one: offered once per version.
  async function offer() {
    const latest = await latestVersion(run);
    if (!latest || compareVersions(latest, loaded) <= 0) return;
    const state = store.read();
    if (state.offeredVersion === latest) return;
    state.offeredVersion = latest;
    store.write(state);
    log(`herdrchat ${latest} is on npm (this is ${loaded}); offering it`);
    await chat.tellOwner({
      title: `⬆️ herdrchat ${latest} is out`,
      tone: 'working',
      markdown: `You run ${loaded}. What changed: ${RELEASES}${latest}\n\nThe button installs it with npm (with its skill and hook). Then every herdrchat bot on this machine starts again on it by itself: a few seconds without the bot. To go back, in a terminal: \`herdrchat update ${loaded}\``,
      buttons: [{ label: `Update to ${latest}`, value: { update: latest } }],
    });
  }

  // The "Update to …" button: answered at once; the result comes as a message.
  function onUpdate({ update: version }) {
    if (busy) return { toast: { type: 'info', text: 'Already updating.' } };
    busy = true;
    log(`updating to herdrchat ${version}, as asked from the chat`);
    update({ version, root, run, refreshHook })
      .then(async (result) => {
        (result.ok ? log : logError)(`update to ${version}: ${result.lines.join(' / ')}`);
        const tail = result.ok && result.version !== loaded ? '\n\nThis bot starts again on it in a moment, and says so when it is back.' : '';
        await chat.tellOwner({ title: result.ok ? `✅ herdrchat ${result.version} installed` : '🔴 herdrchat was not updated', tone: result.ok ? 'good' : 'bad', markdown: `${result.lines.join('\n')}${tail}` });
        if (result.ok) await checkCode();
      })
      .catch((err) => logError(`update to ${version}: ${err.message}`))
      .finally(() => { busy = false; });
    return {
      toast: { type: 'info', text: `Updating to ${version}…` },
      card: { kind: 'done', dialog: { doneTitle: `⬆️ herdrchat ${version}`, markdown: `Updating from ${loaded}.` }, done: 'Updating: the result comes as a new message.' },
    };
  }

  async function start() {
    await announce().catch((err) => logError(`version notice: ${err.message}`));
    const msg = refreshHook();
    if (msg) log(msg);
    timers.push(setInterval(() => checkCode().catch((err) => logError(`code check: ${err.message}`)), WATCH_MS));
    if ((await installKind(root, run)) !== 'npm') return; // a checkout or by hand: no offers
    const offering = () => offer().catch((err) => logWarn(`looking for a newer herdrchat: ${err.message}`));
    timers.push(setTimeout(offering, OFFER_FIRST_MS));
    timers.push(setInterval(offering, OFFER_MS));
  }

  const stop = () => timers.forEach((t) => clearInterval(t));

  return { start, stop, checkCode, offer, announce, actions: { update: onUpdate } };
}
