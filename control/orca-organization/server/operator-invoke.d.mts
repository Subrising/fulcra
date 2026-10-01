export declare function operatorInvoke(value: unknown): Promise<
  { ok: true; result: unknown } |
  { ok: false; code: string; dispatched: boolean; message: string }
>;
