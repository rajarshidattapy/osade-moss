import { createRequire } from 'node:module';

/**
 * The TypeScript parser seam — OSADE-MOSS §M.5.4.
 *
 * **This and `chunker.ts` are the only files allowed to import `web-tree-sitter`**
 * (lint-enforced), for the same reason `retrieval/**` is the only place a Moss SDK may appear:
 * one seam, swappable, and testable without the rest of the daemon knowing what a syntax tree
 * is.
 *
 * **WASM, not a native addon.** ARCH §2.2 already records what one native ABI mismatch cost
 * this project, and §M.12 Q5 flags the risk again. That caution was warranted: the obvious
 * grammar source (`tree-sitter-wasms`) is built against tree-sitter 0.20 and its modules fail
 * to load under a current `web-tree-sitter` with nothing but a bare `Error`. The pairing here —
 * `@vscode/tree-sitter-wasm` grammars with `web-tree-sitter` 0.27 — is the one that was
 * actually verified to parse, and `chunker.test.ts` fails loudly if it ever stops.
 *
 * Loading is lazy and cached. A daemon that never runs a migration should not pay to
 * instantiate a WASM runtime, and §M.10's "tree-sitter fails on a file" row means a failure
 * here degrades F1 to grep rather than failing the daemon.
 */

export type TsDialect = 'typescript' | 'tsx';

/** The sliver of web-tree-sitter this seam uses. Declared locally so no SDK type escapes. */
export interface SyntaxNode {
  readonly type: string;
  readonly text: string;
  readonly startPosition: { row: number; column: number };
  readonly endPosition: { row: number; column: number };
  readonly childCount: number;
  child(index: number): SyntaxNode | null;
  childForFieldName(name: string): SyntaxNode | null;
  readonly namedChildren?: readonly SyntaxNode[];
}

export interface ParsedFile {
  readonly root: SyntaxNode;
}

export class ParserUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ParserUnavailableError';
  }
}

interface LoadedParser {
  parse(source: string): { rootNode: SyntaxNode } | null;
}

const parsers = new Map<TsDialect, Promise<LoadedParser>>();

/**
 * Loads (once) and returns a parser for a dialect.
 *
 * Throws `ParserUnavailableError` rather than returning null: a caller that cannot parse must
 * decide explicitly whether to skip the file or abandon chunking, and §M.5.4's answer differs
 * per case (a bad file is skipped and listed; a missing runtime degrades the whole stage).
 */
export async function loadParser(dialect: TsDialect): Promise<LoadedParser> {
  const existing = parsers.get(dialect);
  if (existing) return existing;

  const loading = (async (): Promise<LoadedParser> => {
    try {
      const { Parser, Language } = await import('web-tree-sitter');
      const require = createRequire(import.meta.url);
      const wasm = require.resolve(
        `@vscode/tree-sitter-wasm/wasm/tree-sitter-${dialect}.wasm`,
      );
      await Parser.init();
      const language = await Language.load(wasm);
      const parser = new Parser();
      parser.setLanguage(language);
      return parser as unknown as LoadedParser;
    } catch (err) {
      throw new ParserUnavailableError(
        `could not load the ${dialect} grammar: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  })();

  parsers.set(dialect, loading);
  // A failed load must not be cached as a permanent answer: the usual cause is a half-finished
  // install, and retrying after `pnpm install` should work without restarting the daemon.
  loading.catch(() => parsers.delete(dialect));
  return loading;
}

export function dialectFor(file: string): TsDialect | null {
  if (file.endsWith('.tsx') || file.endsWith('.jsx')) return 'tsx';
  if (file.endsWith('.ts') || file.endsWith('.mts') || file.endsWith('.cts')) return 'typescript';
  // `.js` is parsed by the TypeScript grammar, which is a superset. A JS-only repo is still a
  // repo that imports the migrated package.
  if (file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.cjs')) return 'typescript';
  return null;
}

export async function parseFile(file: string, source: string): Promise<ParsedFile | null> {
  const dialect = dialectFor(file);
  if (dialect == null) return null;
  const parser = await loadParser(dialect);
  const tree = parser.parse(source);
  if (!tree) return null;
  return { root: tree.rootNode };
}

/** Depth-first walk. Iterative, because a deep file should not blow the JS stack. */
export function walk(root: SyntaxNode, visit: (node: SyntaxNode) => void): void {
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    visit(node);
    for (let i = node.childCount - 1; i >= 0; i -= 1) {
      const child = node.child(i);
      if (child) stack.push(child);
    }
  }
}
