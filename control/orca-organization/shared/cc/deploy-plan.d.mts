import type { DeployChange } from "./deploy";
export function baseType(type: string): string;
export function typeLabel(type: string): string;
export function holdsData(type: string): boolean;
export function canonicalJson(value: unknown): string;
export function readTemplate(template: unknown): {
  resources: {
    key: string;
    symbol: string;
    type: string;
    radiusType: string;
    name: string;
    body: Record<string, unknown>;
  }[];
  links: { from: string; to: string }[];
};
export function describeUpdate(type: string, before: unknown, after: unknown): string[];
export function summarise(
  changes: { type: string; kind: "add" | "update" | "remove"; label: string; name: string }[],
  options?: { first?: boolean; application?: string },
): string;
export function planChange(input: {
  previous: unknown;
  next: unknown;
  live?: { type: string; name: string }[] | null;
  local?: boolean;
}): DeployChange;
export function confirmWord(environmentName: string): string;
export function kubeconfigContexts(text: string): { names: string[]; current: string | null };
