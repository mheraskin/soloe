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

  it('does not classify documentation or summary prose about usage limits', () => {
    expect(
      detectUsageLimit(
        'Only hard-stop phrases like usage/rate limit reached/exceeded are accepted; never quota status lines.'
      )
    ).toBeNull();
  });

  it('does not classify Codex hook arrival or MCP startup text as a hard limit', () => {
    expect(
      detectUsageLimit(`
        [soloe-hook] hook arrived: provider=codex session=codex-3da1d4 event=SessionStart
        [time] Starting MCP servers (0/2): code-index, playwright
      `)
    ).toBeNull();
  });

  it('does not fuse prose about limits with later reset or startup text', () => {
    expect(
      detectUsageLimit(`
        Current behavior: Codex usage limit reached is shown in the overlay.
        reset the terminal and continue.
        [time] Starting MCP servers (0/2): code-index, playwright
      `)
    ).toBeNull();
  });

  it('classifies provider-shaped usage-limit error lines', () => {
    expect(
      detectUsageLimit('Error: usage limit reached. Try again at Apr 13th, 2026 12:46 AM.')
    ).toMatchObject({
      resetAtLabel: 'Apr 13th, 2026 12:46 AM'
    });
  });
});
