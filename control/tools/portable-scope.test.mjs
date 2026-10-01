import test from 'node:test';
import assert from 'node:assert/strict';
import { inScope } from './portable-scope.mjs';
test('reviewed A1 Mini-side dependencies can be packaged', () => {
 for (const file of ['src/control/host-native.mjs','src/control/remote-permissions.mjs','src/control/remote-resumption.mjs','src/book/transport.mjs','src/book/protocol.mjs','src/book/activity.mjs','src/book/activity-page.mjs']) assert.equal(inScope(file),true,file);
});
test('Book receiver, unknown Book inputs, fixtures and deployment inputs stay excluded', () => {
 for (const file of ['src/book/receiver.mjs','src/book/new.mjs','src/book/transport.test.mjs','src/control/activation.mjs','src/control/permission-overlay.py','provider-patches/foo.mjs','src/control/host-native.test.mjs']) assert.equal(inScope(file),false,file);
});
