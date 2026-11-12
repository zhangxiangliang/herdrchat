// One terminal can be seen several ways: in its own hc session, and through every
// followed session that is connected to that session's core as a machine (under any
// name). What a terminal is comes from hc, never from names: the id of the core it runs
// on (`hc server status` for a session's own core, `hc machine ls` for the cores it is
// connected to) plus its tN on that core.
//
// The bot follows each terminal through one view: its own session when that session is
// followed, else the first followed session (config order) with a live connection to
// its core.
import { machineOf } from './hc.mjs';

// cores: Map session -> { self: core id, links: [{ name, id, state }] }
export function coreViews(sessions, cores) {
  // the core a view's terminal runs on, or null when it cannot be told (unknown session
  // or machine, or a machine reached through another machine)
  function coreOf(session, address) {
    const info = cores.get(session);
    const machine = machineOf(address);
    if (!info || machine?.includes('/')) return null;
    if (!machine) return info.self || null;
    return info.links.find((l) => l.name === machine)?.id || null;
  }

  // "<core id>|tN": the same for every view of one terminal
  function identity(session, address) {
    const core = coreOf(session, address);
    return core ? `${core}|${address.slice(address.lastIndexOf('/') + 1)}` : null;
  }

  // the view that follows a core's terminals: { session, machine } (machine null: directly)
  function ownerOf(core) {
    const direct = sessions.find((s) => cores.get(s)?.self === core);
    if (direct) return { session: direct, machine: null };
    for (const session of sessions) {
      const link = cores.get(session)?.links.find((l) => l.id === core && l.state === 'connected');
      if (link) return { session, machine: link.name };
    }
    return null;
  }

  // true or false, or null when the cores cannot tell (the caller falls back)
  function owns(session, address) {
    const core = coreOf(session, address);
    if (!core) return null;
    const owner = ownerOf(core);
    return !!owner && owner.session === session && owner.machine === machineOf(address);
  }

  return { identity, owns };
}
