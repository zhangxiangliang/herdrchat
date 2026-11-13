// Follows `hc events --json` for one hc session (local and connected machines).
// Format (herdr-core schema/README.md, "Events"): the first line is a snapshot
// {seq, terminals}; then JSON-RPC notifications: `event` {seq, type, terminal, data},
// `heartbeat` {seq}, `missed` {seq, terminals} (a fresh snapshot).
// A `turn` event fires each time a program's status leaves `working`; its `state`
// is the word it ended on: done/idle/error (the turn is over) or blocked (it needs a person).
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const RESTART_MS = 3000;

export function followEvents(session, { onTurn, onChange = () => {}, onSnapshot = () => {}, log = console.log }) {
  const terminals = new Map(); // address -> Terminal record, kept current from events
  let seq = 0;

  const snapshot = (list, at) => {
    terminals.clear();
    for (const t of list || []) terminals.set(t.address, t);
    seq = at;
    onSnapshot([...terminals.values()]);
  };

  const apply = ({ seq: at, type, terminal, data }) => {
    if (at <= seq) return; // already covered by a newer snapshot
    seq = at;
    const record = terminals.get(terminal);
    switch (type) {
      case 'created':
      case 'restarted':
        terminals.set(terminal, data);
        break;
      case 'removed':
        terminals.delete(terminal);
        break;
      case 'finished':
        if (record) Object.assign(record, data, { state: 'finished', foreground: null });
        break;
      case 'lost':
        if (record) Object.assign(record, data, { pid: null, foreground: null });
        break;
      case 'status':
        if (record) Object.assign(record, data);
        break;
      case 'labels':
        if (data.record) terminals.set(terminal, data.record);
        else if (record) record.labels = data.labels;
        break;
      case 'foreground':
        if (record) record.foreground = data;
        break;
      case 'turn':
        if (record) record.turn = data.turn;
        onTurn({ address: terminal, state: data.state, record: terminals.get(terminal) });
        break;
      default:
        if (record && data && typeof data === 'object') Object.assign(record, data); // title, size, keep
    }
    if (type !== 'turn') onChange({ type, address: terminal, record: terminals.get(terminal) || record, data });
  };

  const start = () => {
    const child = spawn('hc', ['events', '--json'], { env: { ...process.env, HC_SESSION: session } });
    let first = true;
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      if (!line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        log(`[events] unreadable line: ${line.slice(0, 120)}`);
        return;
      }
      if (first) {
        first = false;
        snapshot(msg.terminals, msg.seq);
        log(`[events] following hc session "${session}": ${terminals.size} terminals`);
        return;
      }
      try {
        if (msg.method === 'event') apply(msg.params);
        else if (msg.method === 'missed') snapshot(msg.params.terminals, msg.params.seq);
      } catch (err) {
        log(`[events] ${err.stack || err.message}`);
      }
    });
    child.stderr.on('data', (d) => log(`[events] ${String(d).trim()}`));
    child.on('exit', (code) => {
      log(`[events] hc events ended (${code}); restarting in ${RESTART_MS / 1000} s`);
      setTimeout(start, RESTART_MS);
    });
  };

  start();
  return { terminals };
}
