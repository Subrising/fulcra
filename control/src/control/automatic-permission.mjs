// Applies only to permission requests actually received by Fulcra. Provider modes
// are host facts, never request metadata. Questions remain questions, not grants.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
export const automaticMode = (provider, mode) => provider === 'claude' && mode === 'auto' || provider === 'codex' && mode === 'full-access';
export const permissionMode = agent => agent.runtime?.modeId ?? agent.currentModeId ?? null;
export const permissionToolId = request => request.metadata?.toolUseId ?? request.metadata?.itemId ?? request.metadata?.callId;

// Fixed reasons only: arguments may contain credentials and must never be echoed.
export function escalationReason(request, cwd) {
  const name = String(request.name ?? '').toLowerCase();
  const strings = [];
  const communication = /(?:send|post|reply|comment|message)/i.test(name) && !/(?:exec|command|run|eval|terminal|shell|stdin|pty|console)/i.test(name);
  function collect(value, key = '') {
    if (typeof value === 'string') {
      // File content is data; scan commands/code, destinations, and named operations.
      if (!['content', 'old_string', 'new_string', 'description', 'title'].includes(key) && !(communication && ['message','text','body','prompt','subject'].includes(key))) strings.push(value);
    } else if (value === true) strings.push(key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' '));
    else if (Array.isArray(value)) value.forEach(v => collect(v, key));
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) collect(v, k);
  }
  collect(request.input);
  const text = [name.replace(/[_-]+/g, ' '), ...strings].join(' ');
  // R1 P-2 (b), U7: a best-effort denylist, NOT a security boundary (L52). Quoting and escapes are removed before the
  // path checks, so `~/.co''dex/auth.json` and `"$HOME/.codex/au"th.json` read as the path they name.
  const unquoted = text.replace(/['"\\`]/g, '');
  const credentials = /(?:^|[\s/\\"'=])(?:\.env(?:\.[\w-]+)?|\.ssh|\.aws|\.gnupg|\.netrc|\.npmrc|\.pypirc|auth\.json|credentials(?:\.json)?|id_rsa|id_ed25519|operator\.secret|controller\.secret)(?:$|[\s/\\"'])|\.config[/\\]gh[/\\]hosts\.yml|Library[/\\]Keychains|\.keychain(?:-db)?\b/i;
  const secretTool = /(?:credential|keychain|secret|password|access[_-]?token|api[_-]?key)|\btoken\b/i;
  // `security` followed by any separator (argv lists, `;`, quotes) and a keychain verb; the password-reading verbs on
  // their own (a shell variable can stand in for `security`); Fulcra's own pool: its Keychain service and Codex homes.
  const pool = /Fulcra account|[/\\]accounts[/\\]codex(?:[/\\]|$)|[/\\]\.codex[/\\]/i;
  const keychainCommand = /\bsecurity[\s'",;]+(?:find|dump|export|import|add|delete|unlock|set|create|list)-|\b(?:find-(?:generic|internet)-password|dump-keychain)\b|\b(?:secret-tool|pass|op)\s+(?:show|read|get|item|export)|\b(?:aws|gcloud|az)\s+.*(?:credential|access-token|print-access-token)/i;
  if (/\b(?:printenv|env|set)(?:\s*$|\s*[;|])|(?:print|console\.log)\s*\(\s*(?:process\.env|os\.environ)\s*\)/i.test(text)) return 'Credential or Keychain access needs you because it can expose or change private authentication data';
  // Decoded or evaluated code can't be read here, so running it needs the owner.
  const opaque = /\bbase64\b[^|;&]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b|(?:^|[;&|({\n]|\bthen|\bdo)\s*eval\s/i;
  if (secretTool.test(name.replace(/[_-]+/g, ' ')) || credentials.test(text) || credentials.test(unquoted) || pool.test(unquoted) || keychainCommand.test(text) || strings.some(value => opaque.test(value)) || /\bgh\s+auth\s+(?:token|status)|\b(?:printenv|env|set)\b[^;]*(?:TOKEN|SECRET|PASSWORD|API_KEY)|(?:process\.env|os\.environ|\$)[^;]*(?:TOKEN|SECRET|PASSWORD|API_KEY)/i.test(text)) return 'Credential or Keychain access needs you because it can expose or change private authentication data';
  // Resolve existing path arguments to catch a harmless-looking alias of a secret file.
  for (const value of strings) if (value.length < 4096 && !value.includes('\n')) {
    try { if (credentials.test(fs.realpathSync(path.resolve(cwd, value)))) return 'Credential or Keychain access needs you because it can expose or change private authentication data'; } catch { /* A non-path argument has no filesystem target. */ }
  }
  const git = /\bgit\b/i.test(text);
  const shared = /(?:^|[\s/:="'-])(?:main|master|release(?:[/-][\w.-]+)?|integration)(?=$|[\s/:"'])/i.test(text);
  const destructive = /\bcommit\b.*--amend|\b(?:reset|rebase|filter-branch|filter-repo|update-ref)\b|\b(?:push|branch)\b.*(?:--force\S*|(?:^|\s)-[a-zA-Z]*[fDMd]\b|--delete|--mirror|\bforce\b|\bdelete\b|\s[:+][\w/.-]+)/i.test(text) || /\bcheckout\b.*(?:-B\b|--orphan)/.test(text);
  if (git && destructive) {
    // The explicit branch/refspec is authoritative for remote moves; local history
    // changes without a ref require a read of the worktree's current branch.
    const explicit = request.input?.branch ?? request.input?.ref ?? request.input?.refspec ??
      (/\bpush\s+(?:(?:--\S+|-\w+)\s+)*[\w.-]+\s+([+:]?[\w/.-]+(?::[\w/.-]+)?)/i.exec(text)?.[1]);
    let destination = explicit;
    if (!destination && !/\bpush\b/i.test(text)) {
      try {
        if (/\bcd\s|GIT_DIR|GIT_WORK_TREE|--git-dir|--work-tree/.test(text)) throw Error('Indirect worktree');
        const changes = [...text.matchAll(/(?:^|\s)-C\s*(?:"([^"]*)"|'([^']*)'|([^\s;]+))/g)];
        let targetCwd = request.input?.cwd ?? cwd;
        for (const change of changes) targetCwd = path.resolve(targetCwd, change[1] ?? change[2] ?? change[3]);
        destination = execFileSync('git', ['-C', targetCwd, 'symbolic-ref', '--quiet', '--short', 'HEAD'],
        { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim(); } catch { /* Unknown destination must be resolved by the owner. */ }
    }
    const sharedDestination = !destination || /(?:^|[/:])(?:main|master|release(?:[/-].*)?|integration)$/.test(destination);
    if (shared || sharedDestination || /--mirror|--all/.test(text)) return 'Destructive shared-branch git needs you because it can rewrite or delete other people’s work';
  }
  // R1 P-5: shared branches deleted or moved through the GitHub API, and any forced ref update through it.
  const apiRef = /git\/refs\/heads\/([\w./-]+)/i.exec(text);
  if (apiRef && (/force\s*=\s*true/i.test(text) || (/(?:^|[/:])(?:main|master|release[\w./-]*|integration[\w./-]*)$/i.test(apiRef[1]) &&
    (/(?:-X\s*|--method[\s=]+|\bmethod\s+)(?:DELETE|PATCH)\b/i.test(text) || /^(?:delete|patch)$/i.test(String(request.input?.method ?? '')) || /\bforce\b/i.test(text)))))
    return 'Destructive shared-branch git needs you because it can rewrite or delete other people’s work';
  if (/\/(?:repos\/[^/ ]+\/[^/ ]+\/releases|releases)(?:[/? ]|$)/i.test(text) && /\b(?:post|put|patch|delete|create|upload)\b/i.test(text)) return 'Publishing or releases need you because they make work available outside this task';
  if (/(?:publish|create[_-]?release|upload[_-]?release|deploy|release[_-]?(?:create|upload|publish))/i.test(name) ||
    /\b(?:npm|pnpm|yarn|cargo|gem|dotnet)\s+(?:[^\n]*\s)?publish\b|\b(?:twine\s+upload|gh\s+release\s+(?:create|upload|edit|delete)|docker\s+push|git\s+push\s+[^\n]*--tags|gh\s+workflow\s+run|git\s+push\s+(?:(?:--?[\w-]+)\s+)*[\w.-]+\s+(?:tag\s+\S+|refs\/tags\/\S+|v?\d+(?:\.\d+){1,3}(?:[-+][\w.]+)?(?=\s|$))|(?:vercel|netlify|wrangler|firebase)\s+(?:deploy|publish))\b/i.test(text)) {
    return 'Publishing or releases need you because they make work available outside this task';
  }
  return null;
}
export function automaticPermissionProof(request, root, modeId, inputHash) {
  if (!automaticMode(request.provider, modeId) || request.kind !== 'tool' || typeof request.name !== 'string' || typeof permissionToolId(request) !== 'string') throw Error('A correlated tool request in auto/full-access mode is required');
  const reason = escalationReason(request, root); if (reason) throw Error(reason);
  return { kind: 'automatic-tool', root, modeId, inputHash };
}
