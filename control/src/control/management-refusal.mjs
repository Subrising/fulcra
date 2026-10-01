// Only explicit controller preconditions may carry a public refusal message.
// Unclassified failures after dispatch stay uncertain, regardless of their text/code.
const refusals = new WeakSet();
export function managementRefusal(message) {
 const error = new Error(message); refusals.add(error); return error;
}
export function managementReplyFailure(error, dispatched, read) {
 if (refusals.has(error)) return {code:'invalid',message:error.message.slice(0,2000)};
 return {code:dispatched ? (read ? 'unavailable' : 'uncertain') : (['invalid','expired','unavailable','unauthorised'].includes(error?.code) ? error.code : 'invalid')};
}
// L37: a read that fails after dispatch reaches the app only as "Management unavailable" (the message is dropped above, by
// design: it may carry private details). Log what failed without the message: the error class and the first stack frame
// (a source location), never text that could quote journal rows, inputs or secrets.
export function describeFailure(error) {
 const name = typeof error?.name === 'string' && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : 'Error';
 const frame = String(error?.stack ?? '').split('\n').map(l => l.trim()).find(l => l.startsWith('at ')) ?? '';
 const where = /\(([^()]+:\d+:\d+)\)$/.exec(frame)?.[1] ?? /^at ([^\s()]+:\d+:\d+)$/.exec(frame)?.[1] ?? 'unknown location';
 return `${name} at ${where.slice(-200)}`;
}
