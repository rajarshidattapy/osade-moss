export interface ComposerPhoto {
  id: string;
  name: string;
  mime: string;
  /** Raw base64, no data-URL prefix. */
  data: string;
  preview: string;
}

export const MAX_COMPOSER_PHOTOS = 8;

const IMAGE = /^image\/(png|jpe?g|webp|gif|bmp)$/iu;

export function imageFilesFromDataTransfer(data: DataTransfer | null): File[] {
  if (data == null) return [];
  const seen = new Set<string>();
  const out: File[] = [];
  const push = (file: File | null): void => {
    if (file == null) return;
    if (!IMAGE.test(file.type) && !/\.(png|jpe?g|webp|gif|bmp)$/iu.test(file.name)) return;
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(file);
  };
  for (const file of Array.from(data.files ?? [])) push(file);
  if (out.length === 0 && data.items) {
    for (const item of Array.from(data.items)) {
      if (item.kind === 'file') push(item.getAsFile());
    }
  }
  return out;
}

export function photosPrompt(paths: readonly string[], caption: string): string {
  if (paths.length === 0) return caption.trim();
  const fence = ['```photos', ...paths, '```'].join('\n');
  const look = 'The user pasted these photos. Open each file and look at it.';
  const body = caption.trim();
  return body.length > 0 ? `${fence}\n\n${look}\n\n${body}` : `${fence}\n\n${look}`;
}

export async function fileToPhoto(file: File): Promise<ComposerPhoto> {
  const preview = await readDataUrl(file);
  const comma = preview.indexOf(',');
  return {
    id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2, 8)}`,
    name: file.name || 'paste.png',
    mime: file.type || 'image/png',
    data: comma >= 0 ? preview.slice(comma + 1) : preview,
    preview,
  };
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('could not read image'));
    reader.readAsDataURL(file);
  });
}
