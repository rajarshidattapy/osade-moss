import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * OSADE.md §20.1 — lint-enforced, not conventions.
 *
 * Every rule below is a *boundary* the spec calls load-bearing. They are lint failures rather
 * than review comments because a reviewer who misses one produces a class of bug that is
 * expensive to find later — and because "no status column" and "one event path" stop being
 * invariants the moment they depend on someone remembering.
 *
 * Each rule cites the section it enforces. If you are tempted to disable one, change the spec
 * first.
 *
 * **A note on `no-restricted-syntax`.** Flat config *replaces* a rule's options rather than
 * merging them, so a second config block naming the same rule silently discards the first
 * one's selectors. Every selector is therefore declared once below and composed per scope, and
 * `test/unit/lint-rules.test.ts` asserts each one actually fires. An invariant rule that is
 * quietly not applied is worse than no rule at all.
 */

const GENERATED = [
  '**/generated/**',
  '**/dist/**',
  '**/node_modules/**',
  'backend/**',
  // Packaging output: a copy of the built app, not source.
  'release/**',
];


// ── selectors, declared once ────────────────────────────────────────────────

/** §20.1 — env is read at use sites, not snapshotted at import time. */
const NO_ENV_DESTRUCTURE = {
  selector:
    'VariableDeclarator[id.type="ObjectPattern"][init.object.name="process"][init.property.name="env"]',
  message:
    'OSADE.md §20.1: do not destructure process.env — read it at the use site so late-set variables are visible.',
};

/**
 * The same rule, one property over.
 *
 * `import { argv } from 'node:process'` binds the array at import time. A runner that rewrites
 * argv — vite-node does — replaces `process.argv` wholesale, so the imported binding still points
 * at the array from *before* the rewrite, script path and all, and every argument lands one
 * place to the right. This shipped once: the `osade` bin read its own path as the command name,
 * so `--help` printed "unknown command group" and an unknown command exited 0.
 */
const NO_PROCESS_BINDING_IMPORT = {
  selector:
    'ImportDeclaration[source.value=/^(node:)?process$/] > ImportSpecifier[imported.name=/^(argv|env)$/]',
  message:
    'OSADE.md §20.1: do not import argv or env as bindings — read process.argv / process.env at the use site, because a runner can replace them after this module loads.',
};

/** §17 — one definition of the synthetic orchestrator id. */
const NO_RAW_ORCHESTRATOR_ID = {
  selector: 'Literal[value=/__orchestrator__/]',
  message:
    'OSADE.md §17: the synthetic orchestrator id is defined in exactly one place. Import it.',
};

/** §5.4 — no service emits a websocket message directly. */
const NO_DIRECT_WS_EMIT = {
  selector: 'CallExpression[callee.property.name="send"][callee.object.name="socket"]',
  message:
    'OSADE.md §5.4: no service emits a websocket message directly. Write to the database; the CDC broadcaster fans it out.',
};

/** §6 — status is derived at read time and never stored. */
const NO_STORED_STATUS = [
  {
    selector: 'Property[key.name="status"]',
    message:
      'OSADE.md §6: status is derived at read time and never stored. Add the underlying fact instead.',
  },
  {
    selector: 'Property[key.value="status"]',
    message:
      'OSADE.md §6: status is derived at read time and never stored. Add the underlying fact instead.',
  },
];

const BASE_SELECTORS = [NO_ENV_DESTRUCTURE, NO_PROCESS_BINDING_IMPORT, NO_RAW_ORCHESTRATOR_ID];

export default tseslint.config(
  { ignores: [...GENERATED, 'vendor/**', '**/*.d.ts'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      // §20.1 — no `any`.
      '@typescript-eslint/no-explicit-any': 'error',
      'no-restricted-syntax': ['error', ...BASE_SELECTORS],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // ── the daemon is a library, not a script (§20.1) ──────────────────────────
  {
    files: ['packages/daemon/src/**/*.ts'],
    ignores: ['packages/daemon/src/cli.ts'],
    rules: {
      'no-console': 'error',
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'exit',
          message:
            'OSADE.md §20.1: the daemon is a library. Throw; only cli.ts may exit the process.',
        },
      ],
      // §5.4 folded in, because this scope covers the daemon's services.
      'no-restricted-syntax': ['error', ...BASE_SELECTORS, NO_DIRECT_WS_EMIT],
    },
  },

  // The broadcaster and the listener that owns it are where emitting is the job.
  {
    files: [
      'packages/daemon/src/server/cdc-broadcaster.ts',
      'packages/daemon/src/server/index.ts',
    ],
    rules: { 'no-restricted-syntax': ['error', ...BASE_SELECTORS] },
  },

  // ── one boundary to the substrate (§4.2) ──────────────────────────────────
  //
  // The rule is about the *protocol*, not the facade. §4.2 says only `daemon/src/substrate/**` may
  // import the **generated** client or open the runtime socket — so domain code calling the typed
  // `SubstrateClient` is the boundary working as intended, and forbidding that would only push the
  // same coupling through a wrapper. What must not leak is (a) generated method names and
  // (b) raw socket access, so those are what is restricted.
  {
    files: ['packages/**/*.ts', 'apps/**/*.ts', 'apps/**/*.tsx'],
    ignores: ['packages/daemon/src/substrate/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'node:net',
              message:
                'OSADE.md §4.2: raw socket access to the substrate belongs in packages/daemon/src/substrate/**.',
            },
          ],
          patterns: [
            {
              group: ['**/substrate/generated/**'],
              message:
                'OSADE.md §4.2: only packages/daemon/src/substrate/** may import the generated substrate client. Use the SubstrateClient facade.',
            },
            {
              group: ['octokit', '@octokit/*'],
              message: 'OSADE.md §11: only packages/daemon/src/scm/** may import an SCM SDK.',
            },
          ],
        },
      ],
    },
  },

  // The daemon's own http/ws listener and Electron's supervisor open server sockets, not
  // the substrate sockets. §11's Octokit boundary is enforced separately below.
  {
    files: ['packages/daemon/src/server/**/*.ts', 'apps/desktop/src/main/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },

  // ── one boundary to GitHub (§11) ──────────────────────────────────────────
  {
    files: ['packages/daemon/src/scm/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },

  // ── no stored status, anywhere (§6) ───────────────────────────────────────
  // The database is checked mechanically by test/integration/cdc.test.ts; this catches the
  // other half — a fact object growing a status field on its way to the database.
  {
    files: ['packages/daemon/src/db/**/*.ts', 'packages/contract/src/facts.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...BASE_SELECTORS, ...NO_STORED_STATUS],
    },
  },

  // ── the synthetic orchestrator id lives in exactly one file (§17) ─────────
  {
    files: ['packages/contract/src/orchestrator-id.ts'],
    rules: { 'no-restricted-syntax': ['error', NO_ENV_DESTRUCTURE, NO_PROCESS_BINDING_IMPORT] },
  },

  // ── the renderer is never the source of truth (§18.1) ─────────────────────
  {
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/daemon/src/**', '@osade/daemon', '@osade/daemon/*'],
              message:
                'OSADE.md §18.1: the renderer imports the contract package only. It renders streamed state and never computes status.',
            },
          ],
        },
      ],
    },
  },

  // ── tests may reach further than product code ─────────────────────────────
  {
    files: ['**/test/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-syntax': 'off',
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  // ── build configuration is CommonJS on purpose ────────────────────────────
  // electron-builder loads its config with `require`, and the Electron main compiles to
  // CommonJS, so this one file is CJS in an ESM workspace. See the comment in it.
  {
    files: ['*.config.cjs', '**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { require: 'readonly', module: 'writable', __dirname: 'readonly' },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      'no-undef': 'off',
    },
  },

  // ── scripts are scripts ───────────────────────────────────────────────────
  {
    files: [
      'scripts/**/*.mjs',
      // Package-local scripts too. A script that needs a package's dependencies has to sit
      // beside them, because node resolves from the file's own location, not the cwd.
      'packages/*/scripts/**/*.mjs',
      'eslint.config.js',
      '**/vite.config.ts',
      'vitest.config.ts',
    ],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', URL: 'readonly' },
    },
    rules: {
      'no-console': 'off',
      'no-undef': 'off',
      'no-restricted-syntax': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
