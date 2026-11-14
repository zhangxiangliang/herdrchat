// Small helpers for the shell commands herdrchat runs (here or through `hc exec --on`).

// One argument for sh, as it is: in single quotes, with its own single quotes kept.
export const shellQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

// "[[dd-]hh:]mm:ss", as ps prints how long a process has run -> seconds
export function seconds(etime) {
  const t = String(etime).trim();
  const [days, rest] = t.includes('-') ? t.split('-') : ['0', t];
  const parts = rest.split(':').map(Number);
  while (parts.length < 3) parts.unshift(0);
  return Number(days) * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2];
}
