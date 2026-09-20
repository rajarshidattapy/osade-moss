import { describe, expect, it } from 'vitest';

import { imageFilesFromDataTransfer, photosPrompt } from '../src/renderer/compose-photos.js';
import { visibleUserText } from '../src/renderer/chat.js';

describe('photosPrompt', () => {
  it('asks the agent to open each file and keeps the caption', () => {
    const text = photosPrompt(['/tmp/a.png', '/tmp/b.png'], 'what is this?');
    expect(text).toContain('```photos');
    expect(text).toContain('/tmp/a.png');
    expect(text).toContain('/tmp/b.png');
    expect(text).toContain('what is this?');
    expect(text).toContain('Open each file and look at it.');
  });

  it('sends photos with no caption', () => {
    const text = photosPrompt(['/tmp/a.png'], '   ');
    expect(text).toContain('/tmp/a.png');
    expect(text).toContain('Open each file and look at it.');
    expect(text).not.toMatch(/what is this/u);
  });
});

describe('imageFilesFromDataTransfer', () => {
  it('keeps images and drops other files', () => {
    const png = new File([new Uint8Array([1])], 'a.png', { type: 'image/png' });
    const txt = new File([new Uint8Array([1])], 'a.txt', { type: 'text/plain' });
    const files = imageFilesFromDataTransfer({
      files: [png, txt],
      items: undefined,
    } as unknown as DataTransfer);
    expect(files.map((file) => file.name)).toEqual(['a.png']);
  });
});

describe('visibleUserText photos', () => {
  it('collapses the photos fence to a count', () => {
    expect(
      visibleUserText(
        '```photos\n/a.png\n/b.png\n```\n\nThe user pasted these photos. Open each file and look at it.\n\nwhat is this?',
      ),
    ).toBe('(2 photos)\nwhat is this?');
  });
});
