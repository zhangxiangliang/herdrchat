// The core's dialogs: what a terminal waits on (from the agent's own API or hook, else
// its screen, also before the agent starts), one card per dialog, and a tap on a card.
import { askOf } from '../asks.mjs';
import { tidyScreen } from '../hc.mjs';
import { menuOf } from '../menu.mjs';
import * as words from '../words.mjs';
import { SCREEN_LINES, KEY_SETTLE_MS, CLICK_BUDGET_MS, DRAW_TRIES, BOX_GAP_MS, DRAW_WAIT_MS, GATE_WAITS_MS, DIALOG_LINES } from './limits.mjs';

export function createDialogs(ctx) {
  const { agentFooter, agentOf, chat, deliver, footerFor, handles, hc, key, later, log, logError, logWarn, ownerActions, postTo, quick, read, screenFooter, shownWhere, sleep, startingOf, timers, views, write } = ctx;

  // What each dialog card showed, by message, so an answered card keeps it.
  const dialogCards = new Map();
  function remember(message, shown) {
    dialogCards.set(message, shown);
    if (dialogCards.size > 200) dialogCards.delete(dialogCards.keys().next().value);
  }

  // With a menu, the card shows only the dialog, as plain text that wraps on a phone;
  // without one, the last lines of the screen, where a dialog sits.
  const escapeMarkdown = (text) => text.replace(/[\\`*_[\]#>~|]/g, '\\$&');
  // `gate`: what an agent shows before it starts (gated, below)
  function dialogOf(status, screenText, footer, { gate = false } = {}) {
    const menu = menuOf(screenText, { arrows: gate });
    const title = words.needs(gate ? words.TO_START : status?.kind);
    const markdown = menu ? escapeMarkdown(menu.text) : `\`\`\`\n${tidyScreen(screenText, DIALOG_LINES)}\n\`\`\``;
    return { menu, title, markdown, doneTitle: words.DONE, footer, ...(gate ? { gate: true } : {}) };
  }
  // A dialog the agent itself names through its own API (its reader's `dialog`), in the
  // shape a screen's dialog has; `menu.own` is the agent's, for its reader's `answer`.
  function agentDialog(d, status, footer) {
    const options = d.options.map(({ n, label, checked }) => ({ n, label, checked: checked ?? null }));
    const free = d.free ? options.find((o) => o.n === d.free.n) || null : null;
    const menu = { key: d.key, options, multi: Boolean(d.multi), free, text: d.text || '', framed: true, beside: false, cursor: 1, own: d };
    return { menu, title: words.needs(d.kind || status?.kind || 'question'), markdown: escapeMarkdown(d.text || ''), doneTitle: words.DONE, footer };
  }
  // What a terminal asks now: from the agent's own API when its reader has one, which an
  // update of the agent's screen cannot break; else read off its screen.
  async function askedNow(session, address, record, status) {
    const reader = agentOf(record);
    if (reader?.dialog) {
      const d = await reader.dialog(session, address).catch((err) => logWarn(`${session}/${address}: ${reader.app} dialog not read (${err.message})`));
      if (d) return agentDialog(d, status, await agentFooter(session, record, reader));
    }
    return dialogOf(status, await hc.screenTail(session, address, SCREEN_LINES), await screenFooter(session, record));
  }

  // c: the terminal's width when the card was made, to tell a resize from a new dialog
  const dialogValue = (session, address, dialog, cols) => ({ s: session, a: address, k: dialog.menu.key, ...(cols ? { c: cols } : {}) });

  // One dialog gets one card. A dialog is named by its menu key (or, with no menu, by its
  // status words); the name is claimed before anything is sent, so the turn event, a
  // status event and a click that all see the same dialog post it once. Leaving `blocked`
  // forgets it, so the same dialog asked again later gets a card again.
  const postedDialog = new Map(); // terminal key -> name of the dialog last posted
  const dialogName = (dialog, status) => (dialog.menu ? dialog.menu.key : `${status?.kind || ''}|${status?.msg || ''}`);
  function claimDialog(k, dialog, status) {
    const name = dialogName(dialog, status);
    if (postedDialog.get(k) === name) return false;
    postedDialog.set(k, name);
    return true;
  }

  // The dialog card still waiting, per terminal. When its dialog goes away, the card drops
  // its buttons and says so, so the room never shows a question nobody waits on. Kept in
  // state.json (openCards) too: after a restart the card out is known, so it is neither
  // posted again nor left without what its buttons mean.
  const openCard = (() => {
    const mem = new Map(Object.entries(read().openCards || {}));
    const save = () => {
      const state = read();
      state.openCards = Object.fromEntries(mem);
      write(state);
    };
    return {
      get: (k) => mem.get(k),
      has: (k) => mem.has(k),
      set: (k, { message, dialog }) => { mem.set(k, { message, dialog }); save(); },
      delete: (k) => { const had = mem.delete(k); if (had) save(); return had; },
      entries: () => [...mem.entries()],
    };
  })();
  for (const [k, { message, dialog }] of openCard.entries()) {
    remember(message, dialog);
    postedDialog.set(k, dialogName(dialog, {}));
  }
  async function closeCard(k, done) {
    const open = openCard.get(k);
    if (!open) return;
    openCard.delete(k);
    try {
      await chat.closeDialog(open.message, open.dialog, done);
    } catch (err) {
      logError(`dialog card ${open.message} not closed (${err.message})`);
    }
  }

  // `screen`: the screen read when the event came (a promise), so a dialog answered in
  // the terminal while earlier work was still being posted still gets its card. `again`:
  // post it even if it was posted (you typed in the room while it waits). A screen read
  // the moment `blocked` arrives may come before the dialog is drawn, and then a numbered
  // list the agent wrote looks like a menu: a dialog is believed once it has its top
  // border and two reads DRAW_WAIT_MS apart show the same one, or after DRAW_TRIES reads.
  // `own`: only what the agent itself names (its hook just asked); nothing from the screen.
  async function postBlocked(session, address, record, { screen: first = null, again = false, own = false } = {}) {
    let dialog = null;
    const reader = agentOf(record);
    if (reader?.dialog) {
      // the agent names it itself: asked again a moment later while it has not yet, unless
      // it cannot tell here (false: no hook on that machine)
      for (let i = 0; i < DRAW_TRIES; i += 1) {
        const d = await reader.dialog(session, address).catch((err) => logWarn(`${session}/${address}: ${reader.app} dialog not read (${err.message})`));
        if (d) {
          dialog = agentDialog(d, record.status, await agentFooter(session, record, reader));
          break;
        }
        if (d === false) break;
        await sleep(DRAW_WAIT_MS);
      }
    }
    if (!dialog && own) return;
    if (!dialog) {
      const firstScreen = await first;
      const footer = await screenFooter(session, record);
      dialog = firstScreen ? dialogOf(record.status, firstScreen, footer) : null;
      for (let i = 0; i < DRAW_TRIES; i += 1) {
        if (dialog || i) await sleep(DRAW_WAIT_MS);
        const next = dialogOf(record.status, await hc.screenTail(session, address, SCREEN_LINES), footer);
        const steady = dialog?.menu?.framed && next.menu?.key === dialog.menu.key;
        dialog = next;
        if (steady) break;
      }
    }
    const k = key(session, address);
    // answered while its screen was being read: nothing waits, so no card (what the agent
    // names itself waits until answered, whatever its status says: Codex works on while
    // its hook asks)
    const nowStatus = (await hc.getTerminal(session, address).catch(() => null))?.status;
    if (!dialog.menu?.own && nowStatus && nowStatus.state !== 'blocked') {
      log(`<- ${session}/${address}: no card, it no longer waits (${nowStatus.state})`);
      return;
    }
    if (!claimDialog(k, dialog, record.status) && !again) return;
    try {
      await sendBlocked(session, address, record, k, dialog);
    } catch (err) {
      // not posted: let the next event (or a held message) post it, never "posted already"
      if (postedDialog.get(k) === dialogName(dialog, record.status)) postedDialog.delete(k);
      throw err;
    }
    log(`<- ${session}/${address}: blocked${dialog.menu ? ` (${dialog.menu.options.length} options)` : ''}`);
  }
  // Whether the terminal still waits on what `dialog` asks: blocked; or its hook still
  // asks (Codex works on meanwhile); or, for a question that leaves the agent idle
  // (`idle`: Codex's async ones, answered by your next message), it does not work; for
  // what an agent asks before it starts, it has not started.
  function stillAsks(record, dialog) {
    if (dialog?.gate) return gated(record);
    if (record?.status?.state === 'blocked') return true;
    const own = dialog?.menu?.own;
    if (own && askOf(record)) return true;
    return Boolean(own?.idle && record?.status?.state && record.status.state !== 'working');
  }
  // A question the agent asked that leaves it idle (its reader's dialog, `idle`): its card
  // goes once its turn has been posted, and at a sweep when it has none.
  async function postIdleAsk(session, address, record) {
    const reader = agentOf(record);
    if (!reader?.dialog) return;
    const d = await reader.dialog(session, address).catch((err) => logWarn(`${session}/${address}: ${reader.app} dialog not read (${err.message})`));
    if (!d?.idle) return;
    const k = key(session, address);
    const dialog = agentDialog(d, record.status, await agentFooter(session, record, reader));
    if (!claimDialog(k, dialog, record.status)) return;
    try {
      await sendBlocked(session, address, record, k, dialog);
    } catch (err) {
      if (postedDialog.get(k) === dialogName(dialog, record.status)) postedDialog.delete(k);
      throw err;
    }
    log(`<- ${session}/${address}: asks (${dialog.menu.options.length} options; it waits idle)`);
  }
  // Before an agent starts, what it shows first can wait on you: Claude Code asks to trust
  // a new folder, Codex offers its update. hc has no status for it yet, and nothing of the
  // agent's own runs before it is answered (no hook, no session), so the screen is all
  // there is: read only while the agent's process runs with no status (startingOf), and
  // only a menu (with or without numbers) counts. A terminal is looked at GATE_WAITS_MS
  // after it starts and at every sweep; its card closes as the agent's first status comes.
  const gated = (term) => Boolean(startingOf(term));
  async function gateNow(session, address, term, footer = null) {
    if (!gated(term)) return null;
    const dialog = dialogOf(null, await hc.screenTail(session, address, SCREEN_LINES), footer, { gate: true });
    return dialog.menu ? dialog : null;
  }
  // One look at a time per terminal: a look while one is on its way waits for it (you
  // type while the sweep posts the card: one card, there when the reply says so).
  const gateLooks = new Map();
  function postGate(session, address, record) {
    const k = key(session, address);
    if (!gateLooks.has(k)) gateLooks.set(k, lookAtGate(session, address, record).finally(() => gateLooks.delete(k)));
    return gateLooks.get(k);
  }
  async function lookAtGate(session, address, record) {
    const k = key(session, address);
    // herdr-app may show it only now (its tab's labels come after the terminal)
    if (openCard.has(k) || !shownWhere(record) || !handles(session, address)) return;
    const term = await hc.getTerminal(session, address).catch(() => null);
    const reader = startingOf(term);
    if (!reader) return;
    const footer = await footerFor(session, record, reader.app, {}, { screen: true });
    // drawn steady: two reads DRAW_WAIT_MS apart show the same menu
    let dialog = await gateNow(session, address, term, footer);
    if (!dialog) return;
    await sleep(DRAW_WAIT_MS);
    const next = await gateNow(session, address, await hc.getTerminal(session, address).catch(() => null), footer);
    if (next?.menu.key !== dialog.menu.key) return; // still drawing: the next look gets it
    dialog = next;
    if (!claimDialog(k, dialog, null)) return;
    try {
      await sendBlocked(session, address, record, k, dialog);
    } catch (err) {
      if (postedDialog.get(k) === dialogName(dialog, null)) postedDialog.delete(k);
      throw err;
    }
    log(`<- ${session}/${address}: ${reader.app} asks before it starts (${dialog.menu.options.length} options)`);
  }
  function lookForGate(session, address) {
    for (const ms of GATE_WAITS_MS) timers.push(setTimeout(() => later(session, address, 'dialog', () => postGate(session, address, views.get(session)?.terminals.get(address) || { address })), quick ? ms / 100 : ms));
  }

  async function sendBlocked(session, address, record, k, dialog) {
    await closeCard(k, words.MOVED_ON);
    if (!dialog.menu) {
      const sent = await postTo(session, record, `**${dialog.title}**\n\n${dialog.markdown}\n\n${words.ANSWER_HOW}`, dialog.footer);
      const room = read().chats[k]?.chat;
      if (room) await chat.pin(k, room, sent);
      await chat.ring(k, sent, words.RING_NEEDS);
    } else {
      const message = await deliver(session, record, (room) => chat.postDialog(room, dialog, dialogValue(session, address, dialog, record.cols)));
      if (message) {
        remember(message, dialog);
        openCard.set(k, { message, dialog });
        const room = read().chats[k]?.chat;
        if (room) await chat.pin(k, room, message);
        await chat.ring(k, message, words.RING_NEEDS);
        // answered while the card was on its way: nothing will close it later, so now
        const live = views.get(session)?.terminals.get(address);
        if (!stillAsks(live, dialog) || postedDialog.get(k) !== dialogName(dialog, record.status)) await closeCard(k, words.ANSWERED);
      } else {
        throw new Error('the room for its card is gone');
      }
    }
  }

  // The keys that pick an option: its digit, or, in a question with previews or a menu
  // before an agent starts (which take no digit), the arrows from the cursor to it and Enter.
  function pickKeys(menu, option) {
    if (!menu.beside && !menu.arrows) return [String(option.n)];
    const moves = option.n - (menu.cursor || 1);
    return [...Array(Math.abs(moves)).fill(moves > 0 ? 'down' : 'up'), 'enter'];
  }

  // "Type something": pick that option, then type the words.
  async function answerFree(session, address, menu, text) {
    await hc.keys(session, address, pickKeys(menu, menu.free));
    await sleep(300);
    await hc.send(session, address, text, { force: true });
  }

  const toast = (type, text) => ({ toast: { type, text } });
  const answered = (shown, done) => ({ ...toast('info', done), card: { kind: 'done', dialog: shown, done } });

  // A click on a dialog card. The screen is read again first, and nothing is pressed
  // unless it still shows the dialog the card was made from (same key) with the same
  // option. After the key, the card turns into the dialog's next step (the next question,
  // the review, a toggled box) or says what was picked.
  async function onAction({ value: v = {}, message, answer = '', ticks = null }) {
    // a button on a card to the owner (tellOwner), not a terminal's: whoever made the card
    // answers it (ownerActions: {name: (value) -> {toast, card?}}, by the key its value has)
    const own = Object.keys(ownerActions).find((name) => v[name] !== undefined);
    if (own) return ownerActions[own](v);
    const started = Date.now();
    const shown = dialogCards.get(message) || { title: words.NEEDS, markdown: '', doneTitle: words.DONE };
    // A box in a multi-select is ticked on the card only, at once; Next sends them all.
    const box = shown.menu?.multi && typeof v.pick === 'number' ? shown.menu.options.find((o) => o.n === v.pick && o !== shown.menu.free && o.checked !== null) : null;
    if (box) {
      const menu = { ...shown.menu, options: shown.menu.options.map((o) => (o === box ? { ...o, checked: !o.checked } : o)) };
      const toggled = { ...shown, menu };
      remember(message, toggled);
      return { ...toast('info', words.toggled(box.checked, box.label)), card: { kind: 'dialog', dialog: toggled, value: v } };
    }
    const record = views.get(v.s)?.terminals.get(v.a);
    if (!record || record.state !== 'live') {
      log(`-> ${v.s}/${v.a}: click on ${message} not pressed: the terminal has ended`);
      return answered(shown, words.ENDED_DONE);
    }
    const term = await hc.getTerminal(v.s, v.a);
    const status = term.status;
    const k = key(v.s, v.a);
    if (shown.menu?.own || (!shown.menu && agentOf(record)?.dialog)) return answerOwn({ v, message, answer, ticks, shown, record, term, status, k });
    const gate = gated(term);
    const menu = status?.state === 'blocked' || gate ? menuOf(await hc.screenTail(v.s, v.a, SCREEN_LINES), { arrows: gate }) : null;
    if (!menu || menu.key !== v.k) {
      log(`-> ${v.s}/${v.a}: click on ${message} not pressed: ${menu ? `the dialog changed (card ${v.k}, screen ${menu.key}; width then ${v.c || '?'}, now ${term.cols || '?'})` : `nothing waits (status ${status?.state || 'none'})`}`);
      if (!menu) return answered(shown, words.NO_LONGER_WAITS);
      // The card in your hand becomes what the screen asks now, to tap again. Never "see the
      // new card": a new card can be held back as already posted, and then nothing is left
      // to answer while your messages wait on the dialog.
      const now = dialogOf(status, await hc.screenTail(v.s, v.a, SCREEN_LINES), shown.footer, { gate });
      if (!now.menu) return answered(shown, words.NO_LONGER_WAITS);
      if (openCard.get(k) && openCard.get(k).message !== message) await closeCard(k, words.MOVED_ON);
      postedDialog.set(k, dialogName(now, status));
      remember(message, now);
      openCard.set(k, { message, dialog: now });
      return { ...toast('warning', words.CHANGED_BEFORE_TAP), card: { kind: 'dialog', dialog: now, value: dialogValue(v.s, v.a, now, term.cols) } };
    }
    if (openCard.get(k)?.message === message) openCard.delete(k);
    let picked;
    if (v.pick === 'tab' && shown.menu?.multi) {
      // the boxes as ticked on the card (sent with Next by a form, or kept per tap), made
      // so on the screen: each one that differs is pressed
      const wanted = ticks ? { ...shown.menu, options: shown.menu.options.map((o) => (o.checked === null ? o : { ...o, checked: Boolean(ticks[o.n]) })) } : shown.menu;
      const changed = wanted.options.filter((o) => o.checked !== null && o.checked !== menu.options.find((m) => m.n === o.n)?.checked);
      for (const o of changed) {
        await hc.keys(v.s, v.a, [String(o.n)]);
        await sleep(BOX_GAP_MS);
      }
      await hc.keys(v.s, v.a, ['tab']);
      const ticked = wanted.options.filter((o) => o.checked).map((o) => o.label);
      picked = ticked.length ? ticked.join(', ') : words.NOTHING_TICKED;
    } else if (v.pick === 'esc' || v.pick === 'tab') {
      await hc.keys(v.s, v.a, [v.pick]);
      picked = v.pick === 'esc' ? words.ESC_PRESSED : words.NEXT;
    } else {
      const option = menu.options.find((o) => o.n === v.pick);
      if (!option || option.label !== v.label) {
        log(`-> ${v.s}/${v.a}: click on ${message} not pressed: option ${v.pick} is now ${option ? `"${option.label}"` : 'gone'}, not "${v.label}"`);
        return answered(shown, words.OPTIONS_CHANGED_PRESSED);
      }
      if (option === menu.free) {
        const text = answer.trim();
        if (!text) return toast('warning', words.TYPE_FIRST);
        await answerFree(v.s, v.a, menu, text);
        picked = text;
      } else {
        await hc.keys(v.s, v.a, pickKeys(menu, option));
        picked = `${option.n}. ${option.label}`;
      }
    }
    log(`-> ${v.s}/${v.a}: picked ${picked}`);
    // past what it asked before it starts, it may ask the next thing before it starts
    if (gate) lookForGate(v.s, v.a);

    // A slow machine: answer the click now, show the next step as a new card after.
    if (Date.now() - started > CLICK_BUDGET_MS) {
      later(v.s, v.a, 'dialog', async () => {
        await sleep(KEY_SETTLE_MS);
        const next = (await hc.getTerminal(v.s, v.a)).status;
        if (next?.state === 'blocked') await postBlocked(v.s, v.a, { ...record, status: next });
      });
      return answered(shown, words.picked(picked));
    }
    await sleep(KEY_SETTLE_MS);
    const nextTerm = await hc.getTerminal(v.s, v.a);
    const nextStatus = nextTerm.status;
    const nextGate = gated(nextTerm);
    if (nextStatus?.state === 'blocked' || nextGate) {
      const next = dialogOf(nextStatus, await hc.screenTail(v.s, v.a, SCREEN_LINES), shown.footer, { gate: nextGate });
      // the same dialog (a toggled box) is redrawn here; a new one only if no card has it yet
      if (next.menu && (next.menu.key === v.k || claimDialog(k, next, nextStatus))) {
        remember(message, next);
        openCard.set(k, { message, dialog: next });
        return { ...toast('info', words.picked(picked)), card: { kind: 'dialog', dialog: next, value: dialogValue(v.s, v.a, next, term.cols) } };
      }
      // its card is out already, unless that card was closed: then this one shows it
      if (next.menu && openCard.has(k)) return answered(shown, words.picked(picked));
      if (next.menu) {
        postedDialog.set(k, dialogName(next, nextStatus));
        remember(message, next);
        openCard.set(k, { message, dialog: next });
        return { ...toast('info', words.picked(picked)), card: { kind: 'dialog', dialog: next, value: dialogValue(v.s, v.a, next, term.cols) } };
      }
      // still waiting, on something with no menu: hc sends no new turn for it, so post it
      // (before it starts, no menu is it starting)
      if (!nextGate) later(v.s, v.a, 'dialog', () => postBlocked(v.s, v.a, { ...record, status: nextStatus }));
    }
    return answered(shown, words.picked(picked));
  }

  // A click on a card the agent's own API made: answered through that API, after asking it
  // what it waits on now; nothing is typed into the terminal.
  async function answerOwn({ v, message, answer, ticks, shown, record, term, status, k }) {
    const reader = agentOf(record);
    const now = reader?.dialog ? (await reader.dialog(v.s, v.a).catch(() => null)) || null : null;
    if (!now) {
      log(`-> ${v.s}/${v.a}: click on ${message} not answered: nothing waits (status ${status?.state || 'none'})`);
      return answered(shown, words.NO_LONGER_WAITS);
    }
    const asked = agentDialog(now, status, shown.footer);
    if (now.key !== v.k) {
      log(`-> ${v.s}/${v.a}: click on ${message} not answered: it asks something else now (${now.key})`);
      if (openCard.get(k) && openCard.get(k).message !== message) await closeCard(k, words.MOVED_ON);
      postedDialog.set(k, dialogName(asked, status));
      remember(message, asked);
      openCard.set(k, { message, dialog: asked });
      return { ...toast('warning', words.ASKS_ELSE), card: { kind: 'dialog', dialog: asked, value: dialogValue(v.s, v.a, asked, term.cols) } };
    }
    let picked;
    let reply;
    if (v.pick === 'esc') {
      reply = { esc: true };
      picked = words.CANCELLED;
    } else if (v.pick === 'tab' && asked.menu.multi) {
      const boxes = shown.menu?.multi ? shown.menu.options : asked.menu.options;
      const ticked = ticks || Object.fromEntries(boxes.filter((o) => o.checked !== null).map((o) => [o.n, o.checked]));
      reply = { ticks: ticked };
      picked = boxes.filter((o) => ticked[o.n]).map((o) => o.label).join(', ') || words.NOTHING_TICKED;
    } else {
      const option = now.options.find((o) => o.n === v.pick);
      if (!option || option.label !== v.label) return answered(shown, words.OPTIONS_CHANGED_ANSWERED);
      if (now.free && option.n === now.free.n) {
        const text = answer.trim();
        if (!text) return toast('warning', words.TYPE_FIRST);
        reply = { pick: option.n, text };
        picked = text;
      } else {
        reply = { pick: option.n };
        picked = `${option.n}. ${option.label}`;
      }
    }
    // the card is this click's from here: the agent moving on as the answer lands must not
    // close it as "Answered" over what was picked
    const open = openCard.get(k)?.message === message ? openCard.get(k) : null;
    if (open) openCard.delete(k);
    if (!(await reader.answer(v.s, v.a, now, reply).catch(() => false))) {
      if (open && !openCard.has(k)) openCard.set(k, open);
      logWarn(`-> ${v.s}/${v.a}: ${reader.app} did not take the answer to ${now.key}`);
      return toast('error', words.notTaken(reader.app));
    }
    log(`-> ${v.s}/${v.a}: answered ${picked} (through ${reader.app})`);
    await sleep(KEY_SETTLE_MS);
    // its next question (of the same form, or a new one) takes this card's place
    const next = await reader.dialog(v.s, v.a).catch(() => null);
    if (next && next.key !== now.key) {
      const nd = agentDialog(next, status, shown.footer);
      postedDialog.set(k, dialogName(nd, status));
      remember(message, nd);
      openCard.set(k, { message, dialog: nd });
      return { ...toast('info', words.picked(picked)), card: { kind: 'dialog', dialog: nd, value: dialogValue(v.s, v.a, nd, term.cols) } };
    }
    return answered(shown, words.picked(picked));
  }

  return { answerFree, answered, askedNow, closeCard, gateNow, gated, lookForGate, onAction, openCard, postBlocked, postGate, postIdleAsk, postedDialog };
}
