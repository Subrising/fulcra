import unittest
from main_ci_state import ci_workflow_state


REPO = 'Subrising/fulcra'
SHA = 'a' * 40
HEAD = 'b' * 40


class MainCiTests(unittest.TestCase):
    def fixture(self, attested=False):
        run = {'id': 10, 'path': '.github/workflows/ci.yml', 'head_sha': HEAD if attested else SHA,
               'head_branch': 'candidate' if attested else 'main', 'event': 'pull_request' if attested else 'workflow_dispatch',
               'status': 'completed', 'conclusion': 'success', 'repository': {'full_name': REPO}}
        data = {
            'runs': {'workflow_runs': [] if attested else [run]},
            'run': run,
            'jobs': {'jobs': [{'name': 'ci-passed', 'run_id': 10, 'status': 'completed', 'conclusion': 'success'}]},
            'checks': {'check_runs': [
                {'name': 'merge', 'status': 'completed', 'conclusion': 'failure', 'head_sha': SHA, 'app': {'id': 15368}},
                {'name': 'ci-passed', 'status': 'completed', 'conclusion': 'success', 'head_sha': SHA, 'app': {'id': 15368},
                 'external_id': f'tested-tree:{SHA}', 'details_url': f'https://github.com/{REPO}/actions/runs/10'},
            ]},
            'merge': {'parents': [{'sha': 'c' * 40}, {'sha': HEAD}], 'commit': {'tree': {'sha': 'd' * 40}}},
            'head': {'commit': {'tree': {'sha': 'd' * 40}}},
        }
        calls = []

        def api(path):
            calls.append(path)
            if path.startswith('actions/workflows/ci.yml/runs?'):
                return data['runs']
            if path == 'actions/runs/10/jobs?filter=latest&per_page=100':
                return data['jobs']
            if path.startswith(f'commits/{SHA}/check-runs?'):
                return data['checks']
            if path == 'actions/runs/10':
                return data['run']
            if path == f'commits/{SHA}':
                return data['merge']
            if path == f'commits/{HEAD}':
                return data['head']
            raise AssertionError(f'Unexpected API call: {path}')

        return data, calls, api

    def test_refused_merge_dispatch_does_not_turn_green_main_red(self):
        data, calls, api = self.fixture()
        data['runs']['workflow_runs'].append({**data['run'], 'id': 11,
                                            'path': '.github/workflows/merge-pr.yml', 'conclusion': 'failure'})
        self.assertEqual(ci_workflow_state(REPO, 'main', SHA, api), 'green')
        self.assertFalse(any('check-runs' in path or path.endswith('/status') for path in calls))

    def test_real_ci_failure_and_pending_still_count(self):
        for conclusion in ['failure', 'timed_out', 'cancelled']:
            data, _, api = self.fixture()
            data['run']['conclusion'] = conclusion
            self.assertEqual(ci_workflow_state(REPO, 'main', SHA, api), 'red')
        data, _, api = self.fixture()
        data['run'].update(status='in_progress', conclusion=None)
        self.assertEqual(ci_workflow_state(REPO, 'main', SHA, api), 'pending')

    def test_success_requires_the_ci_gate_from_that_run(self):
        for change in [lambda data: data['jobs']['jobs'].clear(),
                       lambda data: data['jobs']['jobs'][0].update(run_id=99),
                       lambda data: data['jobs']['jobs'][0].update(name='merge')]:
            data, _, api = self.fixture()
            change(data)
            self.assertEqual(ci_workflow_state(REPO, 'main', SHA, api), 'unknown')
        data, _, api = self.fixture()
        data['jobs']['jobs'][0]['conclusion'] = 'failure'
        self.assertEqual(ci_workflow_state(REPO, 'main', SHA, api), 'red')

    def test_failed_merge_without_ci_is_unknown(self):
        data, _, api = self.fixture()
        data['runs']['workflow_runs'].clear()
        data['checks']['check_runs'] = data['checks']['check_runs'][:1]
        self.assertEqual(ci_workflow_state(REPO, 'main', SHA, api), 'unknown')

    def test_tested_tree_gate_ignores_the_failed_merge_check(self):
        _, _, api = self.fixture(attested=True)
        self.assertEqual(ci_workflow_state(REPO, 'main', SHA, api), 'green')

    def test_unrelated_workflow_or_tree_cannot_supply_a_green_gate(self):
        for change in [lambda data: data['run'].update(path='.github/workflows/merge-pr.yml'),
                       lambda data: data['run'].update(event='workflow_dispatch'),
                       lambda data: data['merge']['commit']['tree'].update(sha='e' * 40),
                       lambda data: data['merge']['parents'][1].update(sha='e' * 40),
                       lambda data: data['checks']['check_runs'][1].update(app={'id': 1})]:
            data, _, api = self.fixture(attested=True)
            change(data)
            self.assertEqual(ci_workflow_state(REPO, 'main', SHA, api), 'unknown')


if __name__ == '__main__':
    unittest.main()
