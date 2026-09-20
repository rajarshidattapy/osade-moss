import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { osadePaths } from '../paths.js';

/** Chat photos live under `~/.osade/inbox/<taskId>/` — §2.2, not the worktree. */

export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
export const MAX_PHOTOS = 8;

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
};

export interface ChatPhotoInput {
  name: string;
  mime: string;
  /** Raw base64, no data-URL prefix. */
  data: string;
}

export function inboxDir(taskId: string): string {
  return join(osadePaths().root, 'inbox', taskId);
}

export function saveChatPhotos(taskId: string, files: readonly ChatPhotoInput[]): { paths: string[] } {
  if (files.length === 0) return { paths: [] };
  if (files.length > MAX_PHOTOS) throw new Error(`at most ${MAX_PHOTOS} photos per send`);
  const dir = inboxDir(taskId);
  mkdirSync(dir, { recursive: true });
  const stamp = Date.now();
  const paths: string[] = [];
  files.forEach((file, i) => {
    const ext = extensionFor(file);
    const buf = Buffer.from(file.data, 'base64');
    if (buf.length === 0) throw new Error('empty image');
    if (buf.length > MAX_PHOTO_BYTES) throw new Error('a photo is too large (8 MB max)');
    const abs = join(dir, `paste-${stamp}-${i + 1}.${ext}`);
    writeFileSync(abs, buf);
    paths.push(abs);
  });
  return { paths };
}

function extensionFor(file: ChatPhotoInput): string {
  const fromMime = EXT[file.mime.toLowerCase()];
  if (fromMime) return fromMime;
  const tail = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (Object.values(EXT).includes(tail)) return tail;
  throw new Error(`unsupported image type ${file.mime || file.name}`);
}
