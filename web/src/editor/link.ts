// Shared selection between the editor preview and Hex Doctor (click a block ⇄ jump to its bytes).

export interface BlockSel {
  /** MCU index (raster order) */
  mcu: number;
  /** image-pixel rectangle of that MCU */
  rect: { x: number; y: number; w: number; h: number };
}

type L = () => void;
const ls = new Set<L>();

export const link = {
  picked: null as BlockSel | null,
  /** MCU rectangles highlighted from a hex selection */
  highlights: [] as { x: number; y: number; w: number; h: number }[],
  /** The photo the selection belongs to. */
  photo: null as string | null,
  /** Another photo became current: its blocks and bytes are not the old ones, so the selection is dropped. */
  follow(photo: string | null) {
    if (photo === link.photo) return;
    link.photo = photo;
    if (!link.picked && !link.highlights.length) return;
    link.picked = null;
    link.highlights = [];
    for (const l of ls) l();
  },
  pick(b: BlockSel | null) {
    link.picked = b;
    for (const l of ls) l();
  },
  highlight(r: { x: number; y: number; w: number; h: number }[]) {
    link.highlights = r;
    for (const l of ls) l();
  },
  on(l: L): () => void {
    ls.add(l);
    return () => ls.delete(l);
  },
};
