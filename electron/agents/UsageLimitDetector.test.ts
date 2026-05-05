import { describe, expect, it } from 'vitest';
import { detectUsageLimit } from './UsageLimitDetector.js';

describe('detectUsageLimit', () => {
  it('does not classify quota status output as a hard usage limit', () => {
    expect(
      detectUsageLimit(`
        Context window: 68% left (91.2K used / 258K)
        5h limit: 69% left (resets 21:29)
        Weekly limit: 94% left (resets 00:38 on 12 May)
        GPT-5.3-Codex-Spark limit:
        5h limit: 100% left (resets 01:50 on 6 May)
        Weekly limit: 100% left (resets 20:50 on 12 May)
      `)
    ).toBeNull();
  });

  it('classifies hard usage-limit messages with reset text', () => {
    expect(
      detectUsageLimit("You've hit your usage limit. To get more access now, try again at Apr 13th, 2026 12:46 AM.")
    ).toMatchObject({
      resetAtLabel: 'Apr 13th, 2026 12:46 AM'
    });
  });
});
