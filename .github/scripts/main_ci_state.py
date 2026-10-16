"""Classify main from CI workflow records, never from unrelated commit checks."""
import re
from urllib.parse import quote


CI_PATH = '.github/workflows/ci.yml'
RED = {'failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale'}


def run_state(run, api, attempt=None):
    if run['conclusion'] in RED:
        return 'red'
    if run['status'] != 'completed':
        return 'pending'
    if run['conclusion'] != 'success':
        return 'unknown'
    route = (f"actions/runs/{run['id']}/jobs?filter=latest&per_page=100" if attempt is None else
             f"actions/runs/{run['id']}/attempts/{attempt}/jobs?per_page=100")
    jobs = api(route)['jobs']
    gates = [job for job in jobs if job['name'] == 'ci-passed' and job['run_id'] == run['id'] and
             (attempt is None or job.get('run_attempt') == attempt)]
    if len(gates) != 1:
        return 'unknown'
    gate = gates[0]
    if gate['conclusion'] in RED:
        return 'red'
    if gate['status'] != 'completed':
        return 'pending'
    return 'green' if gate['conclusion'] == 'success' else 'unknown'


def ci_workflow_state(repo, branch, sha, api):
    runs = api(f'actions/workflows/ci.yml/runs?head_sha={sha}&branch={quote(branch, safe="")}&per_page=100')['workflow_runs']
    scoped = [run for run in runs if run['path'] == CI_PATH and
              run['head_sha'] == sha and run['head_branch'] == branch and
              run['repository']['full_name'] == repo]
    if scoped:
        return run_state(max(scoped, key=lambda run: run['id']), api)

    # Bot merges reuse a successful PR tree instead of running CI on main again.
    # Bind the immutable CI attempt in external_id. GitHub may rewrite details_url.
    checks = api(f'commits/{sha}/check-runs?check_name=ci-passed&filter=latest&per_page=100')['check_runs']
    gates = []
    for check in checks:
        if (check['name'] != 'ci-passed' or check['head_sha'] != sha or check['app']['id'] != 15368 or
                check['status'] != 'completed' or check['conclusion'] != 'success'):
            continue
        identity = re.fullmatch(r'tested-tree:' + re.escape(sha) + r':([1-9][0-9]*):([1-9][0-9]*)',
                                check.get('external_id') or '')
        if identity:
            gates.append(identity)
    if len(gates) != 1:
        return 'unknown'
    run_id, attempt = map(int, gates[0].groups())
    run = api(f'actions/runs/{run_id}/attempts/{attempt}')
    if (run['id'] != run_id or run.get('run_attempt') != attempt or run['path'] != CI_PATH or
            run['event'] != 'pull_request' or run['repository']['full_name'] != repo):
        return 'unknown'
    merge = api(f'commits/{sha}')
    head = api(f"commits/{run['head_sha']}")
    if (len(merge['parents']) != 2 or merge['parents'][1]['sha'] != run['head_sha'] or
            merge['commit']['tree']['sha'] != head['commit']['tree']['sha']):
        return 'unknown'
    return run_state(run, api, attempt)
