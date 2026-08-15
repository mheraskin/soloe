// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import {
  TerminalTranscriptFollowController,
  TerminalTranscriptProjector
} from './terminal-transcript.js';

describe('TerminalTranscriptProjector', () => {
  it('combines canonical wrapped rows into responsive logical transcript lines', async () => {
    const projector = new TerminalTranscriptProjector({ cols: 5, rows: 3 });

    await projector.write('abcdefghijk\r\nnext');

    expect(projector.records().map((record) => record.text)).toEqual([
      'abcdefghijk',
      'next'
    ]);
  });

  it('updates carriage-return progress in place without accumulating spinner frames', async () => {
    const projector = new TerminalTranscriptProjector({ cols: 40, rows: 4 });

    for (let progress = 0; progress <= 100; progress += 1) {
      await projector.write(`${progress}%\r`);
    }

    const records = projector.records().filter((record) => record.text.length > 0);
    expect(records).toHaveLength(1);
    expect(records[0]?.text).toBe('100%');
  });

  it('preserves useful ANSI color and emphasis as styled spans', async () => {
    const projector = new TerminalTranscriptProjector({ cols: 40, rows: 4 });

    await projector.write('\u001b[31;1mfailed\u001b[0m plain');

    expect(projector.records()[0]?.spans).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: 'failed', bold: true, foreground: '#cd3131' }),
      expect.objectContaining({ text: ' plain' })
    ]));
  });
});

describe('TerminalTranscriptFollowController', () => {
  it('follows new output only while the reader is already near the bottom', () => {
    const follow = new TerminalTranscriptFollowController(48);

    follow.observe({ scrollTop: 700, clientHeight: 300, scrollHeight: 1_020 });
    expect(follow.shouldFollowNewOutput()).toBe(true);

    follow.observe({ scrollTop: 300, clientHeight: 300, scrollHeight: 1_020 });
    expect(follow.shouldFollowNewOutput()).toBe(false);
  });
});
