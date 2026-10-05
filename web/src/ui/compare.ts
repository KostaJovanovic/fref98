// Compare geometry (pure). Every pane is drawn into the main (After) image's on-screen box, stretched to fit it
// exactly, so before/after line up whatever their pixel sizes: MMS shrinks, Wrong size widens, a thumbnail
// survivor is tiny. `sx`/`sy` are device px per image px of that pane, so a screen point maps back per pane.

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Device px per image px, horizontally and vertically (differ when the aspect ratios differ). */
  sx: number;
  sy: number;
}

export interface CompareView {
  /** The pane's rectangle on the canvas (device px). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Zoom of the After image (device px per After px). */
  zoom: number;
  /** The After point shown at the centre of the pane rectangle. */
  cx: number;
  cy: number;
}

export function compareRects(beforeW: number, beforeH: number, afterW: number, afterH: number, view: CompareView): { before: Box; after: Box } {
  const aw = Math.max(1, afterW);
  const ah = Math.max(1, afterH);
  const z = view.zoom;
  const w = Math.max(1, Math.round(aw * z));
  const h = Math.max(1, Math.round(ah * z));
  const x = Math.round(view.x + view.w / 2 - view.cx * z);
  const y = Math.round(view.y + view.h / 2 - view.cy * z);
  return {
    after: { x, y, w, h, sx: w / aw, sy: h / ah },
    before: { x, y, w, h, sx: w / Math.max(1, beforeW), sy: h / Math.max(1, beforeH) },
  };
}

/** Image coordinates (of the pane drawn into `box`) under device point (px, py). */
export function boxToImage(box: Box, px: number, py: number): { x: number; y: number } {
  return { x: (px - box.x) / box.sx, y: (py - box.y) / box.sy };
}

/** Status-bar size text: "640×480", or "640×480 (was 1024×768)" when the result changed size. */
export function sizeNote(beforeW: number | undefined, beforeH: number | undefined, afterW: number, afterH: number): string {
  const now = `${afterW}×${afterH}`;
  if (!beforeW || !beforeH || (beforeW === afterW && beforeH === afterH)) return now;
  return `${now} (was ${beforeW}×${beforeH})`;
}
