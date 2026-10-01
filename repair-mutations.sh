#!/bin/bash
# Invoke inside the orchestrator's guarded serial runner, after dependency builds.
# No installs/builds here. Each test child owns a process group, killed on signals.
set -euo pipefail
cd "$(dirname "$0")"
exec python3 - <<'PY'
import json, os, signal, subprocess
from pathlib import Path

root = Path.cwd()
evidence = Path(os.environ.get('REPAIR_EVIDENCE_DIR', root.parent / 'evidence/repair-mutations')).resolve()
evidence.mkdir(parents=True, exist_ok=True)
cases = [
    ('r1', 'client', 'src/daemon-client.test.ts', 'REPAIR r1:',
     root / 'packages/client/src/daemon-client.ts',
     b'  if (close.trusted !== true) return null; // REPAIR_MUTATION_R1',
     b'  // REPAIR_MUTATION_R1: accept raw close code (intentional mutant)'),
    ('r2', 'app', 'src/runtime/host-runtime.test.ts', 'REPAIR r2:',
     root / 'packages/app/src/runtime/host-runtime.ts',
     b'    return Boolean(this.snapshot.pairingRequired); // REPAIR_MUTATION_R2',
     b'    return false; // REPAIR_MUTATION_R2: keep retrying (intentional mutant)'),
]
originals = {case[4]: case[4].read_bytes() for case in cases}
child = None

def interrupted(signum, _frame):
    raise SystemExit(128 + signum)

for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
    signal.signal(signum, interrupted)

def stop_child():
    global child
    if child is None:
        return
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    child.wait()
    child = None

def restore():
    for path, source in originals.items():
        path.write_bytes(source)
        assert path.read_bytes() == source, 'Source restoration failed'

def run(case, phase):
    global child
    name, package, testfile, target, *_ = case
    report = evidence / f'{name}-{phase}.json'
    report.unlink(missing_ok=True)
    command = [str(root / 'node_modules/.bin/vitest'), 'run', testfile, '-t', target,
               '--maxWorkers=4', '--no-file-parallelism', '--reporter=json', f'--outputFile={report}']
    if package == 'app':
        command += ['--project', 'unit']
    with (evidence / f'{name}-{phase}.log').open('wb') as log:
        child = subprocess.Popen(command, cwd=root / 'packages' / package,
                                 stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        status = child.wait()
        stop_child()
    result = json.loads(report.read_text())
    assert not result.get('numRuntimeErrorTestSuites', 0), 'Suite error is not a mutation kill'
    tests = [test for suite in result['testResults'] for test in suite.get('assertionResults', [])
             if target in test.get('fullName', '')]
    assert tests, 'Missing target behavioural tests'
    if phase == 'mutant':
        failed = [test for test in tests if test['status'] == 'failed']
        assert status != 0 and failed, 'Mutation survived'
        assert all(any('AssertionError' in message for message in test.get('failureMessages', []))
                   for test in failed), 'Not a behavioural assertion failure'
    else:
        assert status == 0 and all(test['status'] == 'passed' for test in tests), 'Baseline/restored run failed'
    print(name, phase, 'verified', flush=True)

try:
    for case in cases:
        name, _, _, _, path, old, new = case
        restore()
        run(case, 'baseline')
        source = originals[path]
        assert source.count(old) == 1, 'Mutation target drifted'
        path.write_bytes(source.replace(old, new))
        try:
            run(case, 'mutant')
        finally:
            stop_child()
            restore()
        run(case, 'restored')
        (evidence / f'{name}-result.txt').write_text(f'{name} killed; source restored byte-for-byte\n')
finally:
    stop_child()
    restore()
PY
