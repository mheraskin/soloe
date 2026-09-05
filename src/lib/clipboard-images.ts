import type { ClipboardImagePayload } from '@shared/types/files.js';

export interface ClipboardImageSource {
  readonly mimeType: string;
  readonly blob: Blob;
}

export function clipboardImageSources(
  data: Pick<DataTransfer, 'items' | 'files'> | null
): ClipboardImageSource[] {
  if (!data) return [];
  const itemImages: ClipboardImageSource[] = [];
  for (const item of Array.from(data.items)) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
    const blob = item.getAsFile();
    if (blob) itemImages.push({ mimeType: item.type, blob });
  }
  if (itemImages.length > 0) return itemImages;

  return Array.from(data.files)
    .filter((file) => file.type.startsWith('image/'))
    .map((blob) => ({ mimeType: blob.type, blob }));
}

export async function clipboardImagePayloads(
  sources: readonly ClipboardImageSource[]
): Promise<ClipboardImagePayload[]> {
  return Promise.all(
    sources.map(async ({ mimeType, blob }) => ({
      mimeType,
      dataBase64: await blobToBase64(blob)
    }))
  );
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read clipboard image'));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      resolve(result.replace(/^data:[^,]*,/u, ''));
    };
    reader.readAsDataURL(blob);
  });
}
