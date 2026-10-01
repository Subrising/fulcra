/** Main-owned endpoint gate. Its return value must never cross renderer IPC. */
export async function commandCentreBearer(input: {
  enabled: boolean;
  status: {
    desktopManaged: boolean;
    status: string;
    serverId: string;
    listen: string | null;
  };
  target?: Record<string, unknown>;
  read(): Promise<string | null>;
}): Promise<string | null> {
  const { status, target } = input;
  if (
    !input.enabled ||
    !status.desktopManaged ||
    status.status !== "running" ||
    status.serverId !== target?.serverId ||
    !status.listen
  )
    return null;
  let expected: URL;
  try {
    expected = new URL(`ws://${status.listen}/ws`);
  } catch {
    return null;
  }
  if (!["127.0.0.1", "[::1]"].includes(expected.hostname) || target?.url !== expected.toString())
    return null;
  return input.read();
}
