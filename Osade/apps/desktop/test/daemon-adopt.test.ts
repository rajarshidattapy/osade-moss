import { describe, expect, it } from 'vitest';

import { healthMatchesBuild } from '../src/main/supervisor/daemon-build.js';

describe('healthMatchesBuild', () => {
  it('adopts only a daemon whose /health build matches the entry we would spawn', () => {
    expect(healthMatchesBuild({ ok: true, build: 'abc' }, 'abc')).toBe(true);
  });

  it('refuses a healthy daemon from an older build — that is taskShellOpen 404', () => {
    expect(healthMatchesBuild({ ok: true }, 'abc')).toBe(false);
    expect(healthMatchesBuild({ ok: true, build: 'old' }, 'abc')).toBe(false);
  });
});
