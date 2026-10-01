/** In-process read publication fences, never serialized or selected by a wire flag. */
const publications = new WeakMap<object, () => void>();
export function bindReportPublication<T extends object>(value: T, guard: () => void): T {
  publications.set(value, guard);
  return value;
}
export function checkReportPublication(value: unknown): void {
  if (value && typeof value === "object") publications.get(value)?.();
}
export function carryReportPublication<T extends object>(source: unknown, target: T): T {
  if (source && typeof source === "object") {
    const guard = publications.get(source);
    if (guard) publications.set(target, guard);
  }
  return target;
}
