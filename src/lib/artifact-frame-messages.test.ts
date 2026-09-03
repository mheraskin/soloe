import { describe, expect, it } from 'vitest';
import { parseArtifactFrameMessage } from './artifact-frame-messages.js';

describe('parseArtifactFrameMessage', () => {
  it('accepts exact open and delete messages', () => {
    expect(parseArtifactFrameMessage({
      channel: 'soloe.artifacts', action: 'open', artifactId: 'design-review'
    })).toEqual({
      channel: 'soloe.artifacts', action: 'open', artifactId: 'design-review'
    });
    expect(parseArtifactFrameMessage({
      channel: 'soloe.artifacts', action: 'delete', artifactId: 'design-review'
    })?.action).toBe('delete');
  });

  it('rejects traversal, extra properties, and unrelated messages', () => {
    expect(parseArtifactFrameMessage({
      channel: 'soloe.artifacts', action: 'open', artifactId: '../secret'
    })).toBeNull();
    expect(parseArtifactFrameMessage({
      channel: 'soloe.artifacts', action: 'open', artifactId: 'safe', privileged: true
    })).toBeNull();
    expect(parseArtifactFrameMessage({
      channel: 'other', action: 'open', artifactId: 'safe'
    })).toBeNull();
  });
});

