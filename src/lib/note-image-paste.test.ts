// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { pasteImagesIntoNote } from './note-image-paste';

describe('pasteImagesIntoNote', () => {
  it('saves pasted images and inserts their paths at the textarea selection', async () => {
    const textarea = document.createElement('textarea');
    textarea.value = 'before old after';
    textarea.setSelectionRange(7, 10);
    const image = new File([new Uint8Array([1, 2, 3])], 'screenshot.png', {
      type: 'image/png'
    });
    const preventDefault = vi.fn();
    const saveImages = vi.fn().mockResolvedValue([
      {
        absolutePath: '/tmp/soloe-img-screenshot.png',
        filename: 'soloe-img-screenshot.png',
        mimeType: 'image/png'
      }
    ]);
    const updateContent = vi.fn((value: string) => {
      textarea.value = value;
    });
    const event = {
      clipboardData: {
        items: [
          {
            kind: 'file',
            type: 'image/png',
            getAsFile: () => image
          }
        ]
      },
      currentTarget: textarea,
      preventDefault
    } as unknown as ClipboardEvent;

    const handled = await pasteImagesIntoNote(event, saveImages, updateContent);

    expect(handled).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(saveImages).toHaveBeenCalledWith([
      {
        mimeType: 'image/png',
        dataBase64: 'AQID'
      }
    ]);
    expect(updateContent).toHaveBeenCalledWith(
      'before /tmp/soloe-img-screenshot.png  after'
    );
    const expectedCursor = 'before '.length + '/tmp/soloe-img-screenshot.png '.length;
    expect(textarea.selectionStart).toBe(expectedCursor);
    expect(textarea.selectionEnd).toBe(expectedCursor);
  });

  it('leaves ordinary clipboard content to the browser', async () => {
    const textarea = document.createElement('textarea');
    const preventDefault = vi.fn();
    const saveImages = vi.fn();
    const event = {
      clipboardData: {
        items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }]
      },
      currentTarget: textarea,
      preventDefault
    } as unknown as ClipboardEvent;

    const handled = await pasteImagesIntoNote(event, saveImages, vi.fn());

    expect(handled).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(saveImages).not.toHaveBeenCalled();
  });
});
