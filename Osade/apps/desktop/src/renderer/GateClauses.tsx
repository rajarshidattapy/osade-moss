import { useEffect, useState, type JSX } from 'react';

import type { GateClauseView } from '@osade/contract';

import { api } from './api.js';

/**
 * The policy clauses a gate's diff touches — OSADE-MOSS §M.8.3.
 *
 * Every clause is cited: its ref, the policy file it came from, and that file's hash at the time
 * it was read (C1). Only a clause whose author wrote `requires_ack: true` can hold the approve
 * button (C2); the rest are shown for the reader's benefit and cost nothing to ignore.
 *
 * The daemon refuses an approval with acks outstanding regardless of what this renders — the
 * disabled button explains the refusal before it happens, it does not implement it.
 */
export function useGateClauses(gateId: string): {
  view: GateClauseView | null;
  setView: (view: GateClauseView) => void;
} {
  const [view, setView] = useState<GateClauseView | null>(null);
  useEffect(() => {
    let cancelled = false;
    setView(null);
    // A daemon without the clause service answers with an error; that simply means no clauses.
    api.gateClauses(gateId).then(
      (next) => {
        if (!cancelled) setView(next);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [gateId]);
  return { view, setView };
}

export function GateClauses({
  view,
  onChange,
}: {
  view: GateClauseView;
  onChange: (view: GateClauseView) => void;
}): JSX.Element | null {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rows = view.hunks.flatMap((hunk) =>
    hunk.clauses.map((clause) => ({ hunk: hunk.hunk_ref, clause })),
  );
  if (rows.length === 0) return null;

  async function ack(clauseId: string): Promise<void> {
    setBusy(clauseId);
    setError(null);
    try {
      onChange(await api.gateClauseAck(view.gate_id, clauseId));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section data-gate-clauses style={{ margin: '10px 0 0' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 8,
          fontSize: 'var(--t-xs)',
          color: 'var(--ink-2)',
          marginBottom: 6,
        }}
      >
        <span>Policy clauses this change touches</span>
        {view.outstandingAcks > 0 && (
          <span style={{ color: 'var(--st-needs)' }}>
            {view.outstandingAcks} to acknowledge before approving
          </span>
        )}
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {rows.map(({ hunk, clause }) => {
          const acked = clause.acked_at != null;
          return (
            <li
              key={`${hunk}-${clause.clause_id}`}
              style={{
                borderLeft: `2px solid ${
                  clause.requires_ack && !acked ? 'var(--st-needs)' : 'var(--line)'
                }`,
                padding: '4px 0 6px 10px',
                marginBottom: 4,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                <span className="mono" style={{ fontSize: 'var(--t-xs)' }}>
                  {clause.clause_ref}
                </span>
                <strong style={{ fontSize: 'var(--t-s)' }}>{clause.title}</strong>
                <span className="mono" style={{ fontSize: 'var(--t-xs)', color: 'var(--ink-3)' }}>
                  {hunk}
                </span>
              </div>
              <p style={{ margin: '2px 0 4px', fontSize: 'var(--t-s)', lineHeight: 1.5 }}>
                {clause.text}
              </p>
              <div
                className="mono"
                title={`sha ${clause.file_sha}`}
                style={{ fontSize: 'var(--t-xs)', color: 'var(--ink-3)' }}
              >
                {clause.policy_path} @ {clause.file_sha.slice(0, 8)}
              </div>
              {clause.requires_ack &&
                (acked ? (
                  <div style={{ fontSize: 'var(--t-xs)', color: 'var(--st-live)', marginTop: 4 }}>
                    Acknowledged by {clause.acked_by ?? 'someone'}
                  </div>
                ) : (
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      fontSize: 'var(--t-xs)',
                      marginTop: 4,
                      cursor: busy ? 'progress' : 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      data-ack={clause.clause_id}
                      checked={false}
                      disabled={busy != null}
                      onChange={() => void ack(clause.clause_id)}
                      style={{ width: 'auto', margin: 0 }}
                    />
                    I have read this clause and the change complies with it
                  </label>
                ))}
            </li>
          );
        })}
      </ul>
      {error && (
        <p className="mono" style={{ color: 'var(--st-fail)', fontSize: 'var(--t-xs)', margin: '4px 0 0' }}>
          {error}
        </p>
      )}
    </section>
  );
}
