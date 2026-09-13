export interface OverlaySignature {
  count: number;
}

export interface OverlayProbe {
  appeared: boolean;
  selectorHint?: string;
}

export const OVERLAY_SIGNATURE_EXPR =
  'JSON.stringify({count:document.querySelectorAll("[role=dialog],[aria-modal=true]").length})';

export function detectOverlayAppearance(before: OverlaySignature, after: OverlaySignature): boolean {
  return after.count > before.count;
}
