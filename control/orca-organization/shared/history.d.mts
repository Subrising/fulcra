export interface ActivityCursor {
  scope: string;
  epoch: string;
  seq: number;
}
export type PageRequest = Readonly<{
  limit: 50;
  projection: "canonical";
  direction: "tail" | "before";
  cursor?: Readonly<{ epoch: string; seq: number }>;
}>;
export function validCursor(value: unknown): value is ActivityCursor;
export function pageRequest(cursor: ActivityCursor | null, scope: string): PageRequest;
export function pageResult(
  page: unknown,
  request: PageRequest,
  scope: string,
  agentId: string,
): { cursor: ActivityCursor | null };
