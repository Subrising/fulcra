import type { createKeychain } from "./accounts.mjs";
export function scratchKeychain(root: string): {
  store: ReturnType<typeof createKeychain>;
  env: NodeJS.ProcessEnv;
};
