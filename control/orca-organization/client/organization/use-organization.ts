import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useContract } from "../use-contract";
import {
  organizationDirectoryRpc,
  organizationMutateRpc,
  type OrganizationCommand,
} from "../../shared/workspace-organization";
import { createOrganizationOperations } from "./operations";
export const organizationQueryKey = (hostId?: string) => ["fulcra-workspace-organization", hostId];
export function useOrganization(hostId?: string) {
  const read = useContract(organizationDirectoryRpc),
    write = useContract(organizationMutateRpc);
  const query = useQuery({
    queryKey: organizationQueryKey(hostId),
    queryFn: () => read({}),
    retry: false,
    staleTime: 30000,
  });
  const [operations] = useState(createOrganizationOperations);
  const cache = useQueryClient();
  const pendingAction = useSyncExternalStore(
    operations.subscribe,
    operations.getState,
    operations.getState,
  );
  useEffect(() => {
    operations.apply(query.data);
  }, [operations, query.data]);
  useEffect(() => () => operations.close(), [operations]);
  const { refetch } = query;
  const mutate = useCallback(
    async (command: OrganizationCommand) => {
      const result = await operations.execute(command, write);
      cache.setQueryData(organizationQueryKey(hostId), result);
      await refetch();
      return result;
    },
    [cache, hostId, operations, refetch, write],
  );
  const retry = useCallback(async () => {
    const result = await operations.retry(write);
    cache.setQueryData(organizationQueryKey(hostId), result);
    await refetch();
    return result;
  }, [cache, hostId, operations, refetch, write]);
  return { query, mutate, pendingAction, retry };
}
