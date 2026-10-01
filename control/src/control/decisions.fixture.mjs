// Test-only fixture for the Fulcra J3 decision store: a temporary journal with a prime seat, a project seat
// and a second prime, all delegated, and a native double that drives the PRODUCTION admit() at the dispatch
// boundary (as seat-inbox.test.mjs does). Shared by decisions.test.mjs and the plugin's inbox contract test,
// so the plugin's schemas are checked against what this controller really returns. Not imported by any
// production module.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, generateKeyPairSync, sign as signData } from 'node:crypto';
import { ControlStore } from './store.mjs';
import { Controller } from './controller.mjs';
import { Bindings } from './bindings.mjs';
import { RoleChannels } from './role-channels.mjs';
import { Decisions } from './decisions.mjs';
import { Devices, PURPOSE } from './devices.mjs';
import { InboxChannels } from './inbox-channels.mjs';
import { canonicalJson } from '../../orca-organization/shared/cc/decision-rules.mjs';
import { COMPANY, PROGRAMME } from './authority.mjs';
import { admit, observation } from './admission-guard.mjs';
import { rpc } from './rpc.mjs';

export const P = n => `22222222-2222-4222-8222-${String(n).padStart(12, '0')}`;
export const T = n => `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`;
export const OP = 'test-operator';

export async function fixture(t, { now = () => Date.now() } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orca-decisions-')));
  const store = new ControlStore(path.join(dir, 'journal.sqlite'));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const issue = id => ({ id, companyId: COMPANY, parentId: id === PROGRAMME ? null : PROGRAMME, assigneeUserId: 'local-board', assigneeAgentId: null, status: 'in_progress' });
  const states = new Map(), sends = [];
  const native = {
    route: () => undefined,
    inspect: async id => ({ status: 'idle', pending: 0, lastPromptId: null, lastUserAt: null, ...(states.get(id) ?? {}), ...observation(id) }),
    send: async (id, text, messageId) => {
      sends.push({ id, text, messageId });
      admit(store.db, { id, pendingPermissions: [], lastUserMessageAt: null }, text, messageId, false);
      states.set(id, { ...(states.get(id) ?? {}), lastPromptId: messageId });
    },
    receipt: async () => null,
  };
  const directory = { observedAt: new Date().toISOString(), available: true, partial: false,
    projects: [{ id: P(1), name: 'Orca', description: null, status: 'in_progress' }], membership: [{ taskId: T(1), projectId: P(1) }], note: 'test project source' };
  const control = new Controller({ store, native, authority: async id => issue(id) });
  control.bindings = new Bindings(control, async () => directory, path.join(dir, 'grants', 'role'));
  control.channels = new RoleChannels(control, () => Date.now());
  // Tests that pair devices stand in for the release constant and the host's device flag (v1.13 R3-1); devices.test.mjs
  // checks that production (no overrides) is off whatever is written in the controller home.
  const pairing = { mode: 'on' };
  control.devices = new Devices(control, { now, release: true, hostDevice: () => pairing.mode === 'on' });
  control.inboxChannels = new InboxChannels(control, { now });
  const reads = { count: 0 };
  control.decisions = new Decisions(control, { now, readProjects: async () => { reads.count++; return directory; }, pumpEveryMs: 0, composeEveryMs: 0, busyRetryMs: 0, archiveProbeMs: 0 });
  const enrol = task => { const id = randomUUID(); store.created(id, task, path.join(dir, id)); states.set(id, { lastPromptId: null }); return id; };
  const prime = enrol(PROGRAMME), project = enrol(T(1)), other = enrol(PROGRAMME);
  await control.bindings.assign({ role: 'prime', seat: 'delivery', sessionId: prime, expectedSessionGeneration: 1, expectedRevision: 0, note: 'Accountable prime seat for delivery' });
  await control.bindings.assign({ role: 'project-orchestrator', seat: P(1), sessionId: project, expectedSessionGeneration: 1, expectedRevision: 0, note: 'Owns delivery of this project' });
  await control.bindings.assign({ role: 'prime', seat: 'research', sessionId: other, expectedSessionGeneration: 1, expectedRevision: 0, note: 'A second prime seat for refusal tests' });
  for (const id of [prime, project, other]) await control.handback(id, 'Delegated for the decision store verification');
  const capability = async id => JSON.parse(fs.readFileSync((await control.bindings.grantRole({ sessionId: id, expectedGeneration: store.get(id).generation })).grantFile, 'utf8')).capability;
  const request = rpc(control, OP);
  const caps = { project: await capability(project), other: await capability(other), prime: await capability(prime) };
  const role = (who, method, input) => request({ method, capability: caps[who], input: { sessionId: { project, other, prime }[who], ...input } });
  const op = (method, input) => request({ method, operator: OP, input });
  const ask = (packet, extra = {}, who = 'project') => role(who, 'roles-decision-ask', { messageId: randomUUID(), packet, ...extra });
  // §3.6: a paired test device (fake P-256 key from node:crypto) and its signed answers.
  const pairFirst = async (label = 'Test Mac', key = deviceKey()) => {
    const w = await op('devices-pair-open', null);
    const device = { label, platform: 'macos', publicKey: key.publicKey, keyStorage: 'os-protected', userPresence: true };
    const payload = { purpose: PURPOSE.pair, windowId: w.windowId, code: w.code, device, messageId: randomUUID(), at: new Date(now()).toISOString() };
    const r = await op('devices-pair-complete', { payload, signature: signed(key, payload) });
    return { ...r.device, key };
  };
  const proofFor = (dev, d, optionId, { messageId = randomUUID(), note = '', at = new Date(now()).toISOString(), revision = d.revision, confirmDestructive = false } = {}) => {
    const payload = { decisionId: d.id, revision, optionId, digest: d.action.type === 'none' ? null : d.action.digest, messageId, note, confirmDestructive, at };
    return { messageId, proof: { deviceId: dev.id, alg: 'ES256', payload, signature: signed(dev.key, payload) } };
  };
  const chooseProven = (dev, d, optionId, extra = {}) => { const { messageId, proof } = proofFor(dev, d, optionId, { note: extra.note ?? '', confirmDestructive: extra.confirmDestructive ?? false });
    return op('decisions-choose', { messageId, id: d.id, expectedRevision: d.revision, optionId, note: '', confirmDestructive: false, ...extra, proof }); };
  const choose = (d, optionId, extra = {}) => op('decisions-choose', { messageId: randomUUID(), id: d.id, expectedRevision: d.revision, optionId, note: '', confirmDestructive: false, ...extra });
  return { pairing, pairFirst, proofFor, chooseProven, reads, dir, store, control, request, role, op, ask, choose, prime, project, other, states, sends, caps, directory, enrol };
}
export const impacts = { benefit: 'Changes are tried safely first', cost: 'A little more hosting', time: 'About a day', risk: 'Low', reversibility: 'reversible', blastRadius: null };
export const option = (id, extra = {}) => ({ id, title: `Option ${id.toUpperCase()}`, summary: 'Keep a practice copy of the site next to the real one.', example: 'Like a dress rehearsal before opening night.', impacts, destructive: false, ...extra });
export const level1 = (extra = {}) => ({ kind: 'decision', level: 1, projectId: P(1), taskId: null, askedOf: 'human', title: 'Where should practice copies of the website live?',
  situation: 'Changes go straight to customers today. A practice copy would catch mistakes first.', options: [option('a'), option('b')],
  recommendation: { optionId: 'a', why: 'It is the cheapest safe choice.', confidence: 'medium', wouldChangeIf: 'Costs double.' },
  evidence: [{ ref: `task:${T(1)}`, label: 'The planning task' }], action: { type: 'none' }, expiresAt: null, ...extra });

export function deviceKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), privateKey };
}
export const signed = (key, payload, dsaEncoding = 'ieee-p1363') => signData('sha256', Buffer.from(canonicalJson(payload)), { key: key.privateKey, dsaEncoding }).toString('base64');
