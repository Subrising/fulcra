export type TakeoverResult = {
  ok: boolean;
  outcome: 'refreshed' | 'refused' | 'uncertain';
  message: string;
  sessionId?: string;
  switchId?: string;
  account?: { id: string; name: string; provider: 'claude' | 'codex' };
  at?: string;
  reason?: 'manual' | 'limit';
};
/** Host-owned seam. The caller must authorize manual human switches before invoking it. */
export function takeOverSession(
  sessionId: string,
  targetAccount: string | { id: string },
  context: { control: any; root?: string; generation?: number; now?: () => number; reason?: 'manual' | 'limit'; reconcile?: boolean; switchId?: string },
): Promise<TakeoverResult>;
