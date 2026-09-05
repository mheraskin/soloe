// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { clipboardImagePayloads, clipboardImageSources } from './clipboard-images';

describe('clipboardImageSources', () => {
  it('reads image files from native clipboard items', async () => {
    const image = new File([new Uint8Array([1, 2, 3])], 'screenshot.png', {
      type: 'image/png'
    });
    const sources = clipboardImageSources({
      items: [
        { kind: 'string', type: 'text/plain', getAsFile: () => null },
        { kind: 'file', type: 'image/png', getAsFile: () => image }
      ],
      files: []
    } as unknown as DataTransfer);

    await expect(clipboardImagePayloads(sources)).resolves.toEqual([
      { mimeType: 'image/png', dataBase64: 'AQID' }
    ]);
  });

  it('falls back to the clipboard file list and ignores non-images', () => {
    const image = new File([new Uint8Array([1])], 'photo.webp', { type: 'image/webp' });
    const text = new File(['hello'], 'notes.txt', { type: 'text/plain' });

    expect(clipboardImageSources({ items: [], files: [text, image] } as unknown as DataTransfer))
      .toEqual([{ mimeType: 'image/webp', blob: image }]);
  });
});
