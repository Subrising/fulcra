export interface RestartStatus {
  status: "starting" | "running" | "stopped" | "errored";
  ownedByDesktop: boolean;
}

/** A restart must use the app launch path and cannot acquire a foreign process by PID. */
export async function restartManagedDaemon<T extends RestartStatus>(ports: {
  status(): Promise<T>;
  stopOwned(): Promise<T>;
  startManaged(): Promise<T>;
}): Promise<T> {
  const current = await ports.status();
  if (current.status === "errored")
    throw Error("Desktop daemon status unavailable; restart refused.");
  if (current.status !== "stopped") {
    if (!current.ownedByDesktop)
      throw Error("Foreign daemon requires authenticated owner adoption before restart.");
    const stopped = await ports.stopOwned();
    if (stopped.status !== "stopped")
      throw Error("Desktop daemon did not stop; managed launch refused.");
  }
  return ports.startManaged();
}
