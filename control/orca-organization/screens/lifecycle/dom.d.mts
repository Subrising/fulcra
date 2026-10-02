// Types for the minimal DOM host used by the browser-only lifecycle screen entry.
export declare function mount(render: () => unknown): void;
export declare function jsx(type: unknown, props?: Record<string, unknown>): unknown;
export declare const jsxs: typeof jsx;
declare global {
  interface Window {
    __calls: { name: string; input: unknown }[];
    __ready: boolean;
  }
}
