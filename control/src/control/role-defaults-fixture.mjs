// Seating a project orchestrator now confers a default prime<->project channel and a default session
// allowance (PROPOSAL.md §1 and §2, approved 2026-09-23).
//
// Fixtures that exercise the OPERATOR approval path seat both roles and then open a channel themselves.
// The default legitimately collides with that: one open channel per seat pair is a rule the default obeys
// exactly like an operator approval does, so the second open is refused. Closing the default first leaves
// the pair free, and keeps those tests testing operator approval rather than incidentally testing the
// default -- which has its own tests in seating-defaults.test.mjs.
//
// Deliberately NOT a way to disable the default. It closes what seating opened, through the ordinary
// operator close path, and returns how many it closed so a fixture cannot silently close nothing and go on
// believing it did.
export function closeSeatingDefaults(control) {
  const open = control.channels.status().channels.filter(c => c.state === 'open' && c.conferredBy === 'seating');
  for (const c of open) control.channels.close({ channelId: c.channelId, note: 'Fixture closes the seating default to exercise operator approval' });
  return open.length;
}
// The other half: a seat that seating has already funded is not the "holds no allowance" precondition some
// tests need. This spends nothing and moves no revision -- it writes the allowance an operator would write.
export function clearSeatingAllowance(control, seat, expectedRevision) {
  return control.roleSessions.setAllowance({ role: 'project-orchestrator', seat, expectedRevision, maxSessions: 0,
    note: 'Fixture clears the seating default to exercise the unfunded-seat refusal' });
}
