import { createHash } from 'node:crypto';
export const upstreamSha256 = '909d17200e4fed6395b04fc21ec3e0f381d5ebe3b487113310a3c8414e6b6631';
const replace = (source, before, after) => {
  if (source.split(before).length !== 2) throw Error('Provider patch anchor changed');
  return source.replace(before, after);
};
export function patchEmptySession(source) {
  if (createHash('sha256').update(source).digest('hex') !== upstreamSha256) throw Error('Unrecognized Paseo provider revision');
  source = replace(source, '        if (this.currentThreadId)\n            return;\n        const { model, thinkingOptionId }', '        if (this.currentThreadId) {\n            await this.ensureOrcaEmptySessionPersisted();\n            return;\n        }\n        const { model, thinkingOptionId }');
  source = replace(source, '        this.currentThreadId = threadId;\n    }\n    buildThreadStartRequest(model)', '        this.currentThreadId = threadId;\n        this.orcaEmptySessionPending = !this.ephemeral;\n        await this.ensureOrcaEmptySessionPersisted();\n    }\n' + persistenceMethod + '    buildThreadStartRequest(model)');
  source = replace(source, '            ...(this.ephemeral ? { ephemeral: true } : {}),', '            ...(this.ephemeral ? { ephemeral: true } : { historyMode: "legacy" }),');
  return source;
}

// Keep the provider identity before metadata I/O, and retry that identity on failure.
// A generated label is metadata, never an instruction or a model turn.
const persistenceMethod = `    async ensureOrcaEmptySessionPersisted() {
        if (!this.orcaEmptySessionPending) return;
        if (!this.orcaEmptySessionPersisting) {
            this.orcaEmptySessionPersisting = (async () => {
                const threadId = this.currentThreadId;
                if (!this.client || !threadId || this.ephemeral) throw new Error("Invalid empty-session persistence state");
                await this.client.request("thread/name/set", { threadId, name: threadId });
                const response = await this.client.request("thread/read", { threadId, includeTurns: true });
                if (response?.thread?.id !== threadId || !Array.isArray(response.thread.turns) || response.thread.turns.length) {
                    throw new Error("Empty Codex session persistence was not confirmed");
                }
                this.orcaEmptySessionPending = false;
            })().finally(() => { this.orcaEmptySessionPersisting = null; });
        }
        await this.orcaEmptySessionPersisting;
    }
`;
