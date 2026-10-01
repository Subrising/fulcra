// U5-D06: the controller's refusal prefixes ("Orca native admission refused", "Orca native permission refused") are a
// MACHINE signal: the Book receiver and questions.mjs branch on them and they are stored with delivery rows, so they are
// not renamed at the source. This rewrites them only where a person reads them. Everything else passes through as is.
const REFUSAL = /^(?:Request failed:\s*)?Orca native (admission|permission) refused(?::\s*|\s+)?/;
export function plainReason(text) {
  if (typeof text !== 'string') return text;
  const m = REFUSAL.exec(text);
  if (!m) return text;
  const rest = text.slice(m[0].length).trim();
  const what = m[1] === 'permission' ? "Fulcra's safety check did not allow this permission" : "Fulcra's safety check did not let this message through";
  return rest ? `${what}: ${rest}` : `${what}.`;
}
