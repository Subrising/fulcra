import { hostname } from "node:os";
import type { PluginServerContext, PluginHandlerContext } from "@getpaseo/plugin/server";
import { ProgressBoardService } from "./service";
import { lastResult } from "./adapters";
import { progressBoardRpc, progressBoardWatchRpc } from "../../shared/progress-board";
import type { Contract, ContractInput, ContractOutput } from "../../shared/rpc-contract";
export type RegisterBoard = <I, O>(
  contract: Contract<I, O>,
  handler: (
    input: ContractInput<Contract<I, O>>,
    context: PluginHandlerContext,
  ) => ContractOutput<Contract<I, O>> | Promise<ContractOutput<Contract<I, O>>>,
  readOnly: boolean,
) => void;
export function contributeProgressBoard(server: PluginServerContext, register: RegisterBoard) {
  const board = new ProgressBoardService();
  register(progressBoardRpc, (_input, context) => board.read(context.paseo, hostname()), true);
  register(progressBoardWatchRpc, (input) => board.watchRevision(input.revision), true);
  const stop = server.on("agent.turn_ended", (event) =>
    board.recordResult(event.agent.id, lastResult(event.timeline)),
  );
  return () => {
    stop();
    return board.close();
  };
}
