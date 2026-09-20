import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { binaryOnPath, resolveBinaryOnPath } from '../../src/domain/agent-catalog.js';

describe('binaryOnPath', () => {
  it('finds a file on PATH without shelling out to which', () => {
    const dir = join(tmpdir(), `osade-path-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const name = process.platform === 'win32' ? 'fakeagent.CMD' : 'fakeagent';
    writeFileSync(join(dir, name), process.platform === 'win32' ? '@echo off\n' : '#!/bin/sh\n');
    expect(
      binaryOnPath('fakeagent', {
        PATH: dir,
        Path: dir,
        PATHEXT: '.COM;.EXE;.BAT;.CMD',
      }),
    ).toBe(true);
    expect(binaryOnPath('missing-agent-xyz', { PATH: dir, Path: dir })).toBe(false);
  });

  it('resolves the PATHEXT binary rather than an extensionless shim on Windows', () => {
    if (process.platform !== 'win32') return;
    const dir = join(tmpdir(), `osade-path-ext-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'claude'), '#!/bin/sh\n');
    writeFileSync(join(dir, 'claude.cmd'), '@echo off\n');
    const resolved = resolveBinaryOnPath('claude', {
      PATH: dir,
      Path: dir,
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
    });
    expect(resolved?.toLowerCase()).toBe(join(dir, 'claude.cmd').toLowerCase());
  });
});

describe('binaryOnPath', () => {
  it('finds a file on PATH without shelling out to which', () => {
    const dir = join(tmpdir(), `osade-path-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const name = process.platform === 'win32' ? 'fakeagent.CMD' : 'fakeagent';
    writeFileSync(join(dir, name), process.platform === 'win32' ? '@echo off\n' : '#!/bin/sh\n');
    expect(
      binaryOnPath('fakeagent', {
        PATH: dir,
        Path: dir,
        PATHEXT: '.COM;.EXE;.BAT;.CMD',
      }),
    ).toBe(true);
    expect(binaryOnPath('missing-agent-xyz', { PATH: dir, Path: dir })).toBe(false);
  });
});
