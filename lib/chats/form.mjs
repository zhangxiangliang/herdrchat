// The new-terminal form (lib/core/engine/create.mjs), the same for every chat app: which
// fields and options apply to what is picked so far. A field or an option with `when:
// {field, values}` applies once that field is one of those values, and while it is not
// picked yet.
export const holds = (when, values) => !when || values[when.field] === undefined || when.values.includes(values[when.field]);

// What is picked: each pick's initial option, then what was picked on top of it.
export const pickedOf = (form, picks = {}) => ({ ...Object.fromEntries(form.fields.filter((f) => f.kind === 'pick' && f.initial !== undefined).map((f) => [f.name, f.initial])), ...picks });

// A pick's options that apply to what is picked, each with its index in the field's
// options (what a button carries).
export const optionsOf = (field, values) => field.options.map((o, i) => ({ ...o, i })).filter((o) => holds(o.when, values));
