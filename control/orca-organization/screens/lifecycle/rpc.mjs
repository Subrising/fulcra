const GB = 1073741824;
const job = { id: 'fixture-one', label: 'Example website update', state: 'archived', pr: 'merged', eligible: true, blockers: [], worktrees: [], remove: ['checkout', 'dist'], keep: ['REPORT.md'], bytes: 4.2 * GB, sizes: { worktrees: GB, nodeModules: 3 * GB, buildOutput: .2 * GB, kept: 4096 } };
export function useContract(contract) {
  return async input => {
    window.__calls.push({ name: contract.name, input });
    if (contract.name.endsWith('preview') && !input.operationId) return { pending: true, operationId: '00000000-0000-4000-8000-000000000000' };
    if (contract.name.endsWith('preview') && new URLSearchParams(location.search).get('scroll') === '1') setTimeout(() => { const pane = document.querySelector('#root > div'); pane.scrollTop = pane.scrollHeight; }, 100);
    if (contract.name.endsWith('preview')) return { pending: false, operationId: '00000000-0000-4000-8000-000000000000', value: { version: 1, observedAt: new Date().toISOString(), partial: false, planId: '00000000-0000-4000-8000-000000000000', retentionDays: 7, jobs: [job, { ...job, id: 'fixture-two', label: 'Example mobile update', state: 'idle', pr: 'open', eligible: false, bytes: 0, blockers: ['2 unpushed commits'] }], candidates: [{ name: 'candidate-example', bytes: GB, ageDays: 12 }] } };
    if (contract.name.endsWith('apply') && window.__calls.filter(c => c.name === contract.name).length === 1) return { pending: true, operationId: '00000000-0000-4000-8000-000000000000' };
    if (contract.name.endsWith('apply')) { if (input.confirm !== true) throw Error('Confirmation missing'); return { pending: false, operationId: '00000000-0000-4000-8000-000000000000', value: { results: [{ id: job.id, bytes: job.bytes, state: 'complete', reason: 'Done' }] } }; }
    if (contract.name.endsWith('retention')) return input;
    throw Error('Unexpected fixture call');
  };
}
