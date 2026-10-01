// U5-D01: the chat-channel title of an inbox item, kept BESIDE the item, never on it. The owned channel checks every
// reply with the protocol's canonical bound (distribution-child.mjs send -> boundedJson), which refuses any hidden
// (non-enumerable) field, so a hidden property on an inbox item failed every inbox read that had a held message
// ("Management unavailable" in the app). JSON.stringify skips hidden fields, which is why the operator socket still read it.
const titles = new WeakMap();
export const setChannelTitle = (item, title) => { titles.set(item, title); return item; };
export const channelTitleOf = item => titles.get(item);
