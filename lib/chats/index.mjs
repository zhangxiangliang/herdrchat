// The chat apps herdrchat can mirror into; HERDRCHAT_CHAT in config.env picks one per
// profile (feishu by default). To add one, see lib/chats/contract.mjs and
// docs/architecture.md.
import * as feishu from './feishu/index.mjs';
import { checkChat } from './contract.mjs';

const CHATS = { feishu };

export const chatNames = () => Object.keys(CHATS);

export function chatModule(name) {
  const mod = CHATS[name];
  if (!mod) throw new Error(`HERDRCHAT_CHAT "${name}": known apps are ${chatNames().join(', ')}`);
  return mod;
}

export function createChat(name, ctx) {
  return checkChat(chatModule(name).create(ctx));
}
