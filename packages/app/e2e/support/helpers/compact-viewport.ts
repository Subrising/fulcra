// Mirrors useIsCompactFormFactor (src/constants/layout.ts): a phone width, or a phone held sideways
// (an "md" width under the 992px "lg" breakpoint, shorter than 500px) on a touch screen.
export function isCompactViewport(
  size: { width: number; height: number },
  touch: boolean,
): boolean {
  return size.width < 720 || (touch && size.width < 992 && size.height < 500);
}
