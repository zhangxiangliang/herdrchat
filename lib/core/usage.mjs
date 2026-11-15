// /usage in the direct chat: every account the agents are signed in to, on this machine
// and on each machine a session is connected to, with its limits (readers/index.mjs,
// usage). A machine that is this one, or one already asked (another hc core on the same
// host, with the same home), is asked once; an account found on several machines (the
// same login, or one GLM key in OpenCode and Pi) is said once, with where it was found.
import os from 'node:os';

const shortHost = (h) => String(h || '').trim().split('.')[0];

// machines(session) -> [{name, state}]; shell(session, machine, script) -> its output;
// usageOn(session, machine) -> accounts. -> {accounts, unreached: machine names, places}
export async function accountsEverywhere({ sessions, machines, shell, usageOn }) {
  const places = [{ session: sessions[0], machine: undefined, name: shortHost(os.hostname()), where: `${os.hostname()}\n${os.homedir()}` }];
  const unreached = [];
  const named = new Set();
  for (const session of sessions) {
    for (const m of await machines(session).catch(() => [])) {
      if (named.has(m.name)) continue;
      named.add(m.name);
      if (m.state === 'connected') places.push({ session, machine: m.name, name: m.name });
      else unreached.push(m.name);
    }
  }
  await Promise.all(places.filter((p) => p.machine).map(async (p) => {
    p.where = String(await shell(p.session, p.machine, 'hostname; printf "%s\\n" "$HOME"').catch(() => '')).trim();
  }));
  const asked = [];
  for (const p of places) {
    if (!p.where) unreached.push(p.name);
    else if (!asked.some((a) => a.where === p.where)) asked.push(p);
  }
  const found = await Promise.all(asked.map((p) => usageOn(p.session, p.machine).catch(() => []).then((list) => list.map((a) => ({ ...a, on: [p.name] })))));
  const byId = new Map();
  for (const a of found.flat()) {
    const had = byId.get(a.id);
    if (!had) byId.set(a.id, a);
    else {
      had.on = [...new Set([...had.on, ...a.on])];
      if (a.via) had.via = [...new Set([...(had.via || []), ...a.via])];
    }
  }
  // each agent's accounts together, in the order the agents were first found
  const apps = [...new Set([...byId.values()].map((a) => a.app))];
  const accounts = apps.flatMap((app) => [...byId.values()].filter((a) => a.app === app));
  return { accounts, unreached, places: asked.length };
}
