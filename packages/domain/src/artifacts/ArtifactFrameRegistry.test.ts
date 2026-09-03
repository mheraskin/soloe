import { describe, expect, it } from 'vitest';
import { ArtifactFrameRegistry } from './ArtifactFrameRegistry.js';

describe('ArtifactFrameRegistry', () => {
  it('keeps issued HTML exact until its ticket expires', () => {
    let now = 1_000;
    const registry = new ArtifactFrameRegistry({
      now: () => now,
      createToken: () => '11111111-1111-4111-8111-111111111111',
      ttlMs: 500
    });
    const html = '<!doctype html><script>parent.postMessage("ready", "*")</script>';

    const ticket = registry.issue(html);

    expect(registry.read(ticket.token)).toBe(html);
    now = 1_501;
    expect(registry.read(ticket.token)).toBeNull();
  });

  it('bounds retained frames and rejects oversized HTML', () => {
    const tokens = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333'
    ];
    let tokenIndex = 0;
    const registry = new ArtifactFrameRegistry({
      createToken: () => {
        const token = tokens[tokenIndex];
        tokenIndex += 1;
        if (!token) throw new Error('Test token sequence exhausted');
        return token;
      },
      maxEntries: 2,
      maxHtmlBytes: 8
    });

    const first = registry.issue('one');
    registry.issue('two');
    registry.issue('three');

    expect(registry.read(first.token)).toBeNull();
    expect(() => registry.issue('123456789')).toThrow(/exceeds/i);
  });
});
