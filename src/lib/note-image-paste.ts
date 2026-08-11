import { tick } from 'svelte';
import type { NoteImage, NoteImagePayload } from '@shared/types/notes.js';

type SaveNoteImages = (payloads: NoteImagePayload[]) => Promise<NoteImage[]>;
type UpdateNoteContent = (content: string) => void;

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read pasted image'));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      resolve(result.replace(/^data:[^,]*,/u, ''));
    };
    reader.readAsDataURL(blob);
  });
}

export async function pasteImagesIntoNote(
  event: ClipboardEvent,
  saveImages: SaveNoteImages,
  updateContent: UpdateNoteContent
): Promise<boolean> {
  const data = event.clipboardData;
  const target = event.currentTarget;
  if (!data || !(target instanceof HTMLTextAreaElement)) return false;

  const files: File[] = [];
  for (const item of Array.from(data.items)) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  if (files.length === 0) return false;

  event.preventDefault();
  const start = target.selectionStart;
  const end = target.selectionEnd;
  const before = target.value.substring(0, start);
  const after = target.value.substring(end);
  const payloads = await Promise.all(
    files.map(async (file) => ({
      mimeType: file.type,
      dataBase64: await blobToBase64(file)
    }))
  );
  const saved = await saveImages(payloads);
  if (saved.length === 0) return true;

  // Keep the cursor ready for more typing after the inserted image paths.
  const insertedText = saved.map((image) => image.absolutePath).join(' ') + ' ';
  updateContent(before + insertedText + after);
  await tick();
  const cursor = start + insertedText.length;
  target.setSelectionRange(cursor, cursor);
  target.focus();
  return true;
}
