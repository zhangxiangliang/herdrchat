// The core starting a terminal for you: from /new with its words, or from the form (/new
// alone, or the overview's button) that picks where, which agent, the tab and the folder.
// hc starts it (`hc run`, `--on` for a machine reached over a link), with the labels
// that say where it is (where, herdr.space, herdr.tab: herdr-app reads them too), so it
// takes nothing but hc: a server with no herdr-app works the same.
import crypto from 'node:crypto';
import os from 'node:os';
import { machineOf, plainError } from '../hc.mjs';
import { shellQuote } from '../shell.mjs';
import * as words from '../words.mjs';

// What the form starts: its agent, by the command that runs it (Shell: the login shell).
export const AGENTS = [
  { id: 'claude', label: 'Claude Code', line: 'claude' },
  { id: 'codex', label: 'Codex', line: 'codex' },
  { id: 'opencode', label: 'OpenCode', line: 'opencode' },
  { id: 'pi', label: 'Pi', line: 'pi' },
  { id: 'shell', label: 'Shell', line: null },
];
const FORMS_KEPT = 20;

export function createCreate(ctx) {
  const { cfg, chat, handles, hc, log, logError, shownWhere, views } = ctx;

  // The spaces there are: [{session, machine (null: this computer), space, spaceId,
  // folder, tabs}], this computer's first, each by name.
  function spacesNow() {
    const found = new Map();
    for (const session of cfg.sessions) {
      for (const record of views.get(session)?.terminals.values() || []) {
        const where = shownWhere(record);
        if (!where || !handles(session, record.address)) continue;
        const machine = machineOf(record.address);
        const id = `${machine || ''}\n${where.space}`;
        if (!found.has(id)) found.set(id, { session, machine, space: where.space, spaceId: null, folder: null, tabs: [] });
        const s = found.get(id);
        s.tabs.push(where.tab);
        s.spaceId ||= record.labels?.['herdr.space'] || null;
        s.folder ||= record.foreground?.cwd || record.cwd || null;
      }
    }
    return [...found.values()].sort((a, b) => (a.machine || '').localeCompare(b.machine || '') || a.space.localeCompare(b.space));
  }

  // The places a new space can go: this computer (the first session), then every machine
  // a session reaches over a link, by the first session that reaches it.
  async function placesNow(spaces) {
    const machines = new Map();
    for (const s of spaces) if (s.machine && !machines.has(s.machine)) machines.set(s.machine, s.session);
    for (const session of cfg.sessions) {
      const links = await hc.cores(session).then((c) => c.links, () => []);
      for (const l of links) if (l.state === 'connected' && !machines.has(l.name)) machines.set(l.name, session);
    }
    return [{ session: cfg.sessions[0], machine: null }, ...[...machines].sort(([a], [b]) => a.localeCompare(b)).map(([machine, session]) => ({ session, machine }))];
  }

  // Starts one: hc runs it through a login shell (PATH as yours), `exec` so no bare shell
  // is left behind; Shell is the login shell itself. On a machine reached over a link the
  // shell is that machine's own ($SHELL), and a folder there under ~ is reached by cd.
  async function start({ session, machine, space, spaceId, tab, folder, line }) {
    const id = (prefix) => `${prefix}${crypto.randomBytes(16).toString('hex')}`;
    const labels = { 'herdr.space': spaceId || id('sp'), 'herdr.tab': id('tb'), where: `${space} / ${tab}` };
    let argv;
    let cwd = folder || null;
    if (machine) {
      const home = cwd && /^~(\/|$)/.test(cwd) ? cwd : null;
      if (home) cwd = null;
      const cd = home ? `cd ~${home.length > 1 ? `/${shellQuote(home.slice(2))}` : ''} && ` : '';
      argv = ['sh', '-c', `${cd}exec "\${SHELL:-sh}" -l${line ? 'c "$0"' : ''}`, ...(line ? [`exec ${line}`] : [])];
    } else {
      cwd = (cwd || os.homedir()).replace(/^~(?=\/|$)/, os.homedir());
      argv = line ? ['/bin/zsh', '-lc', `exec ${line}`] : ['/bin/zsh', '-l'];
    }
    const out = await hc.run(session, { cwd, on: machine, labels, argv });
    const address = JSON.parse(out).address;
    return words.started({ line: line || 'shell', address, session, space, tab, folder: folder || (machine ? '~' : cwd), roomWord: chat.roomWord });
  }

  // /new [--cwd <dir>] <session> <space>/<tab> [command], on this computer
  async function fromWords(args) {
    let cwd = null;
    if (args[0] === '--cwd') {
      cwd = args[1];
      args = args.slice(2);
    }
    const [session, place, ...command] = args;
    if (!cfg.sessions.includes(session)) throw new Error(words.unknownSession(session, cfg.sessions));
    const slash = (place || '').indexOf('/');
    if (slash < 1 || slash === place.length - 1) throw new Error(words.GIVE_PLACE);
    const space = place.slice(0, slash);
    const tab = place.slice(slash + 1);
    const sibling = spacesNow().find((s) => !s.machine && s.space === space);
    return start({ session, machine: null, space, spaceId: sibling?.spaceId, tab, folder: cwd || sibling?.folder, line: command.length ? command.join(' ') : 'claude' });
  }

  // ---------- the form ----------

  // A form is {id, title, markdown, fields, submit}; a field {name, label, kind: pick |
  // text, options: [{label, value}] (pick), initial, optional, placeholder, when: {field,
  // values}: asked only when that field is one of them (an app that shows every field at
  // once shows it anyway; it is checked here)}. What each form's options stand for is kept
  // here by its id, the newest FORMS_KEPT; one from before a restart is told it is old.
  const forms = new Map();
  async function newForm() {
    const spaces = spacesNow();
    const places = await placesNow(spaces);
    const id = crypto.randomBytes(6).toString('base64url');
    const machineName = (m) => m || words.THIS_COMPUTER;
    const remote = places.length > 1;
    const spaceOptions = [
      ...spaces.map((s, i) => ({ label: remote ? `${s.space} · ${machineName(s.machine)}` : s.space, value: `s${i}` })),
      ...places.map((p, i) => ({ label: words.newSpaceOn(remote ? machineName(p.machine) : null), value: `n${i}` })),
    ];
    const fresh = places.map((_, i) => `n${i}`);
    const initial = { space: spaceOptions[0].value, agent: AGENTS[0].id };
    forms.set(id, { spaces, places, initial });
    while (forms.size > FORMS_KEPT) forms.delete(forms.keys().next().value);
    return {
      id,
      title: words.NEW_TITLE,
      markdown: words.NEW_INTRO,
      submit: words.NEW_SUBMIT,
      fields: [
        { name: 'space', label: words.NEW_SPACE, kind: 'pick', options: spaceOptions, initial: initial.space },
        { name: 'name', label: words.NEW_SPACE_NAME, kind: 'text', optional: true, placeholder: words.NEW_SPACE_NAME_HINT, when: { field: 'space', values: fresh } },
        { name: 'agent', label: words.NEW_AGENT, kind: 'pick', options: AGENTS.map((a) => ({ label: a.label, value: a.id })), initial: initial.agent },
        { name: 'tab', label: words.NEW_TAB, kind: 'text', optional: true, placeholder: words.NEW_TAB_HINT },
        { name: 'folder', label: words.NEW_FOLDER, kind: 'text', optional: true, placeholder: words.NEW_FOLDER_HINT },
      ],
    };
  }

  // The form sent: to the direct chat (where: null) or where /new came from.
  async function showNewForm(where = null) {
    const form = await newForm();
    await chat.showForm(where, form);
    log(`new-terminal form ${form.id} sent`);
  }

  // What the form says, made a terminal: {error} when something is missing or wrong (the
  // form stays, to fix), else what to start. A pick not sent back is its first option
  // (Feishu may leave out one never touched).
  function planOf(kept, form) {
    const text = (name) => String(form[name] ?? kept.initial[name] ?? '').trim();
    const pick = text('space');
    const agent = AGENTS.find((a) => a.id === text('agent')) || AGENTS[0];
    let place;
    if (/^s\d+$/.test(pick) && kept.spaces[pick.slice(1)]) {
      const s = kept.spaces[pick.slice(1)];
      place = { session: s.session, machine: s.machine, space: s.space, spaceId: s.spaceId, folder: s.folder, tabs: s.tabs };
    } else if (/^n\d+$/.test(pick) && kept.places[pick.slice(1)]) {
      const name = text('name');
      if (!name) return { error: words.NEW_NEEDS_NAME };
      const p = kept.places[pick.slice(1)];
      place = { session: p.session, machine: p.machine, space: name, spaceId: null, folder: null, tabs: [] };
    } else {
      return { error: words.NEW_NEEDS_SPACE };
    }
    if (/ \/ |\n/.test(place.space) || / \/ |\n/.test(text('tab'))) return { error: words.NEW_NO_SLASH };
    // no tab name: the agent's, numbered past the ones the space has
    let tab = text('tab');
    if (!tab) {
      tab = agent.id;
      for (let n = 2; place.tabs.includes(tab); n += 1) tab = `${agent.id}-${n}`;
    }
    return { ...place, tab, folder: text('folder') || place.folder, line: agent.line };
  }

  // The form sent back (onAction, value {form: id}): checked at once, so a mistake is a
  // toast on the form as it is; then started, the card saying so, then what came of it
  // (hc may take longer than a tap's answer may wait).
  async function submit({ value, message, form = {} }) {
    const kept = forms.get(value.form);
    if (!kept) return { toast: { type: 'warning', text: words.NEW_FORM_OLD } };
    const plan = planOf(kept, form);
    if (plan.error) return { toast: { type: 'error', text: plan.error } };
    forms.delete(value.form);
    const where = `${plan.space} / ${plan.tab}${plan.machine ? ` · ${plan.machine}` : ''}`;
    log(`new terminal from the form: ${plan.session}${plan.machine ? ` on ${plan.machine}` : ''}, ${where}, ${plan.line || 'shell'}`);
    start(plan).then(
      (said) => chat.editCard(message, { title: words.NEW_STARTED, tone: 'good', markdown: said }),
      (err) => {
        logError(`new terminal ${where}: ${err.message}`);
        return chat.editCard(message, { title: words.NEW_FAILED, tone: 'bad', markdown: words.notStartedWhy(plainError(err)) });
      },
    ).catch((err) => logError(`new-terminal card: ${err.message}`));
    return { toast: { type: 'info', text: words.NEW_STARTING }, card: { kind: 'look', look: { title: words.NEW_STARTING, tone: 'working', markdown: where } } };
  }

  // A tap on the form's buttons, or the overview's "new terminal"
  async function onFormAction({ value, message, form, where }) {
    // the form goes on its own: a tap is answered at once (Feishu waits 3 s at most)
    if (value.open === 'new') {
      showNewForm(where || null).catch((err) => logError(`new-terminal form: ${err.message}`));
      return { toast: { type: 'info', text: words.NEW_FORM_SENT } };
    }
    return submit({ value, message, form });
  }

  return { newFromWords: fromWords, showNewForm, onFormAction };
}
