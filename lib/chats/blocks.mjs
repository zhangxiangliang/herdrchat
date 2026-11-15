// What the core posts (post, reply): a list of blocks, each shown by the chat app in its
// own way and escaped by it, so what a block holds never breaks the post around it.
//   {kind: 'text', markdown}   words in the core's markdown (contract.mjs): what an agent
//                              wrote, what the bot says
//   {kind: 'screen', text}     a terminal's screen, shown as it is (fixed width)
// Blocks follow each other with a blank line between them. A body that is a string is
// one text block (the core still sends some so).
export const blocksOf = (body) => (Array.isArray(body) ? body : body ? [{ kind: 'text', markdown: String(body) }] : []);
