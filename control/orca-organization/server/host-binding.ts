import { portable } from "./portable";
import { nativeHostBindings } from "../shared/host-binding";
export function readNativeHostBindings() {
  return nativeHostBindings.parse(
    Object.fromEntries([portable.localHost, ...portable.hosts].map((h) => [h.name, h.serverId])),
  );
}
