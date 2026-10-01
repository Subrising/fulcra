import test from "node:test";
import assert from "node:assert/strict";
import { registerReturnCommands } from "./navigation";
test('global and agent commands open the registered surface and clean up; unsupported hosts retain only the existing menu route', () => {
  const commands: any[] = [], opened: string[] = []; let removed = 0;
  const dispose = registerReturnCommands({ openSurface() {}, addCommandCenterItem(command) { commands.push(command); return () => { removed++; }; } });
  assert.deepEqual(commands.map(c => c.context), ['global', 'agent']);
  for (const command of commands) command.onSelect({ openSurface: (id: string) => opened.push(id) });
  assert.deepEqual(opened, ['organization', 'organization']); dispose(); assert.equal(removed, 2);
  registerReturnCommands({ addCommandCenterItem() { throw Error('Must remain hidden'); } })();
  registerReturnCommands({ openSurface() { throw Error('Must not navigate on registration'); } })();
});
