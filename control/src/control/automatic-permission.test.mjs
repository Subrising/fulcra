import test from 'node:test';
import assert from 'node:assert/strict';
import { escalationReason } from './automatic-permission.mjs';
for (const [name, input] of [
  ['exec', { command:'git', args:['push','--force','origin','main'] }],
  ['mcp__git__push', { branch:'main', force:true }],
  ['exec', {command:'git reset --hard HEAD', cwd:'/nonexistent/fixture'}],
  ['exec', {command:'printenv CLAUDE_CODE_OAUTH_TOKEN'}],
  ['exec', {command:'gh auth token'}],
  ['Read', {path:'~/.config/gh/hosts.yml'}],
  ['mcp__github__api', {method:'POST', path:'/repos/fixture/repo/releases', body:{tag_name:'v1'}}],
]) test(`protected structured operation: ${name} ${JSON.stringify(input)}`, () => {
  assert.equal(typeof escalationReason({name,input}, '/nonexistent/fixture'), 'string');
});
for (const [name, input] of [
  ['mcp__sessions__send_message', {session:'fixture',message:'Please review this change'}],
  ['exec', {command:'git push --force-with-lease origin cc/v02-u7-w2-approvals'}],
  ['mcp__git__push', {branch:'cc/v02-u7-w2-approvals',force:true}],
  ['Write', {file_path:'/fixture/output.md',content:'Document npm publish and Keychain access'}],
]) test(`ordinary operation: ${name}`, () => assert.equal(escalationReason({name,input}, '/fixture'), null));
for (const command of ['git checkout -B main', 'git commit --amend', 'git update-ref -d refs/heads/main', 'git -C /nonexistent/shared reset --hard', 'cd /shared && git reset --hard', 'printenv', 'python -c "print(os.environ)"']) {
  test(`protected implicit operation: ${command}`, () => assert.equal(typeof escalationReason({name:'Bash',input:{command}}, '/nonexistent/fixture'), 'string'));
}
for (const flag of ['force_with_lease','forceWithLease']) test(`structured shared git flag ${flag}`, () => {
  assert.equal(typeof escalationReason({name:'mcp__git__push',input:{branch:'main',[flag]:true}},'/fixture'),'string');
});
test('destructive git -C cannot be overridden by request cwd', () => {
  assert.equal(typeof escalationReason({name:'Bash',input:{cwd:process.cwd(),command:'git -C /nonexistent/shared reset --hard'}},process.cwd()),'string');
});
test('attached git -C resolves the actual destructive target', () => {
  assert.equal(typeof escalationReason({name:'Bash',input:{cwd:process.cwd(),command:'git -C/nonexistent/shared reset --hard HEAD'}},process.cwd()),'string');
});
test('ordinary checkout -b is not destructive checkout -B', () => {
  assert.equal(escalationReason({name:'Bash',input:{command:'git checkout -b feature main'}},'/fixture'),null);
});
test('task communication discusses protected actions without requesting them', () => {
  assert.equal(escalationReason({name:'mcp__sessions__send_message',input:{message:'Review git push --force origin main, security find-generic-password, and npm publish'}},'/fixture'),null);
});

for (const name of ['terminal_send_text', 'shell_send_text', 'stdin_send_text']) test(`executable text remains inspected: ${name}`, () => {
  assert.equal(typeof escalationReason({name,input:{text:'security find-generic-password -s fixture'}},'/fixture'),'string');
});

// ---- R1 P-2 (b) / P-5 hardening (best-effort denylist, NOT a security boundary: L52) ------------------------------
const CRED = 'Credential or Keychain access needs you because it can expose or change private authentication data';
const GIT = 'Destructive shared-branch git needs you because it can rewrite or delete other people’s work';
const PUB = 'Publishing or releases need you because they make work available outside this task';
for (const [label, name, input, reason] of [
  // P-2 (b): R1's example bypasses, each now escalates.
  ['security via a Python argv list', 'Bash', { command: `python3 -c "import subprocess;print(subprocess.run(['security','find-generic-password','-s','Fulcra account','-w'],capture_output=True).stdout)"` }, CRED],
  ['security through a shell variable', 'Bash', { command: 's=security; $s find-generic-password -s "Fulcra account" -w' }, CRED],
  ['security; separator', 'Bash', { command: 'security;find-generic-password -w' }, CRED],
  ['the Fulcra account service name alone', 'mcp__keys__lookup', { service: 'Fulcra account' }, CRED],
  ['auth.json with an empty-quote split', 'Bash', { command: "cat ~/.co''dex/auth.json" }, CRED],
  ['auth.json with a partly quoted path', 'Bash', { command: 'cat "$HOME/.codex/au"th.json' }, CRED],
  ['auth.json with a backslash split', 'Bash', { command: 'cat ~/.codex/au\\th.json' }, CRED],
  ['a pooled Codex account home', 'Bash', { command: 'ls /Volumes/test-volume/home/accounts/codex/0f9e370c/' }, CRED],
  ['base64-decoded script piped to sh', 'Bash', { command: 'echo c2VjdXJpdHkgZmluZC1nZW5lcmljLXBhc3N3b3Jk | base64 -d | sh' }, CRED],
  ['base64 --decode piped to bash', 'Bash', { command: 'base64 --decode payload.txt | bash' }, CRED],
  ['base64 -D piped to zsh', 'Bash', { command: 'cat x | base64 -D | zsh -s' }, CRED],
  ['shell eval of a substitution', 'Bash', { command: 'eval "$(cat script.b64 | base64 -d)"' }, CRED],
  ['eval after a separator', 'Bash', { command: 'x=1; eval $CMD' }, CRED],
  ['an MCP tool named get_token', 'mcp__vault__get_token', {}, CRED],
  ['an MCP tool named github_token', 'github_token', {}, CRED],
  ['an MCP tool named token', 'mcp__auth__token', { account: 'work' }, CRED],
  // P-5: shared refs through the GitHub API, tag pushes by name, workflow dispatch.
  ['gh api DELETE main', 'Bash', { command: 'gh api -X DELETE repos/o/r/git/refs/heads/main' }, GIT],
  ['gh api --method DELETE release branch', 'Bash', { command: 'gh api --method DELETE repos/o/r/git/refs/heads/release-1.2' }, GIT],
  ['gh api PATCH master', 'Bash', { command: 'gh api -X PATCH repos/o/r/git/refs/heads/master -f sha=abc123' }, GIT],
  ['gh api force update of main (no -X)', 'Bash', { command: 'gh api repos/o/r/git/refs/heads/main -f sha=abc123 -f force=true' }, GIT],
  ['gh api integration branch delete', 'Bash', { command: 'gh api -XDELETE /repos/o/r/git/refs/heads/integration/u7' }, GIT],
  ['structured GitHub API delete of main', 'mcp__github__api', { method: 'DELETE', path: '/repos/o/r/git/refs/heads/main' }, GIT],
  ['force=true on any ref through the API', 'Bash', { command: 'gh api -X PATCH repos/o/r/git/refs/heads/cc/feature -f sha=abc -F force=true' }, GIT],
  ['tag push by version name', 'Bash', { command: 'git push origin v1.2.0' }, PUB],
  ['tag push by bare version', 'Bash', { command: 'git push upstream 2.0.1' }, PUB],
  ['tag push by refs/tags', 'Bash', { command: 'git push origin refs/tags/release-candidate' }, PUB],
  ['tag push with the tag keyword', 'Bash', { command: 'git push origin tag nightly' }, PUB],
  ['workflow dispatch', 'Bash', { command: 'gh workflow run deploy.yml --ref main' }, PUB],
  ['workflow dispatch by id', 'Bash', { command: 'gh workflow run 12345' }, PUB],
]) test(`R1 bypass now escalates: ${label}`, () => {
  assert.equal(escalationReason({ name, input }, '/nonexistent/fixture'), reason);
});

for (const [label, name, input] of [
  ['feature branch push', 'Bash', { command: 'git push origin cc/v02-u7-approvals-harden' }],
  ['feature branch push with upstream', 'Bash', { command: 'git push -u origin feature/v2-login' }],
  ['reading a ref through the API', 'Bash', { command: 'gh api repos/o/r/git/refs/heads/main' }],
  ['updating a feature ref without force', 'Bash', { command: 'gh api -X PATCH repos/o/r/git/refs/heads/cc/feature -f sha=abc' }],
  ['listing pull requests', 'Bash', { command: 'gh api repos/o/r/pulls --jq .[].number' }],
  ['listing workflow runs', 'Bash', { command: 'gh workflow list' }],
  ['viewing a workflow run', 'Bash', { command: 'gh run view 12345 --log' }],
  ['decoding base64 to a file', 'Bash', { command: 'echo aGVsbG8= | base64 -d > hello.txt' }],
  ['a script named evaluate', 'Bash', { command: 'npm run evaluate -- --suite fast' }],
  ['python eval in a test file name', 'Bash', { command: 'pytest tests/test_eval_metrics.py' }],
  ['searching the code for the word token', 'Grep', { pattern: 'token', path: 'src/' }],
  ['a tokenizer tool', 'mcp__nlp__tokenize', { text: 'hello world' }],
  ['a count_tokens tool', 'count_tokens', { text: 'hello' }],
  ['reading package.json', 'Read', { file_path: '/fixture/package.json' }],
  ['running the tests', 'Bash', { command: 'npm test -- --maxWorkers=2' }],
  ['a message discussing the keychain and accounts', 'mcp__sessions__send_message', { message: 'security find-generic-password -s "Fulcra account" reads ~/.codex/auth.json; gh workflow run deploy' }],
  ['a security audit script', 'Bash', { command: 'npm run security-audit' }],
]) test(`ordinary tool call stays automatic: ${label}`, () => {
  assert.equal(escalationReason({ name, input }, '/fixture'), null);
});
