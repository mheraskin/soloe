import type { ClipboardImagePayload } from '@shared/types/files.js';

export async function readClipboardImages(
  clipboard: Pick<Clipboard, 'read'> | undefined = navigator.clipboard
): Promise<ClipboardImagePayload[]> {
  if (!clipboard?.read) return [];
  const items = await clipboard.read();
  const images: ClipboardImagePayload[] = [];
  for (const item of items) {
    const imageType = item.types.find((type) => type.startsWith('image/'));
    if (!imageType) continue;
    const blob = await item.getType(imageType);
    images.push({
      mimeType: imageType,
      dataBase64: await blobToBase64(blob)
    });
  }
  return images;
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
