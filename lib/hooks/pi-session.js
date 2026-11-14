// herdrchat's Pi extension (put in ~/.pi/agent/extensions/ by `herdrchat hooks install pi`).
// Pi names the session file it writes only to itself, so two pi in one folder could not be
// told apart from outside. Each time a session starts (at startup, /new, /resume, /fork)
// this labels the hc terminal pi runs in with "<pi's pid> <its session file>", and
// herdrchat reads that terminal's log from it. Outside hc (no HC_TERMINAL_ID) it does
// nothing; an ephemeral session (--no-session) has no file to name.
export default function (pi) {
  pi.on('session_start', async (_event, ctx) => {
    const terminal = process.env.HC_TERMINAL_ID;
    if (!terminal) return;
    const file = ctx.sessionManager.getSessionFile() || '';
    try {
      await pi.exec('hc', ['label', terminal, `herdrchat.pi-session=${process.pid} ${file}`], { timeout: 5000 });
    } catch {
      // no hc here: herdrchat falls back to the newest log in the folder
    }
  });
}
