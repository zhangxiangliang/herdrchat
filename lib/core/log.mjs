// The bot's log, kept on disk so a problem can be looked into after a restart: every line
// goes to stdout and to logs/<YYYY-MM-DD>.log in the state folder (KEEP_DAYS kept), as
// "<time> <LEVEL> <text>". `capture()` sends console output (the SDK, the event stream)
// through it too, and writes an uncaught error with its stack before the process exits
// (`herdrchat start` keeps it running); `onCrash` gets a few seconds first, to say so
// where you will see it. No token or secret is ever passed to it.
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';

const KEEP_DAYS = 14;

// A log file per local day (what "today" means to you); the time on each line is UTC.
export const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const CRASH_WAIT_MS = 3000;

export function createLog(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const out = { log: console.log.bind(console), error: console.error.bind(console) };
  let pruned = '';

  const prune = (today) => {
    if (pruned === today) return;
    pruned = today;
    const oldest = localDay(new Date(Date.now() - KEEP_DAYS * 86400 * 1000));
    for (const f of fs.readdirSync(dir)) {
      if (/^\d{4}-\d{2}-\d{2}\.log$/.test(f) && f.slice(0, 10) < oldest) fs.rmSync(path.join(dir, f), { force: true });
    }
  };

  const write = (level, args) => {
    const now = new Date().toISOString();
    // one entry per line: a newline in a message (your text) shows as ⏎; a stack keeps its lines
    const text = args.map((a) => (typeof a === 'string' ? a.replace(/\r?\n/g, ' ⏎ ') : a instanceof Error ? a.stack || a.message : util.inspect(a, { depth: 4, breakLength: Infinity }))).join(' ');
    const line = `${now} ${level} ${text}`;
    (level === 'ERROR' ? out.error : out.log)(line);
    try {
      fs.appendFileSync(path.join(dir, `${localDay()}.log`), `${line}\n`, { mode: 0o600 }); // it quotes your messages
      prune(localDay());
    } catch {
      // the disk is the last resort; stdout has the line
    }
  };

  const log = {
    info: (...args) => write('INFO', args),
    warn: (...args) => write('WARN', args),
    error: (...args) => write('ERROR', args),
  };

  log.capture = ({ onCrash } = {}) => {
    // a library that prints its errors as plain log lines ("[error]: ...", as the Feishu
    // SDK does) gets them logged as WARN, so `herdrchat logs --errors` finds them
    const levelOf = (args) => (/^\[(error|warn)\]/i.test(String(args[0] ?? '')) ? 'WARN' : 'INFO');
    console.log = (...args) => write(levelOf(args), args);
    console.info = console.log;
    console.warn = (...args) => write('WARN', args);
    console.error = (...args) => write('ERROR', args);
    process.on('uncaughtException', (err) => {
      write('ERROR', ['uncaught:', err]);
      const said = onCrash ? Promise.resolve().then(() => onCrash(err)).catch(() => {}) : Promise.resolve();
      Promise.race([said, new Promise((r) => setTimeout(r, CRASH_WAIT_MS))]).finally(() => process.exit(1));
    });
    process.on('unhandledRejection', (err) => write('ERROR', ['unhandled rejection:', err]));
  };

  return log;
}
