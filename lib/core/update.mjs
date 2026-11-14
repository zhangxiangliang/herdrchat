// Updating herdrchat: from npm, the way it was installed (`npm install -g herdrchat`).
//   herdrchat update [version]   in a terminal; the latest when no version is named, an
//                                older one to go back to it
//   the "Update" button          on the card the bot sends in the direct chat when npm has
//                                a newer version (once per version, looked for daily)
// Both install it with npm, refresh the copy of the hook the agents run (when it is in),
// and update the skill (when it is installed). Nothing restarts here: every running bot
// sees its code on disk change and starts again by itself (watchCode), whatever installed
// it. One that nothing would start again (run by hand) says so instead of stopping.
// A checkout (a git clone) is never updated: it says to pull.
import fs from 'node:fs';
import path from 'node:path';

export const PACKAGE = 'herdrchat';
const NPM_MS = 5 * 60 * 1000;

export const versionAt = (root) => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

// "1.10.2" vs "1.11.0": < 0, 0, > 0 (pre-release tags are not used here)
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}
export const isVersion = (v) => /^\d+\.\d+\.\d+$/.test(String(v));

// A command, its output: {ok, out}. `run` is this, or a test's.
export async function runCommand(cmd, args, { timeoutMs = NPM_MS } = {}) {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve) => execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout || ''}${stderr || ''}`.trim() })));
}

// How this copy was installed: 'checkout' (a git clone: pull to update), 'npm' (npm's
// global folder: npm updates it), or 'other' (npx, a project's node_modules: by hand).
export async function installKind(root, run = runCommand) {
  if (fs.existsSync(path.join(root, '.git'))) return 'checkout';
  const { ok, out } = await run('npm', ['root', '-g'], { timeoutMs: 30000 });
  if (!ok || !out) return 'other';
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  return real(root) === real(path.join(out.split('\n').pop().trim(), PACKAGE)) ? 'npm' : 'other';
}

// The newest version on npm (through npm, so a registry the user set is used), or null.
export async function latestVersion(run = runCommand) {
  const { ok, out } = await run('npm', ['view', PACKAGE, 'version'], { timeoutMs: 60000 });
  const v = out.split('\n').pop().trim();
  return ok && isVersion(v) ? v : null;
}

// What to do instead, for a copy npm did not install.
export function notByNpm(kind, root) {
  return kind === 'checkout'
    ? `This herdrchat runs from a git checkout (${root}): update it with git pull. Running bots start again by themselves once the version in its package.json changes.`
    : `This herdrchat was not installed with npm install -g (${root}), so it is not updated from here. Update it the way it was installed.`;
}

// Installs `version` ('latest' or x.y.z), then refreshes the hook and the skill.
// -> {ok, version (installed), changed (another version is installed now), lines (for the user)}
export async function update({ version = 'latest', root, run = runCommand, refreshHook = () => null } = {}) {
  const kind = await installKind(root, run);
  if (kind !== 'npm') return { ok: false, lines: [notByNpm(kind, root)] };
  const from = versionAt(root);
  const target = version === 'latest' ? await latestVersion(run) : version;
  if (!target || !isVersion(target)) return { ok: false, lines: [version === 'latest' ? 'Could not ask npm for the latest version (npm view herdrchat version failed).' : `"${version}" is not a version (x.y.z).`] };
  if (target === from) return { ok: true, version: from, changed: false, lines: [`herdrchat ${from} is already installed.`] };
  const installed = await run('npm', ['install', '-g', `${PACKAGE}@${target}`]);
  if (!installed.ok) return { ok: false, lines: [`npm install -g ${PACKAGE}@${target} failed:`, installed.out.split('\n').slice(-8).join('\n')] };
  const now = versionAt(root);
  const lines = [`herdrchat ${from} → ${now}${compareVersions(now, from) < 0 ? ' (back to an older one)' : ''}.`];
  const hook = refreshHook();
  if (hook) lines.push(hook);
  lines.push(await updateSkill(run));
  return { ok: now === target, version: now, changed: now !== from, lines };
}

// The skill, when `npx skills` has it installed for this user.
export async function updateSkill(run = runCommand) {
  const listed = await run('npx', ['-y', 'skills', 'ls', '-g'], { timeoutMs: 120000 });
  if (!listed.ok || !/\bherdrchat\b/.test(listed.out)) return 'The skill is not installed with npx skills; nothing to update there.';
  const done = await run('npx', ['-y', 'skills', 'update', PACKAGE, '-g', '-y'], { timeoutMs: 120000 });
  return done.ok ? 'The skill is updated.' : `The skill was not updated (npx skills update ${PACKAGE} -g): ${done.out.split('\n').pop()}`;
}

// Whether something starts this bot again when it stops: its service (launchd names the
// job in XPC_SERVICE_NAME, systemd sets INVOCATION_ID) or the loop `herdrchat start` runs
// it in (HERDRCHAT_KEPT).
export const keptRunning = (env = process.env) => Boolean(env.HERDRCHAT_KEPT || String(env.XPC_SERVICE_NAME || '').startsWith('app.herdrchat.') || env.INVOCATION_ID);
