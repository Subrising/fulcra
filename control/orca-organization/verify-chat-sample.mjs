// Fulcra J3b: a sample of what a chat channel shows, rendered by the one shared renderer (shared/cc/channel-text.mjs)
// from a seeded, personal-data-free fixture. Writes docs/screens/channels/chat-sample.txt. No controller, no network.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decisionText, heldText, itemLine, alreadyAnswered } from './shared/cc/channel-text.mjs';
import { noPersonal } from './shared/cc/refs.mjs';
const root = path.dirname(fileURLToPath(import.meta.url)), out = path.join(root, '..', '..', 'local', 'screens', 'channels');
const at = '2026-09-24T09:14:00+10:00', impacts = { benefit: 'Safer', cost: 'Small', time: 'A week', risk: 'Low', reversibility: 'reversible', blastRadius: null };
const packet = { title: 'Where should practice copies of our products live?', situation: 'Today every change goes straight to customers. A practice copy would let us try changes first.',
  options: [{ id: 'fulcra', title: 'Fulcra keeps them', summary: 'Fulcra records each copy and moves a change along with one approval from you.', example: 'Like a dress rehearsal on the real stage before opening night.', impacts, destructive: false },
    { id: 'github', title: 'Use GitHub’s built-in copies', summary: 'GitHub keeps the copies. Fulcra only shows what is where.', example: 'Like renting a rehearsal room from the theatre next door.', impacts, destructive: false }],
  recommendation: { optionId: 'fulcra', why: 'It works for every product the same way and needs no new accounts.' }, action: { type: 'none' }, state: 'open', choice: null };
const held = { title: 'Message waiting from the Tally project lead', urgency: 'now', untrustedText: 'HELD-BODY-MUST-NOT-APPEAR' };
const answered = { ...packet, state: 'chosen', choice: { optionId: 'github', by: 'human', proven: true, via: 'app-ios', at } };
const lines = [
  '> anything waiting for me?', '',
  [itemLine(1, { urgency: 'now', title: packet.title }), itemLine(2, held), itemLine(3, { urgency: 'fyi', title: 'Daily digest · All work' })].join('\n'), '',
  '> show 1', '', decisionText(packet, 1), '',
  '> show 2', '', heldText(held, 2), '',
  '(later, after it was answered on the phone, the first message is edited to:)', '', decisionText(answered, 1), '',
  '> answer 1 with option 1', '', alreadyAnswered(answered.choice),
];
const text = lines.join('\n') + '\n';
if (text.includes('HELD-BODY-MUST-NOT-APPEAR') || !noPersonal(text)) throw Error('The chat sample leaked a held body or personal data');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'chat-sample.txt'), text);
console.log(text);
