import { useState, type JSX } from 'react';

import type { GateRequest, TaskView } from '@osade/contract';

import { api } from './api.js';
import { chord } from './chords.js';

/**
 * The gate card — OSADE.md §14.2.
 *
 * Gate requests are the top of the ledger, above everything else. A card shows: the exact
 * action, a rendered diff or the exact comment text, which task it came from, the verification
 * state, and Approve / Deny / Edit-and-approve.
 *
 * **Editing rewrites the payload and re-hashes** (§11.2), so an approval is bound to the exact
 * bytes shown here rather than to whatever is executed later.
 *
 * §14.2 — batch approval is allowed for `gate.commit` only. Never batch a public write, which
 * is why there is no select-all here.
 */

/** Public writes get a heavier treatment: this is speech in someone else's space. */
const PUBLIC_WRITES = new Set([
  'gate.pr_open',
  'gate.pr_update',
  'gate.pr_comment',
  'gate.issue_comment',
  'gate.review_submit',
]);

export function GateCard({
  gate,
  task,
  onDecided,
}: {
  gate: GateRequest;
  task: TaskView;
  onDecided: () => void;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => pretty(gate.payload_json));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isPublic = PUBLIC_WRITES.has(gate.gate);
  // §10.2 — verification is required before gate.pr_open can be approved. Surfaced rather
  // than enforced here: the daemon owns the policy, the UI explains it.
  const verifyBlocks = gate.gate === 'gate.pr_open' && task.status === 'verify_failed';

  async function run(action: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await action();
      onDecided();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    // No box of its own: whatever renders this already frames it (the detail pane puts it on a
    // tinted band with an amber edge). A card inside a highlighted region is two frames saying
    // the same thing.
    <section style={{ marginBottom: 12 }} data-gate-id={gate.id}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8 }}>
        <span className="mono" style={{ color: 'var(--st-needs)' }}>
          ⚑
        </span>
        <strong>{describe(gate.gate)}</strong>
        <span style={{ color: 'var(--ink-soft)', fontSize: 'var(--t-xs)' }}>
          {task.task.title}
        </span>
      </header>

      {isPublic && (
        <p style={{ color: 'var(--st-needs)', fontSize: 'var(--t-xs)', margin: '0 0 8px' }}>
          This leaves your machine and is published under your name.
        </p>
      )}

      {verifyBlocks && (
        <p style={{ color: 'var(--st-fail)', fontSize: 'var(--t-xs)', margin: '0 0 8px' }}>
          Verification is failing for this task.
        </p>
      )}

      {editing ? (
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          rows={10}
          className="mono"
          style={{
            width: '100%',
            fontSize: 'var(--t-xs)',
            padding: 8,
            border: '1px solid var(--rule)',
            borderRadius: 'var(--radius)',
            background: 'var(--paper)',
            color: 'var(--ink)',
            resize: 'vertical',
          }}
        />
      ) : (
        <Payload json={gate.payload_json} />
      )}

      {error && (
        <p style={{ color: 'var(--st-fail)', fontSize: 'var(--t-xs)' }} className="mono">
          {error}
        </p>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        {editing ? (
          <>
            <button
              className="primary"
              disabled={busy}
              onClick={() => void run(() => api.gateEditAndApprove(gate.id, parse(draft)))}
            >
              Approve edited
            </button>
            <button disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </>
        ) : (
          <>
            {/* §19.4 — an action keeps its name through the whole flow. */}
            <button
              className="primary"
              disabled={busy}
              onClick={() => void run(() => api.gateDecide(gate.id, 'approve'))}
            >
              {approveLabel(gate.gate)} <kbd>{chord('enter')}</kbd>
            </button>
            <button disabled={busy} onClick={() => void run(() => api.gateDecide(gate.id, 'deny'))}>
              Deny <kbd>{chord('backspace')}</kbd>
            </button>
            <button disabled={busy} onClick={() => setEditing(true)}>
              Edit
            </button>
          </>
        )}
      </div>

      <p style={{ color: 'var(--ink-soft)', fontSize: 'var(--t-xs)', margin: '8px 0 0' }}>
        Approving binds this exact text. If it changes before it runs, Osade refuses it.
      </p>
    </section>
  );
}

/** §19.4 — the button that says "Open pull request" produces "Pull request opened". */
function approveLabel(gate: string): string {
  switch (gate) {
    case 'gate.pr_open':
      return 'Open pull request';
    case 'gate.push':
      return 'Push';
    case 'gate.pr_comment':
    case 'gate.issue_comment':
      return 'Post comment';
    case 'gate.review_submit':
      return 'Submit review';
    case 'gate.undo_turn':
      return 'Undo turn';
    case 'gate.branch_switch':
      return 'Switch branch';
    case 'gate.commit':
      return 'Commit';
    default:
      return 'Approve';
  }
}

function describe(gate: string): string {
  return approveLabel(gate) === 'Approve' ? gate.replace('gate.', '') : approveLabel(gate);
}

/**
 * What is about to be sent, as a person would read it.
 *
 * This used to be pretty-printed JSON, which asks a maintainer to parse `{"head": "...", "base":
 * "..."}` in their head to decide whether to publish under their own name. The bytes are still
 * exactly what is bound (§11.2) — this is a reading of them, and `Edit` still shows the JSON,
 * because editing the thing that gets hashed should show the thing that gets hashed.
 */
function Payload({ json }: { json: string }): JSX.Element {
  let value: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      value = parsed as Record<string, unknown>;
    }
  } catch {
    value = null;
  }

  const box: React.CSSProperties = {
    background: 'var(--paper)',
    border: '1px solid var(--rule)',
    borderRadius: 'var(--radius)',
    padding: '10px 12px',
    maxHeight: 300,
    overflow: 'auto',
  };

  // Anything unrecognised falls back to the raw text rather than guessing at a shape.
  if (!value) {
    return (
      <pre className="mono" style={{ ...box, margin: 0, fontSize: 'var(--t-xs)', whiteSpace: 'pre-wrap' }}>
        {pretty(json)}
      </pre>
    );
  }

  const title = typeof value.title === 'string' ? value.title : null;
  const body = typeof value.body === 'string' ? value.body : null;
  const head = typeof value.head === 'string' ? value.head : null;
  const base = typeof value.base === 'string' ? value.base : null;
  const draft = value.draft === true;

  return (
    <div style={box}>
      {title && (
        <div style={{ fontSize: 'var(--t-m)', fontWeight: 600, lineHeight: 1.3 }}>{title}</div>
      )}
      {body && (
        <p style={{ margin: title ? '6px 0 0' : 0, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
          {body}
        </p>
      )}
      {head && base && (
        <p className="mono" style={{ margin: '10px 0 0', fontSize: 'var(--t-xs)', color: 'var(--ink-soft)' }}>
          {head} → {base}
          {draft ? '  ·  as a draft' : ''}
        </p>
      )}
      {!title && !body && (
        <pre className="mono" style={{ margin: 0, fontSize: 'var(--t-xs)', whiteSpace: 'pre-wrap' }}>
          {pretty(json)}
        </pre>
      )}
    </div>
  );
}

function pretty(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Let the daemon reject it rather than guessing at a shape here.
    return text;
  }
}
