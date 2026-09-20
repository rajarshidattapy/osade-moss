/**
 * Lightweight token colouring for the Files editor. Dark+ palette, no highlighter package.
 */

export type Tok = 'kw' | 'type' | 'str' | 'com' | 'num' | 'fn' | 'plain';

export interface Token {
  kind: Tok;
  text: string;
}

const JS_KW = new Set([
  'abstract',
  'as',
  'async',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'declare',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'from',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'infer',
  'instanceof',
  'interface',
  'is',
  'keyof',
  'let',
  'new',
  'null',
  'of',
  'package',
  'private',
  'protected',
  'public',
  'readonly',
  'return',
  'satisfies',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'type',
  'typeof',
  'undefined',
  'using',
  'var',
  'void',
  'while',
  'with',
  'yield',
]);

const PY_KW = new Set([
  'and',
  'as',
  'assert',
  'async',
  'await',
  'break',
  'class',
  'continue',
  'def',
  'del',
  'elif',
  'else',
  'except',
  'False',
  'finally',
  'for',
  'from',
  'global',
  'if',
  'import',
  'in',
  'is',
  'lambda',
  'None',
  'nonlocal',
  'not',
  'or',
  'pass',
  'raise',
  'return',
  'True',
  'try',
  'while',
  'with',
  'yield',
]);

const RS_KW = new Set([
  'as',
  'async',
  'await',
  'break',
  'const',
  'continue',
  'crate',
  'dyn',
  'else',
  'enum',
  'extern',
  'false',
  'fn',
  'for',
  'if',
  'impl',
  'in',
  'let',
  'loop',
  'match',
  'mod',
  'move',
  'mut',
  'pub',
  'ref',
  'return',
  'self',
  'Self',
  'static',
  'struct',
  'super',
  'trait',
  'true',
  'type',
  'unsafe',
  'use',
  'where',
  'while',
]);

type Family = 'js' | 'py' | 'rs' | 'json' | 'css' | 'md' | 'plain';

export function langOf(path: string): Family {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts'].includes(ext)) return 'js';
  if (ext === 'json' || ext === 'jsonc') return 'json';
  if (ext === 'css' || ext === 'scss') return 'css';
  if (ext === 'md' || ext === 'markdown') return 'md';
  if (ext === 'py') return 'py';
  if (ext === 'rs') return 'rs';
  if (['go', 'toml', 'yml', 'yaml', 'sh', 'bash', 'zsh'].includes(ext)) return 'js';
  return 'plain';
}

export function highlight(text: string, path: string): Token[] {
  if (text.length > 80_000) return [{ kind: 'plain', text }];
  const family = langOf(path);
  if (family === 'plain') return [{ kind: 'plain', text }];
  if (family === 'md') return markdown(text);
  if (family === 'json') return scan(text, new Set(['true', 'false', 'null']), { json: true });
  if (family === 'css') return scan(text, new Set(['from', 'to', 'and', 'or', 'not', 'only']), { css: true });
  if (family === 'py') return scan(text, PY_KW, { hash: true });
  if (family === 'rs') return scan(text, RS_KW, {});
  return scan(text, JS_KW, {});
}

function scan(
  text: string,
  keywords: Set<string>,
  opts: { json?: boolean; css?: boolean; hash?: boolean },
): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = text.length;

  function push(kind: Tok, start: number, end: number): void {
    if (end > start) out.push({ kind, text: text.slice(start, end) });
  }

  while (i < n) {
    const ch = text[i]!;

    if (opts.hash && ch === '#') {
      const start = i;
      while (i < n && text[i] !== '\n') i += 1;
      push('com', start, i);
      continue;
    }

    if (ch === '/' && text[i + 1] === '/') {
      const start = i;
      i += 2;
      while (i < n && text[i] !== '\n') i += 1;
      push('com', start, i);
      continue;
    }

    if (ch === '/' && text[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i = Math.min(n, i + 2);
      push('com', start, i);
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      const start = i;
      i += 1;
      while (i < n) {
        if (text[i] === '\\') {
          i += 2;
          continue;
        }
        if (text[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      push('str', start, i);
      continue;
    }

    if ((ch >= '0' && ch <= '9') || (ch === '.' && text[i + 1] !== undefined && text[i + 1]! >= '0' && text[i + 1]! <= '9')) {
      const start = i;
      while (i < n && /[0-9a-fA-FxX._]/u.test(text[i]!)) i += 1;
      push('num', start, i);
      continue;
    }

    if (/[A-Za-z_$]/u.test(ch)) {
      const start = i;
      i += 1;
      while (i < n && /[A-Za-z0-9_$]/u.test(text[i]!)) i += 1;
      const word = text.slice(start, i);
      let j = i;
      while (j < n && (text[j] === ' ' || text[j] === '\t')) j += 1;
      if (keywords.has(word)) push('kw', start, i);
      else if (text[j] === '(') push('fn', start, i);
      else if (word[0] !== undefined && word[0] >= 'A' && word[0] <= 'Z') push('type', start, i);
      else push('plain', start, i);
      continue;
    }

    const start = i;
    i += 1;
    while (
      i < n &&
      !/[A-Za-z_$0-9"'`#]/u.test(text[i]!) &&
      !(text[i] === '/' && (text[i + 1] === '/' || text[i + 1] === '*'))
    ) {
      i += 1;
    }
    push('plain', start, i);
  }

  return merge(out);
}

function markdown(text: string): Token[] {
  const out: Token[] = [];
  for (const line of text.split(/(?<=\n)/u)) {
    if (/^#{1,6}\s/u.test(line)) out.push({ kind: 'kw', text: line });
    else if (/^```/u.test(line)) out.push({ kind: 'type', text: line });
    else if (/^\s*[-*]\s/u.test(line) || /^\s*\d+\.\s/u.test(line)) out.push({ kind: 'fn', text: line });
    else out.push({ kind: 'plain', text: line });
  }
  return out.length === 0 ? [{ kind: 'plain', text }] : out;
}

function merge(tokens: Token[]): Token[] {
  const out: Token[] = [];
  for (const tok of tokens) {
    const last = out[out.length - 1];
    if (last && last.kind === tok.kind) last.text += tok.text;
    else out.push({ ...tok });
  }
  return out;
}

export type DiffKind = 'meta' | 'hunk' | 'add' | 'del' | 'ctx';

export function parseUnified(text: string): { kind: DiffKind; text: string }[] {
  if (!text) return [];
  return text.split('\n').map((line) => {
    if (
      line.startsWith('diff ') ||
      line.startsWith('index ') ||
      line.startsWith('---') ||
      line.startsWith('+++')
    ) {
      return { kind: 'meta' as const, text: line };
    }
    if (line.startsWith('@@')) return { kind: 'hunk' as const, text: line };
    if (line.startsWith('+')) return { kind: 'add' as const, text: line };
    if (line.startsWith('-')) return { kind: 'del' as const, text: line };
    return { kind: 'ctx' as const, text: line };
  });
}

export function flagColour(flag: 'M' | 'A' | 'D' | '?' | null): string | undefined {
  if (flag === 'D') return 'var(--st-fail)';
  if (flag === 'M') return 'var(--st-needs)';
  if (flag === 'A' || flag === '?') return 'var(--st-live)';
  return undefined;
}
