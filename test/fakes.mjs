// Stand-ins for what the core talks to, so its logic is tested without Feishu, hc or an
// agent: a chat app that records every call, an hc whose events a test sends, a reader
// whose items a test queues, and state.json in memory.
import { CHAT_MEMBERS } from '../lib/chats/contract.mjs';

export function fakeStore() {
  let state = { chats: {} };
  return { read: () => JSON.parse(JSON.stringify(state)), write: (s) => { state = JSON.parse(JSON.stringify(s)); } };
}

export function fakeChat() {
  const calls = [];
  let n = 0;
  const pins = new Set();
  const record = (name, ...args) => calls.push({ name, args });
  const id = (p) => `${p}${(n += 1)}`;
  const chat = {
    name: 'fake',
    calls,
    of: (name) => calls.filter((c) => c.name === name),
    ready: () => true,
    help: [],
    roomWord: 'room',
    liveBytes: 20000,
    split: (text) => [text],
    start: (handlers) => { chat.handlers = handlers; record('start'); },
    command: async () => false,
    openRoom: async (look) => { const room = id('room'); record('openRoom', look, room); return room; },
    renameRoom: async (...a) => record('renameRoom', ...a),
    placeRoom: async (...a) => record('placeRoom', ...a),
    endRoom: async (...a) => record('endRoom', ...a),
    reviveRoom: async (...a) => record('reviveRoom', ...a),
    post: async (room, markdown) => { record('post', room, markdown); return id('m'); },
    reply: async (where, markdown) => { record('reply', where, markdown); return id('m'); },
    postCard: async (room, look) => { record('postCard', room, look); return id('m'); },
    editCard: async (...a) => record('editCard', ...a),
    postDialog: async (room, dialog, value) => { const m = id('m'); record('postDialog', room, dialog, value, m); return m; },
    closeDialog: async (...a) => record('closeDialog', ...a),
    pin: async (k, room) => { pins.add(k); record('pin', k, room); },
    unpin: async (k) => { pins.delete(k); record('unpin', k); },
    pinned: () => [...pins],
    ring: async (...a) => record('ring', ...a),
    markWorking: async (message) => { record('markWorking', message); return `r-${message}`; },
    markDone: async (...a) => record('markDone', ...a),
    image: async () => '![image](img)',
    postFile: async (room, file) => { record('postFile', room, file); return id('m'); },
    postFolded: async (room, look) => { record('postFolded', room, look); return id('m'); },
    foldedBytes: 3500,
    download: async (...a) => record('download', ...a),
    tellOwner: async (...a) => record('tellOwner', ...a),
    showOverview: async (rows) => record('showOverview', rows),
  };
  for (const m of Object.keys(CHAT_MEMBERS)) if (!(m in chat)) throw new Error(`fakeChat misses ${m}`);
  return chat;
}

// One session per name; a test sends its snapshot and events. `screens` holds what each
// terminal shows; `sent` and `pressed` what the core typed.
export function fakeHc() {
  const sessions = new Map();
  const screens = new Map();
  const sent = [];
  const pressed = [];
  const hc = {
    sent,
    pressed,
    screens,
    followEvents(session, handlers) {
      const view = { terminals: new Map() };
      sessions.set(session, { view, handlers });
      return view;
    },
    cores: async (session) => ({ self: `core-${session}`, links: [] }),
    machines: async () => [],
    getTerminal: async (session, address) => sessions.get(session).view.terminals.get(address),
    screenTail: async (session, address) => screens.get(`${session}|${address}`) || '',
    send: async (session, address, text, opts) => { sent.push({ session, address, text, opts }); },
    keys: async (session, address, names) => { pressed.push({ session, address, names }); },
    labelled: [],
    // as hc does: the labels change (an empty value takes one away), and a labels event follows
    label: async (session, address, labels) => {
      hc.labelled.push({ session, address, labels });
      const record = sessions.get(session).view.terminals.get(address);
      const next = { ...record.labels };
      for (const [k, v] of Object.entries(labels)) { if (v) next[k] = v; else delete next[k]; }
      record.labels = next;
      sessions.get(session).handlers.onChange({ type: 'labels', address, record, data: { labels: next } });
    },
    put: async (session, address, file) => `/remote/${file.split('/').pop()}`,
    named: [],
    run: async (session, opts) => { hc.ran = opts; return JSON.stringify({ address: 't99' }); },
    nameTab: async (tabId, name) => { hc.named.push({ tabId, name }); return true; },
    kill: async () => {},
    // test side
    snapshot(session, list) {
      const s = sessions.get(session);
      s.view.terminals.clear();
      for (const t of list) s.view.terminals.set(t.address, t);
      s.handlers.onSnapshot(list);
    },
    change(session, type, record, data) {
      const s = sessions.get(session);
      if (type === 'created') s.view.terminals.set(record.address, record);
      if (type === 'finished') Object.assign(s.view.terminals.get(record.address), { state: 'finished', foreground: null });
      s.handlers.onChange({ type, address: record.address, record: s.view.terminals.get(record.address), data });
    },
    turn(session, address, state) {
      const s = sessions.get(session);
      s.handlers.onTurn({ address, state, record: s.view.terminals.get(address) });
    },
  };
  return hc;
}

// A terminal herdr-app shows: in `space`, tab `tab` (its id `tabId`), running `program`.
export function terminal(address, { space = 'proj', tab = 'master', tabId = 'tb1', program = 'zsh', agent = false, state = 'idle' } = {}) {
  return {
    address,
    state: 'live',
    labels: { where: `${space} / ${tab}`, 'herdr.tab': tabId, 'herdr.space': 'sp1' },
    foreground: { name: program, argv: [program] },
    status: agent ? { app: 'fake-agent', state } : null,
  };
}

// An agent reader over a log a test writes per terminal; like a real one, it returns
// what is after the cursor and not seen.
export function fakeReaders() {
  const logs = new Map();
  const reader = {
    app: 'fake-agent',
    processes: ['fake'],
    after: async (session, address, cursor) => ({ items: (logs.get(address) || []).filter((it) => it.at > cursor.at && !cursor.seen.some(([id]) => id === it.id)), file: 'log' }),
    rest: async () => [],
  };
  return {
    reader, // a test may give it `dialog` and `answer`, as an agent with its own API
    queue: (address, items) => logs.set(address, [...(logs.get(address) || []), ...items]),
    readers: {
      readerFor: (app) => (app === reader.app ? reader : null),
      agentOf: (record) => (record?.status?.app === reader.app && reader.processes.includes(record.foreground?.name) ? reader : null),
    },
  };
}
