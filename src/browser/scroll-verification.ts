export interface ViewportPosition {
  scrollX: number;
  scrollY: number;
}

/** Non-interpolated literal eval expression — safe to run outside the sensitive-action gate. */
export const READ_VIEWPORT_EXPR = 'JSON.stringify({scrollX:window.scrollX,scrollY:window.scrollY})';

const SUB_PIXEL_TOLERANCE = 1;

export function isScrollNoop(before: ViewportPosition, after: ViewportPosition): boolean {
  return (
    Math.abs(before.scrollX - after.scrollX) < SUB_PIXEL_TOLERANCE &&
    Math.abs(before.scrollY - after.scrollY) < SUB_PIXEL_TOLERANCE
  );
}
