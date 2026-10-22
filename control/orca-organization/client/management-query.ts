// A controller error is not a new empty observation: keep React Query's last good data.
export async function observedList<T extends { status: string; message: string }>(
  load: () => Promise<T>,
): Promise<T> {
  const result = await load();
  if (result.status !== "observed")
    throw new Error(result.message || "Management observation unavailable");
  return result;
}

// A confirmed refusal is safe to retry with a new identity. An unconfirmed response keeps its identity.
export function retainRequestIdentity<T extends { id: string }>(
  identity: T | null,
  result: { status: string; messageId?: string },
): T | null {
  return identity &&
    identity.id === result.messageId &&
    ["refused", "abandoned"].includes(result.status)
    ? null
    : identity;
}
