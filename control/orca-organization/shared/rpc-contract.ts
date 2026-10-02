import { defineRpc } from "@getpaseo/plugin";

/**
 * A typing-only shim over the plugin's RPC surface.
 *
 * `@getpaseo/plugin` 0.8.0 declares `defineRpc`, `server.handle` and `useRpc` with generics
 * constrained to the bare `ZodType`. Under zod 4.6.2 a `ZodObject` no longer satisfies that
 * constraint — `ZodType`'s defaults pin its internals to `$ZodTypeInternals<unknown, unknown>` —
 * so TypeScript runs a *failing* structural comparison across the entire nested schema at every
 * call site. A failing check has no early exit, and over `fleetSchema` (which nests
 * `supervisorSchema` inside arrays) it exhausts the heap. That, not `z.infer`, is what made
 * `tsc --noEmit` impossible to complete: with these shims the whole project checks in seconds.
 *
 * Nothing here runs at runtime. `defineContract` *is* `defineRpc` — which only trims and validates
 * the method name — and the type helpers below read zod's own inferred internals rather than
 * restating any shape. No schema, no parsing, and no accepted or rejected value changes.
 *
 * The plugin peer-depends on `zod: ^4.4.3`, which `4.6.2` satisfies, so this is a genuine upstream
 * incompatibility inside the accepted range rather than a pin violation. See contract-types-report.
 */
export interface Contract<Input, Output> {
  name: string;
  input: Input;
  output: Output;
}

export const defineContract = defineRpc as unknown as <Input, Output>(
  definition: Contract<Input, Output>,
) => Contract<Input, Output>;

/**
 * Read zod's own inferred input/output off the schema's internals. Structural inference, so no
 * constraint is ever discharged and the type can never disagree with the schema it came from.
 */
type SchemaInput<Schema> = Schema extends { _zod: { input: infer Value } } ? Value : never;
type SchemaOutput<Schema> = Schema extends { _zod: { output: infer Value } } ? Value : never;

/** What a server handler receives: the input after the contract's own schema parsed it. */
export type ContractInput<C> = SchemaOutput<C extends { input: infer I } ? I : never>;
/** What a server handler returns: a value the output schema still has to parse. */
export type ContractOutput<C> = SchemaInput<C extends { output: infer O } ? O : never>;
/** What a caller sends: the input before parsing. */
export type ContractSend<C> = SchemaInput<C extends { input: infer I } ? I : never>;
/** What a caller receives: the output after parsing. */
export type ContractReceive<C> = SchemaOutput<C extends { output: infer O } ? O : never>;
