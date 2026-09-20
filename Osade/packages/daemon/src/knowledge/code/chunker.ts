import { dialectFor, parseFile, ParserUnavailableError, type SyntaxNode } from './parser.js';

/**
 * Chunk, enrich and resolve — OSADE-MOSS §M.5.4.
 *
 * This file is where F1 earns its claim over `git grep`. Grep finds the string `search`. It does
 * not find `m.search(q)` when `m` came from `import * as m`, and it does not find `searchDocs(q)`
 * where `searchDocs` is a local wrapper around the call. Two mechanisms close that gap:
 *
 *   1. **Enrichment.** Every chunk's text is prefixed with a resolved-context header naming what
 *      the code *actually* reaches — `calls @moss-js/moss#search via local alias "m"`. The
 *      header is what gets embedded, so an aliased call is retrievable by meaning even though
 *      its source text shares no token with the symbol being migrated.
 *   2. **Transitive closure.** A function containing an affected call becomes affected itself,
 *      and its callers are then examined in turn, to `maxHop` (default 3, §M.9.2).
 *
 * **Resolution is by name and import, intra-repo, with no type checker** (§M.5.4). That is a
 * real limit, not an oversight: a type checker would need the repo's full dependency graph
 * installed and resolved, which turns a seconds-long scan into a build. The consequence is that
 * two different functions with the same name are conflated, which inflates recall and costs an
 * agent one glance — the trade §M.5.5 makes deliberately, because verification is the arbiter.
 */

export interface SourceFile {
  /** Repo-relative, forward slashes. Used verbatim in `code_chunk.file`. */
  readonly path: string;
  readonly text: string;
}

export interface ChunkerOptions {
  /** The package being migrated, e.g. `@moss-js/moss`. Matched against import sources. */
  readonly packageName: string;
  /** §M.9.2 `migration.maxHop`. The closure stops here even if it has not converged. */
  readonly maxHop?: number;
}

export type ChunkKind = 'function' | 'import' | 'call' | 'derived_wrapper';

export interface Chunk {
  readonly file: string;
  /** 1-based, matching editors, `git grep -n`, and `call_site.line`. */
  readonly startLine: number;
  readonly endLine: number;
  readonly symbol: string | null;
  readonly kind: ChunkKind;
  readonly hop: number;
  readonly enrichedText: string;
}

/** A call the closure reached, with everything discovery needs to match it to a change. */
export interface AffectedCall {
  readonly file: string;
  readonly line: number;
  /** The package symbol this ultimately reaches, e.g. `search` or `MossClient`. */
  readonly symbol: string;
  readonly via: 'direct' | 'alias' | 'wrapper';
  readonly hop: number;
  /** The function this call sits inside, when there is one. */
  readonly enclosing: string | null;
}

export interface ChunkResult {
  readonly chunks: readonly Chunk[];
  readonly calls: readonly AffectedCall[];
  /** §M.10 — files tree-sitter could not read. Grep still covers them, and the UI says so. */
  readonly unparsed: readonly string[];
}

const DEFAULT_MAX_HOP = 3;

/** §M.5.4 — never scanned. Generated or vendored code is not this repo's call sites. */
const EXCLUDED = /(^|\/)(node_modules|dist|build|out|coverage|\.git|vendor|\.next|__generated__)(\/|$)/;

export function isScannable(path: string): boolean {
  return !EXCLUDED.test(path) && dialectFor(path) != null;
}

// ── what one file tells us ────────────────────────────────────────────────────

interface Binding {
  /** The name as used in this file. */
  readonly local: string;
  /** The name in the package: a symbol, `*` for a namespace import, or `default`. */
  readonly imported: string;
  readonly line: number;
  readonly statement: string;
}

interface FnDecl {
  readonly name: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
}

interface RawCall {
  /** `m` in `m.search(q)`, `searchDocs` in `searchDocs(q)`. */
  readonly base: string;
  /** `search` in `m.search(q)`; null for a bare call. */
  readonly member: string | null;
  readonly line: number;
  readonly enclosing: string | null;
  readonly text: string;
}

interface FileFacts {
  readonly path: string;
  readonly bindings: Binding[];
  readonly functions: FnDecl[];
  readonly calls: RawCall[];
}

/**
 * Scans a repo's files and returns everything F1 needs from them.
 *
 * Parse failures are collected, never thrown: §M.10 says a file tree-sitter cannot read is
 * skipped and listed, because grep still covers it. A *runtime* failure is different and does
 * propagate — that is the whole stage being unavailable, not one bad file.
 */
export async function chunkRepo(
  files: readonly SourceFile[],
  options: ChunkerOptions,
): Promise<ChunkResult> {
  const maxHop = options.maxHop ?? DEFAULT_MAX_HOP;
  const facts: FileFacts[] = [];
  const unparsed: string[] = [];

  for (const file of files) {
    if (!isScannable(file.path)) continue;
    try {
      const parsed = await parseFile(file.path, file.text);
      if (!parsed) {
        unparsed.push(file.path);
        continue;
      }
      facts.push(collect(parsed.root, file, options.packageName));
    } catch (err) {
      if (err instanceof ParserUnavailableError) throw err;
      unparsed.push(file.path);
    }
  }

  const { calls, wrappersByHop } = closure(facts, maxHop);
  const chunks = render(facts, calls, wrappersByHop, options.packageName);
  return { chunks, calls, unparsed };
}

// ── collection ────────────────────────────────────────────────────────────────

function collect(root: SyntaxNode, file: SourceFile, packageName: string): FileFacts {
  const bindings: Binding[] = [];
  const functions: FnDecl[] = [];
  const calls: RawCall[] = [];

  const visit = (node: SyntaxNode, enclosing: string | null): void => {
    let nextEnclosing = enclosing;

    switch (node.type) {
      case 'import_statement': {
        const source = stringLiteral(node.childForFieldName('source'));
        if (source != null && matchesPackage(source, packageName)) {
          bindings.push(...importBindings(node, line(node)));
        }
        break;
      }
      case 'function_declaration':
      case 'generator_function_declaration': {
        const name = node.childForFieldName('name')?.text ?? null;
        if (name) {
          functions.push(fn(name, node));
          nextEnclosing = name;
        }
        break;
      }
      case 'method_definition': {
        const name = node.childForFieldName('name')?.text ?? null;
        if (name) {
          functions.push(fn(name, node));
          nextEnclosing = name;
        }
        break;
      }
      case 'variable_declarator': {
        // `const wrap = (q) => …` and `const wrap = function (q) {…}` are declarations of a
        // named function as far as a caller is concerned, and callers are what the closure
        // follows. Treating them as anonymous would break every arrow-function wrapper.
        const value = node.childForFieldName('value');
        const name = node.childForFieldName('name')?.text ?? null;
        if (name && value && (value.type === 'arrow_function' || value.type === 'function_expression')) {
          functions.push(fn(name, node));
          nextEnclosing = name;
        }
        break;
      }
      case 'call_expression': {
        const callee = node.childForFieldName('function');
        const parsedCall = calleeParts(callee);
        if (parsedCall) {
          calls.push({ ...parsedCall, line: line(node), enclosing, text: node.text });
        }
        break;
      }
      default:
        break;
    }

    for (let i = 0; i < node.childCount; i += 1) {
      const child = node.child(i);
      if (child) visit(child, nextEnclosing);
    }
  };

  visit(root, null);
  return { path: file.path, bindings, functions, calls };

  function fn(name: string, node: SyntaxNode): FnDecl {
    return { name, startLine: line(node), endLine: node.endPosition.row + 1, text: node.text };
  }
}

/** `import * as m from 'p'`, `import { a as b }`, `import d from 'p'` — all three matter. */
function importBindings(node: SyntaxNode, atLine: number): Binding[] {
  const out: Binding[] = [];
  const statement = node.text;
  const add = (local: string, imported: string): void => {
    out.push({ local, imported, line: atLine, statement });
  };

  const stack: SyntaxNode[] = [node];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.type === 'namespace_import') {
      // `import * as m` — every member access on `m` is a package symbol.
      const alias = lastIdentifier(current);
      if (alias) add(alias, '*');
    } else if (current.type === 'import_specifier') {
      const name = current.childForFieldName('name')?.text;
      const alias = current.childForFieldName('alias')?.text;
      if (name) add(alias ?? name, name);
    } else if (current.type === 'import_clause') {
      // A bare identifier directly under the clause is the default import.
      for (let i = 0; i < current.childCount; i += 1) {
        const child = current.child(i);
        if (child?.type === 'identifier') add(child.text, 'default');
      }
    }
    for (let i = 0; i < current.childCount; i += 1) {
      const child = current.child(i);
      if (child) stack.push(child);
    }
  }
  return out;
}

function calleeParts(callee: SyntaxNode | null): { base: string; member: string | null } | null {
  if (!callee) return null;
  if (callee.type === 'identifier') return { base: callee.text, member: null };
  if (callee.type === 'member_expression') {
    const object = callee.childForFieldName('object');
    const property = callee.childForFieldName('property');
    if (!object || !property) return null;
    // `a.b.c()` — the base is the leftmost identifier, which is what a binding can match.
    const base = object.type === 'identifier' ? object.text : leftmostIdentifier(object);
    if (!base) return null;
    return { base, member: property.text };
  }
  return null;
}

// ── the closure ───────────────────────────────────────────────────────────────

/**
 * Walks outward from the package's imports until nothing new is reached, or `maxHop`.
 *
 * Hop 0 is a call that lands on an imported binding. The function containing it is a wrapper at
 * hop 0; calls to *that* function are hop 1, and so on. The loop terminates on its own once no
 * new wrapper names appear, which is the usual case well before hop 3 — `maxHop` is a guard
 * against a cyclic call graph, not the normal exit.
 */
function closure(
  facts: readonly FileFacts[],
  maxHop: number,
): { calls: AffectedCall[]; wrappersByHop: Map<string, number> } {
  const calls: AffectedCall[] = [];
  const wrappersByHop = new Map<string, number>();
  const seen = new Set<string>();

  // Hop 0: calls that resolve to an import of the migrated package.
  for (const file of facts) {
    const byLocal = new Map(file.bindings.map((b) => [b.local, b]));
    for (const call of file.calls) {
      const binding = byLocal.get(call.base);
      if (!binding) continue;
      // `m.search()` with `import * as m` resolves to the member; `search()` with a named
      // import resolves to the binding itself.
      const symbol = binding.imported === '*' ? (call.member ?? call.base) : binding.imported;
      const via = binding.local === symbol && binding.imported !== '*' ? 'direct' : 'alias';
      push({ file: file.path, line: call.line, symbol, via, hop: 0, enclosing: call.enclosing });
    }
  }

  let frontier = wrapperNames(calls, 0);
  for (const name of frontier) if (!wrappersByHop.has(name)) wrappersByHop.set(name, 0);

  for (let hop = 1; hop <= maxHop && frontier.size > 0; hop += 1) {
    const reached: AffectedCall[] = [];
    for (const file of facts) {
      for (const call of file.calls) {
        // A wrapper is called by name. `obj.method()` is only followed when the method name
        // itself is a known wrapper, which is the same name-based resolution as everywhere else.
        const target = call.member ?? call.base;
        if (!frontier.has(target)) continue;
        // Do not follow a function into itself: direct recursion would otherwise consume a hop
        // per level and crowd out real callers.
        if (call.enclosing === target) continue;
        const symbolOf = symbolFor(calls, target);
        if (!symbolOf) continue;
        reached.push({
          file: file.path,
          line: call.line,
          symbol: symbolOf,
          via: 'wrapper',
          hop,
          enclosing: call.enclosing,
        });
      }
    }
    const added = reached.filter((call) => push(call));
    const next = wrapperNames(added, hop);
    for (const name of next) if (!wrappersByHop.has(name)) wrappersByHop.set(name, hop);
    // Only names not already followed, or a mutually recursive pair loops until maxHop.
    frontier = new Set([...next].filter((name) => wrappersByHop.get(name) === hop));
  }

  return { calls, wrappersByHop };

  function push(call: AffectedCall): boolean {
    const key = `${call.file}\u0000${call.line}\u0000${call.symbol}`;
    if (seen.has(key)) return false;
    seen.add(key);
    calls.push(call);
    return true;
  }
}

function wrapperNames(calls: readonly AffectedCall[], hop: number): Set<string> {
  const names = new Set<string>();
  for (const call of calls) {
    if (call.hop === hop && call.enclosing) names.add(call.enclosing);
  }
  return names;
}

/** Which package symbol a wrapper ultimately reaches. First one wins; it is only a label. */
function symbolFor(calls: readonly AffectedCall[], wrapper: string): string | null {
  for (const call of calls) {
    if (call.enclosing === wrapper) return call.symbol;
  }
  return null;
}

// ── chunk rendering and enrichment ────────────────────────────────────────────

/**
 * §M.5.4 deviation, recorded.
 *
 * The PRD says "one chunk per function / method / arrow-function declaration", full stop. Taken
 * literally across a real repository that is every function in the tree, which would bury the
 * signal in the `code` namespace the same way 1 Hz activity text would bury real events in
 * `turns` (§M.1.4) — and the namespace exists to rank call sites, not to hold the repo.
 *
 * So functions are chunked in *relevant* files only: files that import the package, or that
 * contain a call the closure reached. A function in a file with neither cannot be a call site
 * or a wrapper, by construction, because the closure has already run.
 */
function render(
  facts: readonly FileFacts[],
  calls: readonly AffectedCall[],
  wrappersByHop: Map<string, number>,
  packageName: string,
): Chunk[] {
  const chunks: Chunk[] = [];
  const callsByFile = new Map<string, AffectedCall[]>();
  for (const call of calls) {
    const list = callsByFile.get(call.file) ?? [];
    list.push(call);
    callsByFile.set(call.file, list);
  }

  for (const file of facts) {
    const fileCalls = callsByFile.get(file.path) ?? [];
    const relevant = file.bindings.length > 0 || fileCalls.length > 0;
    if (!relevant) continue;

    for (const binding of dedupeImports(file.bindings)) {
      chunks.push({
        file: file.path,
        startLine: binding.line,
        endLine: binding.line,
        symbol: binding.imported === '*' ? binding.local : binding.imported,
        kind: 'import',
        hop: 0,
        enrichedText: [
          `// imports ${describeImport(binding, packageName)} in ${file.path}`,
          binding.statement,
        ].join('\n'),
      });
    }

    for (const call of fileCalls) {
      const source = file.calls.find((c) => c.line === call.line)?.text ?? '';
      chunks.push({
        file: file.path,
        startLine: call.line,
        endLine: call.line,
        symbol: call.symbol,
        kind: 'call',
        hop: call.hop,
        enrichedText: [callHeader(call, file, packageName), source].join('\n'),
      });
    }

    for (const declaration of file.functions) {
      const hop = wrappersByHop.get(declaration.name);
      const isWrapper = hop != null;
      chunks.push({
        file: file.path,
        startLine: declaration.startLine,
        endLine: declaration.endLine,
        symbol: declaration.name,
        kind: isWrapper ? 'derived_wrapper' : 'function',
        hop: hop ?? 0,
        enrichedText: [
          isWrapper
            ? `// wrapper: ${declaration.name} reaches ${packageName} at hop ${hop} in ${file.path}`
            : `// function ${declaration.name} in ${file.path}`,
          declaration.text,
        ].join('\n'),
      });
    }
  }

  return chunks;
}

/**
 * The resolved-context header — the line §M.5.4 specifies, and the reason an alias is findable.
 *
 * It names the package symbol, the local alias, the import that created it and the enclosing
 * function, so the embedded text says what the code *does* rather than what it spells.
 */
function callHeader(call: AffectedCall, file: FileFacts, packageName: string): string {
  const parts = [`// calls ${packageName}#${call.symbol}`];
  if (call.via === 'wrapper') {
    parts.push(`via a local wrapper (hop ${call.hop})`);
  } else {
    const binding = file.bindings.find(
      (b) => b.imported === call.symbol || b.imported === '*',
    );
    if (binding && binding.local !== call.symbol) {
      parts.push(`via local alias "${binding.local}" (${collapse(binding.statement)})`);
    }
  }
  if (call.enclosing) parts.push(`in fn ${call.enclosing}`);
  return `${parts.join(' ')} — ${file.path}:${call.line}`;
}

function describeImport(binding: Binding, packageName: string): string {
  if (binding.imported === '*') return `all of ${packageName} as "${binding.local}"`;
  if (binding.imported === 'default') return `the default export of ${packageName} as "${binding.local}"`;
  if (binding.local !== binding.imported) {
    return `${binding.imported} from ${packageName} as "${binding.local}"`;
  }
  return `${binding.imported} from ${packageName}`;
}

/** One import statement can bind several names; the chunk is per binding, per line, once. */
function dedupeImports(bindings: readonly Binding[]): Binding[] {
  const seen = new Set<string>();
  const out: Binding[] = [];
  for (const binding of bindings) {
    const key = `${binding.line}\u0000${binding.local}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(binding);
  }
  return out;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function matchesPackage(source: string, packageName: string): boolean {
  // `@moss-js/moss` and `@moss-js/moss/session` are the same package for migration purposes.
  return source === packageName || source.startsWith(`${packageName}/`);
}

function line(node: SyntaxNode): number {
  return node.startPosition.row + 1;
}

function stringLiteral(node: SyntaxNode | null): string | null {
  if (!node) return null;
  return node.text.replace(/^['"`]|['"`]$/g, '');
}

function lastIdentifier(node: SyntaxNode): string | null {
  let found: string | null = null;
  const stack: SyntaxNode[] = [node];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.type === 'identifier') found = current.text;
    for (let i = 0; i < current.childCount; i += 1) {
      const child = current.child(i);
      if (child) stack.push(child);
    }
  }
  return found;
}

function leftmostIdentifier(node: SyntaxNode): string | null {
  let current: SyntaxNode | null = node;
  while (current) {
    if (current.type === 'identifier') return current.text;
    current = current.childForFieldName('object') ?? current.child(0);
  }
  return null;
}
