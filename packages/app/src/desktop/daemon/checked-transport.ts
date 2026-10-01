import type {
  DaemonTransport,
  DaemonTransportFactory,
} from "@getpaseo/client/internal/daemon-client-transport-types";
/** Delay socket creation until a secret-free main-process preflight succeeds. */
export function checkedTransport(
  base: DaemonTransportFactory,
  check: (url: string) => Promise<void>,
): DaemonTransportFactory {
  return (options) => {
    let inner: DaemonTransport | undefined,
      closed = false;
    const message = new Set<Parameters<DaemonTransport["onMessage"]>[0]>();
    const open = new Set<Parameters<DaemonTransport["onOpen"]>[0]>();
    const close = new Set<Parameters<DaemonTransport["onClose"]>[0]>();
    const error = new Set<Parameters<DaemonTransport["onError"]>[0]>();
    void check(options.url)
      .then(() => {
        if (closed) return undefined;
        inner = base(options);
        inner.onMessage((data, binary) => message.forEach((fn) => fn(data, binary)));
        inner.onOpen(() => open.forEach((fn) => fn()));
        inner.onClose((event) => close.forEach((fn) => fn(event)));
        inner.onError((event) => error.forEach((fn) => fn(event)));
        return undefined;
      })
      .catch((failure) => {
        if (closed) return undefined;
        closed = true;
        const reason =
          failure instanceof Error ? failure.message : "Desktop daemon authentication unavailable";
        error.forEach((fn) => fn(new Error(reason)));
        close.forEach((fn) =>
          fn({
            code:
              failure instanceof Error && Reflect.get(failure, "retryable") === true ? 1013 : 4401,
            reason,
          }),
        );
      });
    return {
      send(data) {
        if (!inner || closed) throw Error("Desktop connection not ready");
        inner.send(data);
      },
      close(code, reason) {
        closed = true;
        inner?.close(code, reason);
      },
      onMessage(fn) {
        message.add(fn);
        return () => {
          message.delete(fn);
        };
      },
      onOpen(fn) {
        open.add(fn);
        return () => {
          open.delete(fn);
        };
      },
      onClose(fn) {
        close.add(fn);
        return () => {
          close.delete(fn);
        };
      },
      onError(fn) {
        error.add(fn);
        return () => {
          error.delete(fn);
        };
      },
    };
  };
}
