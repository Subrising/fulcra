import { useQueries } from "@tanstack/react-query";
import { getPaseoClient, useHosts } from "@getpaseo/plugin/client";
import { readOrganizationNativeCatalog } from "./native-catalog.mjs";
export function useNativeCatalog() {
  const hosts = useHosts();
  const reads = useQueries({
    queries: hosts.map((host) => ({
      queryKey: ["fulcra-organization-native-catalog", host.serverId],
      enabled: host.status === "online",
      retry: false,
      staleTime: 60000,
      queryFn: () => readOrganizationNativeCatalog(getPaseoClient(host.serverId), host.serverId),
    })),
  });
  return {
    hosts,
    reads,
    projects: reads.flatMap((row) => row.data?.projects ?? []),
    contexts: reads.flatMap((row) => row.data?.contexts ?? []),
    sessions: reads.flatMap((row) => row.data?.sessions ?? []),
    partial:
      reads.some((row) => row.isError || row.data?.partial) ||
      hosts.some((host) => host.status !== "online"),
    pending: reads.some((row) => row.isPending && row.fetchStatus === "fetching"),
  };
}
