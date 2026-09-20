import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { saveChatPhotos, MAX_PHOTO_BYTES } from '../../src/domain/chat-photos.js';

const HOME = join(tmpdir(), `osade-photos-${process.pid}`);

describe('saveChatPhotos', () => {
  const prev = process.env.OSADE_HOME;

  afterEach(() => {
    if (prev == null) delete process.env.OSADE_HOME;
    else process.env.OSADE_HOME = prev;
    rmSync(HOME, { recursive: true, force: true });
  });

  it('writes multiple pngs under ~/.osade/inbox/<task>', () => {
    process.env.OSADE_HOME = HOME;
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const { paths } = saveChatPhotos('t_one', [
      { name: 'a.png', mime: 'image/png', data: png.toString('base64') },
      { name: 'b.png', mime: 'image/png', data: png.toString('base64') },
    ]);
    expect(paths).toHaveLength(2);
    expect(paths[0]).toContain('inbox');
    expect(paths[0]).toContain('t_one');
    expect(existsSync(paths[0]!)).toBe(true);
    expect(readFileSync(paths[1]!)).toEqual(png);
  });

  it('rejects a type that is not an image', () => {
    process.env.OSADE_HOME = HOME;
    expect(() =>
      saveChatPhotos('t_one', [{ name: 'x.txt', mime: 'text/plain', data: 'QQ==' }]),
    ).toThrow(/unsupported/);
  });

  it('rejects a photo over 8 MB', () => {
    process.env.OSADE_HOME = HOME;
    const data = Buffer.alloc(MAX_PHOTO_BYTES + 1).toString('base64');
    expect(() =>
      saveChatPhotos('t_one', [{ name: 'a.png', mime: 'image/png', data }]),
    ).toThrow(/too large/);
  });
});
