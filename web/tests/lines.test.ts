import { describe, expect, it } from 'vitest';
import { allUserLines, allowedPlaceholders, userLine } from '../src/foldy/lines';

describe("the user's Foldy lines (docs/foldy-lines.xlsx → lines.gen.json)", () => {
  it('only use placeholders the app fills in for that line', () => {
    for (const [id, alts] of allUserLines()) {
      const ok = allowedPlaceholders(id);
      for (const text of alts) {
        for (const [, name] of text.matchAll(/\{(\w+)\}/g)) {
          expect(ok, `${id}: "{${name}}" is not filled in for this line`).toContain(name);
        }
      }
    }
  });

  it('falls back to the built-in line and fills placeholders', () => {
    expect(userLine('no_such_line', 'At byte {byte}.', { byte: 42 })).toBe('At byte 42.');
  });
});
