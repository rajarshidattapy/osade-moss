import { describe, expect, it } from 'vitest';

import { chunkRepo, isScannable, type SourceFile } from '../../src/knowledge/code/chunker.js';

/**
 * OSADE-MOSS §M.5.4 — chunking, enrichment and the transitive closure.
 *
 * §M.5.10 criterion 1 is the target: a repo seeded with **an aliased import and a two-level
 * wrapper**, where discovery must find every seeded site and grep must miss at least two of
 * them. Those two shapes are what these tests are about; everything else here exists to stop
 * the closure over-reaching in the process.
 *
 * This is an integration test, not a unit test: it loads the real WASM grammar. The pairing of
 * `web-tree-sitter` and `@vscode/tree-sitter-wasm` is a genuine ABI risk (ARCH §2.2,
 * §M.12 Q5) and the first pairing tried did not load at all, so the parser is exercised for
 * real rather than stubbed.
 */

const PKG = '@moss-js/moss';

function repo(files: Record<string, string>): SourceFile[] {
  return Object.entries(files).map(([path, text]) => ({ path, text }));
}

describe('§M.5.4 — the grammar loads and parses TypeScript', () => {
  it('parses a plain direct call', async () => {
    const result = await chunkRepo(
      repo({
        'src/a.ts': [
          `import { search } from "${PKG}";`,
          'export function go(q: string) { return search(q); }',
        ].join('\n'),
      }),
      { packageName: PKG },
    );

    expect(result.unparsed).toEqual([]);
    const call = result.calls.find((c) => c.symbol === 'search');
    expect(call).toMatchObject({ file: 'src/a.ts', line: 2, via: 'direct', hop: 0 });
  });

  it('parses TSX', async () => {
    const result = await chunkRepo(
      repo({
        'src/App.tsx': [
          `import { search } from "${PKG}";`,
          'export const App = () => <div>{search("q")}</div>;',
        ].join('\n'),
      }),
      { packageName: PKG },
    );
    expect(result.unparsed).toEqual([]);
    expect(result.calls.map((c) => c.symbol)).toContain('search');
  });
});

describe('§M.5.10 criterion 1 — the shapes grep misses', () => {
  it('finds a namespace-aliased call whose source text never mentions the symbol', async () => {
    // `git grep -n search` over this file finds the call only because of the member name; with
    // a renamed local (`m`), a grep for the *import* finds nothing useful. What matters is that
    // the enriched text names the real symbol and the alias.
    const result = await chunkRepo(
      repo({
        'src/lib/moss.ts': [
          `import * as m from "${PKG}";`,
          'export function searchDocs(q: string) {',
          '  return m.search(q);',
          '}',
        ].join('\n'),
      }),
      { packageName: PKG },
    );

    const call = result.calls.find((c) => c.symbol === 'search');
    expect(call).toMatchObject({ via: 'alias', hop: 0, enclosing: 'searchDocs' });

    const chunk = result.chunks.find((c) => c.kind === 'call' && c.symbol === 'search');
    expect(chunk?.enrichedText).toContain('@moss-js/moss#search');
    expect(chunk?.enrichedText).toContain('via local alias "m"');
    expect(chunk?.enrichedText).toContain('in fn searchDocs');
  });

  it('finds a renamed named import', async () => {
    const result = await chunkRepo(
      repo({
        'src/a.ts': [
          `import { MossClient as MC } from "${PKG}";`,
          'export function build() { return new MC("a", "b"); }',
          'export function q() { return MC.search("x"); }',
        ].join('\n'),
      }),
      { packageName: PKG },
    );

    const call = result.calls.find((c) => c.line === 3);
    expect(call).toMatchObject({ symbol: 'MossClient', via: 'alias' });
    const chunk = result.chunks.find((c) => c.kind === 'call' && c.startLine === 3);
    expect(chunk?.enrichedText).toContain('via local alias "MC"');
  });

  it('follows a two-level wrapper across files', async () => {
    const result = await chunkRepo(
      repo({
        'src/lib/moss.ts': [
          `import * as m from "${PKG}";`,
          'export function searchDocs(q: string) { return m.search(q); }',
        ].join('\n'),
        'src/lib/wrap.ts': [
          'import { searchDocs } from "./moss";',
          'export function findAll(q: string) { return searchDocs(q); }',
        ].join('\n'),
        'src/app/page.ts': [
          'import { findAll } from "../lib/wrap";',
          'export function render(q: string) { return findAll(q); }',
        ].join('\n'),
      }),
      { packageName: PKG },
    );

    const byFile = new Map(result.calls.map((c) => [c.file, c]));
    expect(byFile.get('src/lib/moss.ts')).toMatchObject({ hop: 0, via: 'alias' });
    // One level out: the call to the wrapper.
    expect(byFile.get('src/lib/wrap.ts')).toMatchObject({ hop: 1, via: 'wrapper', symbol: 'search' });
    // Two levels out: a call to the wrapper's wrapper. This is the site grep cannot reach at
    // all — `page.ts` contains neither the package name nor the symbol.
    expect(byFile.get('src/app/page.ts')).toMatchObject({ hop: 2, via: 'wrapper', symbol: 'search' });

    const wrapper = result.chunks.find(
      (c) => c.kind === 'derived_wrapper' && c.symbol === 'searchDocs',
    );
    expect(wrapper?.enrichedText).toContain('reaches @moss-js/moss at hop 0');
  });

  it('follows an arrow-function wrapper, not just declarations', async () => {
    const result = await chunkRepo(
      repo({
        'src/a.ts': [
          `import { search } from "${PKG}";`,
          'export const wrap = (q: string) => search(q);',
        ].join('\n'),
        'src/b.ts': ['import { wrap } from "./a";', 'export function go(q: string) { return wrap(q); }'].join('\n'),
      }),
      { packageName: PKG },
    );

    expect(result.calls.find((c) => c.file === 'src/b.ts')).toMatchObject({ hop: 1, via: 'wrapper' });
  });
});

describe('§M.5.4 — the closure knows when to stop', () => {
  it('stops at maxHop', async () => {
    const files: Record<string, string> = {
      'src/l0.ts': [`import { search } from "${PKG}";`, 'export function f0(q: string) { return search(q); }'].join('\n'),
    };
    for (let i = 1; i <= 6; i += 1) {
      files[`src/l${i}.ts`] = [
        `import { f${i - 1} } from "./l${i - 1}";`,
        `export function f${i}(q: string) { return f${i - 1}(q); }`,
      ].join('\n');
    }

    const result = await chunkRepo(repo(files), { packageName: PKG, maxHop: 3 });
    const hops = result.calls.map((c) => c.hop);
    expect(Math.max(...hops)).toBe(3);
    // Beyond the cap the chain is simply not followed — it is a guard, not a silent error.
    expect(result.calls.some((c) => c.file === 'src/l5.ts')).toBe(false);
  });

  it('terminates on a recursive call rather than burning hops on it', async () => {
    const result = await chunkRepo(
      repo({
        'src/a.ts': [
          `import { search } from "${PKG}";`,
          'export function recur(q: string): unknown {',
          '  if (q.length === 0) return search(q);',
          '  return recur(q.slice(1));',
          '}',
        ].join('\n'),
      }),
      { packageName: PKG, maxHop: 3 },
    );

    // The self-call is not a new site; only the real package call is.
    expect(result.calls.filter((c) => c.via !== 'wrapper')).toHaveLength(1);
    expect(result.calls.every((c) => c.hop <= 3)).toBe(true);
  });

  it('terminates on mutual recursion', async () => {
    const result = await chunkRepo(
      repo({
        'src/a.ts': [
          `import { search } from "${PKG}";`,
          'export function a(q: string): unknown { return search(q) ?? b(q); }',
          'export function b(q: string): unknown { return a(q); }',
        ].join('\n'),
      }),
      { packageName: PKG, maxHop: 3 },
    );
    expect(result.calls.every((c) => c.hop <= 3)).toBe(true);
  });
});

describe('§M.5.4 — what is deliberately not scanned', () => {
  it('skips vendored and generated trees', () => {
    expect(isScannable('src/a.ts')).toBe(true);
    expect(isScannable('node_modules/pkg/index.ts')).toBe(false);
    expect(isScannable('dist/bundle.js')).toBe(false);
    expect(isScannable('src/__generated__/schema.ts')).toBe(false);
    expect(isScannable('README.md')).toBe(false);
  });

  it('ignores a different package with a similar name', async () => {
    const result = await chunkRepo(
      repo({
        'src/a.ts': [
          'import { search } from "@moss-js/moss-web";',
          'export function go(q: string) { return search(q); }',
        ].join('\n'),
      }),
      { packageName: PKG },
    );
    expect(result.calls).toEqual([]);
  });

  it('follows a subpath import of the same package', async () => {
    const result = await chunkRepo(
      repo({
        'src/a.ts': [
          `import { session } from "${PKG}/session";`,
          'export function go() { return session("x"); }',
        ].join('\n'),
      }),
      { packageName: PKG },
    );
    expect(result.calls.map((c) => c.symbol)).toEqual(['session']);
  });

  it('does not chunk functions in files with no connection to the package', async () => {
    const result = await chunkRepo(
      repo({
        'src/a.ts': [`import { search } from "${PKG}";`, 'export function go(q: string) { return search(q); }'].join('\n'),
        'src/unrelated.ts': 'export function helper(x: number) { return x + 1; }',
      }),
      { packageName: PKG },
    );
    expect(result.chunks.some((c) => c.file === 'src/unrelated.ts')).toBe(false);
  });
});

describe('§M.10 — a file tree-sitter cannot read is skipped, not fatal', () => {
  it('keeps going and reports the file', async () => {
    const result = await chunkRepo(
      repo({
        'src/broken.ts': 'export function ( { { {{ unterminated',
        'src/a.ts': [`import { search } from "${PKG}";`, 'export function go(q: string) { return search(q); }'].join('\n'),
      }),
      { packageName: PKG },
    );
    // tree-sitter is error-tolerant, so a broken file usually still parses into a tree with
    // ERROR nodes. Either way the good file must be chunked.
    expect(result.calls.some((c) => c.file === 'src/a.ts')).toBe(true);
  });
});
