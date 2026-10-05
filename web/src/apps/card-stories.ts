// What happens to the card in the Camera menu's accidents, as engine events (kept apart from card.ts so the
// stories can be tested on the real engine).

export interface ScenarioEvent {
  type: string;
  /** How many photos this event appended to the roll (File ▸ Copy Pictures). Not read by the engine. */
  _photos?: number;
  /** What the History shows. Not read by the engine. */
  _label?: string;
  [k: string]: unknown;
}

/** A shoot of `count` photos of a roll of `n`, from roll position `from` on (wrapping). Events name their photos,
 *  so a movie or an accident never uses up pictures that a later Copy adds to the roll. */
export function shoot(from: number, count: number, n: number): ScenarioEvent & { photos: number[] } {
  return { type: 'shoot', count, photos: Array.from({ length: count }, (_, k) => (from + k) % Math.max(1, n)) };
}

export const ACCIDENTS: { id: string; label: string; story: string; events: (n: number) => ScenarioEvent[] }[] = [
  { id: 'deleted', label: 'Deleted by Accident', story: 'Half the photos were deleted in the camera.', events: (n) => [shoot(0, n, n), { type: 'delete', which: 'random', count: Math.max(1, Math.floor(n / 2)) }] },
  { id: 'formatted', label: 'Quick-Formatted, Then Shot More', story: 'The card was formatted in the camera and a few new photos were taken.', events: (n) => [shoot(0, n, n), { type: 'quick_format' }, shoot(0, Math.max(1, Math.floor(n / 3)), n)] },
  // switched off and on in between, so the new photos go into the first gaps instead of after the last file
  { id: 'fragmented', label: 'Fragmented Card', story: 'Photos were deleted and new ones filled the gaps, so files got split up.', events: (n) => [shoot(0, n, n), { type: 'delete', which: 'every_other', count: 1 }, { type: 'power_cycle' }, shoot(0, n, n)] },
  { id: 'powerloss', label: 'Battery Died While Saving', story: 'The camera lost power in the middle of writing a photo.', events: (n) => [shoot(0, 1, n), { type: 'power_loss' }, shoot(1, 1, n)] },
  // chkdsk only finds chains the FAT has but no directory entry points at: a save the battery cut short
  { id: 'chkdsk', label: 'A PC "Repaired" It', story: 'Windows ran chkdsk on the card and saved the pieces as FOUND.000.', events: (n) => [shoot(0, n, n), { type: 'delete', which: 'random', count: Math.max(1, Math.floor(n / 3)) }, { type: 'power_loss', mode: 'no_entry' }, shoot(0, 1, n), { type: 'chkdsk' }] },
  { id: 'reformat', label: 'Formatted on a PC', story: 'Someone formatted it on a computer (a different filesystem layout).', events: (n) => [shoot(0, n, n), { type: 'reformat_pc' }, { type: 'os_junk' }] },
];
