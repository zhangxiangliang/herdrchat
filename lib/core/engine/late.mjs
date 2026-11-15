// The core's parts call each other both ways (a turn's end closes a dialog's card, a
// dialog's card goes to a room), so each is made with the shared `ctx` and finds there a
// part made after it only when it runs: late(ctx, names) gives one function for each name
// that calls ctx[name] then.
export const late = (ctx, names) => Object.fromEntries(names.map((name) => [name, (...args) => ctx[name](...args)]));
