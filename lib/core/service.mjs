// herdrchat as a service of the system, so it starts at login and comes back by itself
// after a crash, whatever happens to the hc cores: a launchd LaunchAgent on macOS, a
// systemd user unit on Linux. `herdrchat install` makes it; start, stop and status then
// go through it. Without it the bot runs in an hc terminal (`herdrchat start`), which
// ends when that hc core stops.
//
// The service runs node and bin/herdrchat.mjs by their full paths, with only the
// variables listed in `env` (no agent's variables come along): a node upgrade that moves
// node needs `herdrchat install` again, which status says.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const THROTTLE_S = 10; // launchd: at most one start in this many seconds
const RESTART_S = 5; // systemd: wait before starting again

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function launchdPlist({ label, node, script, root, env, out }) {
  const vars = Object.entries(env).map(([k, v]) => `      <key>${xml(k)}</key>\n      <string>${xml(v)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xml(label)}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${xml(node)}</string>
      <string>${xml(script)}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${xml(root)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${vars}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>${THROTTLE_S}</integer>
    <key>StandardOutPath</key>
    <string>${xml(out)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(out)}</string>
  </dict>
</plist>
`;
}

const unitQuote = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export function systemdUnit({ profile, node, script, root, env, out }) {
  return `[Unit]
Description=herdrchat (profile ${profile}): herdr-app tabs in a chat app
After=network-online.target

[Service]
ExecStart=${unitQuote(node)} ${unitQuote(script)}
WorkingDirectory=${root}
${Object.entries(env).map(([k, v]) => `Environment=${unitQuote(`${k}=${v}`)}`).join('\n')}
Restart=always
RestartSec=${RESTART_S}
StandardOutput=append:${out}
StandardError=append:${out}

[Install]
WantedBy=default.target
`;
}

const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// {kind, name, file, content, write, remove, installed, load, unload, restart, state,
// nodeGone}, or null on a system with neither launchd nor systemd.
export function serviceOf({ profile, root, node, env, stateDir, platform = process.platform, home = os.homedir() }) {
  const script = path.join(root, 'bin', 'herdrchat.mjs');
  const out = path.join(stateDir, 'logs', 'service.out.log');
  const common = { profile, node, script, root, env, out };
  if (platform === 'darwin') {
    const label = `app.herdrchat.${profile}`;
    const file = path.join(home, 'Library', 'LaunchAgents', `${label}.plist`);
    const target = `gui/${process.getuid()}/${label}`;
    return {
      kind: 'launchd',
      name: label,
      file,
      content: launchdPlist({ ...common, label }),
      loaded() {
        try {
          run('launchctl', ['print', target]);
          return true;
        } catch {
          return false;
        }
      },
      load() { run('launchctl', ['bootstrap', `gui/${process.getuid()}`, file]); },
      unload() { try { run('launchctl', ['bootout', target]); } catch { /* not loaded */ } },
      restart() { run('launchctl', ['kickstart', '-k', target]); },
      // {running, pid}
      state() {
        try {
          const text = run('launchctl', ['print', target]);
          return { running: /\bstate = running\b/.test(text), pid: Number(text.match(/\bpid = (\d+)/)?.[1]) || null };
        } catch {
          return { running: false, pid: null };
        }
      },
      ...files(file, out),
    };
  }
  if (platform === 'linux') {
    const unit = `herdrchat-${profile}.service`;
    const file = path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'systemd', 'user', unit);
    const ctl = (...a) => run('systemctl', ['--user', ...a]);
    return {
      kind: 'systemd',
      name: unit,
      file,
      content: systemdUnit(common),
      loaded() {
        try {
          return ctl('is-enabled', unit).trim() === 'enabled';
        } catch {
          return false;
        }
      },
      load() { ctl('daemon-reload'); ctl('enable', '--now', unit); },
      unload() { try { ctl('disable', '--now', unit); } catch { /* not loaded */ } },
      restart() { ctl('restart', unit); },
      state() {
        try {
          const pid = Number(ctl('show', '-p', 'MainPID', '--value', unit).trim()) || null;
          return { running: ctl('is-active', unit).trim() === 'active', pid };
        } catch {
          return { running: false, pid: null };
        }
      },
      ...files(file, out),
    };
  }
  return null;
}

function files(file, out) {
  return {
    installed: () => fs.existsSync(file),
    write(content) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, content, { mode: 0o600 });
    },
    remove() { fs.rmSync(file, { force: true }); },
    // the node the installed service runs, when it is gone (a node upgrade moved it)
    nodeGone() {
      if (!fs.existsSync(file)) return null;
      const text = fs.readFileSync(file, 'utf8');
      const node = text.match(/<string>([^<]*node[^<]*)<\/string>/)?.[1] || text.match(/^ExecStart="([^"]+)"/m)?.[1];
      return node && !fs.existsSync(node) ? node : null;
    },
  };
}
