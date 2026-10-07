// FULCRA(plugin-host): turn-footer seam. The tool calls of the turn a completed-turn footer closes, oldest first,
// for plugin turn footers. Walks back from the footer's item to the user message that opened the turn.
import type { PluginTurnToolCall } from "@getpaseo/plugin/client";
import type { StreamItem } from "@/types/stream";
import type { StreamStrategy } from "./strategy";

export function collectTurnToolCalls(input: {
  strategy: Pick<StreamStrategy, "getNeighborIndex">;
  items: readonly StreamItem[];
  startIndex: number;
}): PluginTurnToolCall[] {
  const calls: PluginTurnToolCall[] = [];
  for (
    let index = input.startIndex;
    index >= 0 && index < input.items.length;
    index = input.strategy.getNeighborIndex(index, "above")
  ) {
    const item = input.items[index]!;
    if (item.kind === "user_message") break;
    if (item.kind === "tool_call" && item.payload.source === "agent") {
      const { name, status, detail } = item.payload.data;
      calls.push({ name, status, detail } as PluginTurnToolCall);
    }
  }
  return calls.toReversed();
}
