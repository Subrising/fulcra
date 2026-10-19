// Mirrors useIsCompactFormFactor (src/constants/layout.ts): a phone width, or a phone held sideways
// (an "md" width under the 992px "lg" breakpoint, shorter than 500px).
export function isCompactViewport(size: { width: number; height: number }): boolean {
  return size.width < 720 || (size.width < 992 && size.height < 500);
}
