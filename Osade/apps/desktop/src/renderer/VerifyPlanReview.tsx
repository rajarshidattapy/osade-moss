import { useEffect, useState, type CSSProperties, type JSX } from 'react';

import type { VerifyRun } from '@osade/contract';

import { api, type PlanStep } from './api.js';
import { checksAttach, type ComposerAttach } from './compose-attach.js';

/**
 * The verification plan review — OSADE.md §10.1.
 *
 * INVARIANT: the plan is **shown to the user and editable before first use**. Never run an
 * inferred command silently the first time. This component is the reason the daemon refuses to
 * run a plan whose `needsReview` is still set — the two halves of the same rule.
 *
 * Each step shows its `source` and `evidence`, because a plan derived from evidence is only
 * trustworthy if you can see the evidence.
 */

const SOURCE_LABEL: Record<PlanStep['source'], string> = {
  ci: 'CI',
  manifest: 'manifest',
  doc: 'docs',
  user: 'you',
  agent: 'agent',
};

const emptyStep = (): PlanStep => ({
  name: 'check',
  cmd: '',
  cwd: '.',
  timeoutSec: 600,
  required: true,
  source: 'user',
  evidence: 'added in Checks',
});

export function VerifyPlanReview({
  taskId,
  runs = [],
  onAttach,
}: {
  taskId: string;
  runs?: VerifyRun[];
  onAttach?: (attach: ComposerAttach | null) => void;
}): JSX.Element {
  const [steps, setSteps] = useState<PlanStep[] | null>(null);
  const [needsReview, setNeedsReview] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [focus, setFocus] = useState(0);
  const [logTail, setLogTail] = useState('');

  useEffect(() => {
    let cancelled = false;
    void api
      .verifyPlanGet(taskId)
      .then((plan) => {
        if (cancelled || !plan) {
          if (!cancelled) setSteps([]);
          return;
        }
        setSteps(plan.steps);
        setNeedsReview(plan.needsReview);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  const focused = steps?.[focus] ?? steps?.[0] ?? null;
  const focusedRun = focused
    ? runs.find((run) => run.step_name === focused.name) ?? null
    : null;

  useEffect(() => {
    if (!focusedRun) {
      setLogTail('');
      return;
    }
    let cancelled = false;
    void api
      .verifyRunLog(focusedRun.id)
      .then((log) => {
        if (!cancelled) setLogTail(log.text);
      })
      .catch(() => {
        if (!cancelled) setLogTail('');
      });
    return () => {
      cancelled = true;
    };
  }, [focusedRun?.id]);

  useEffect(() => {
    if (!onAttach) return;
    if (!focused) {
      onAttach(null);
      return;
    }
    onAttach(checksAttach(focused.name, logTail));
  }, [onAttach, focused?.name, logTail]);

  async function run<T>(action: () => Promise<T>, after?: (value: T) => void): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      after?.(await action());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const list = steps ?? [];

  return (
    <div style={{ padding: '8px 0' }}>
      {needsReview && list.length > 0 && (
        <p style={{ color: 'var(--st-needs)', fontSize: 'var(--t-xs)', margin: '0 0 8px' }}>
          Review this before it runs. Osade inferred it and has not run any of it yet.
        </p>
      )}

      {list.map((step, i) => (
        <div
          key={`${step.name}-${i}`}
          onClick={() => setFocus(i)}
          style={{
            padding: '6px 0',
            borderBottom: '1px solid var(--rule)',
            borderLeft: i === focus ? '2px solid var(--focus)' : '2px solid transparent',
            paddingLeft: 8,
            cursor: 'pointer',
          }}
        >
          <input
            className="mono"
            value={step.name}
            onChange={(event) => patch(i, { name: event.target.value })}
            style={{ ...fieldStyle, width: 140, marginRight: 8 }}
          />
          <input
            className="mono"
            value={step.cmd}
            onChange={(event) => patch(i, { cmd: event.target.value, source: 'user' })}
            style={{ ...fieldStyle, width: '50%' }}
          />
          <div style={{ color: 'var(--ink-soft)', fontSize: 'var(--t-xs)', marginTop: 4 }}>
            {SOURCE_LABEL[step.source] ?? step.source}
            {step.evidence ? ` · ${step.evidence}` : ''}
            <label style={{ marginLeft: 10 }}>
              <input
                type="checkbox"
                checked={step.required}
                onChange={(event) => patch(i, { required: event.target.checked })}
              />{' '}
              required
            </label>
            <button type="button" style={{ ...buttonStyle, marginLeft: 8 }} onClick={() => remove(i)}>
              Remove
            </button>
          </div>
        </div>
      ))}

      {error && <Err message={error} />}
      {result && (
        <p className="mono" style={{ fontSize: 'var(--t-xs)' }}>
          {result}
        </p>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <button
          disabled={busy}
          style={buttonStyle}
          onClick={() =>
            void run(
              () => api.verifyPlanDerive(taskId),
              (plan) => {
                setSteps(plan.steps);
                setNeedsReview(plan.needsReview);
              },
            )
          }
        >
          Detect checks
        </button>
        <button
          type="button"
          style={buttonStyle}
          onClick={() => {
            setSteps([...list, emptyStep()]);
            setFocus(list.length);
            setNeedsReview(true);
          }}
        >
          Add
        </button>
        <button
          disabled={busy || list.length === 0}
          style={buttonStyle}
          onClick={() =>
            void run(
              () => api.verifyPlanConfirm(taskId, list),
              () => setNeedsReview(false),
            )
          }
        >
          {needsReview ? 'Confirm plan' : 'Save changes'}
        </button>
        <button
          disabled={busy || needsReview || list.length === 0}
          title={needsReview ? 'Confirm the plan before running it' : undefined}
          style={buttonStyle}
          onClick={() =>
            void run(
              () => api.verifyRun(taskId),
              (r) => setResult(r.passed ? 'Verification passed.' : 'Verification failed.'),
            )
          }
        >
          Run verification
        </button>
      </div>
    </div>
  );

  function patch(index: number, over: Partial<PlanStep>): void {
    setSteps((current) => {
      const next = [...(current ?? [])];
      const row = next[index];
      if (!row) return current;
      next[index] = { ...row, ...over };
      return next;
    });
    setNeedsReview(true);
  }

  function remove(index: number): void {
    setSteps((current) => (current ?? []).filter((_, i) => i !== index));
    setNeedsReview(true);
  }
}

function Err({ message }: { message: string }): JSX.Element {
  return (
    <p className="mono" style={{ color: 'var(--st-fail)', fontSize: 'var(--t-xs)' }}>
      {message}
    </p>
  );
}

const fieldStyle: CSSProperties = {
  font: 'inherit',
  fontSize: 'var(--t-xs)',
  background: 'var(--bg-2)',
  color: 'var(--ink)',
  border: '0.5px solid var(--line)',
  padding: '2px 6px',
};

const buttonStyle: CSSProperties = {
  padding: '5px 12px',
  border: '1px solid var(--rule)',
  borderRadius: 'var(--radius)',
  background: 'var(--paper)',
  color: 'var(--ink)',
  font: 'inherit',
  cursor: 'pointer',
};
