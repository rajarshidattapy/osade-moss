import { useEffect, useState, type JSX } from 'react';

import type { TaskView } from '@osade/contract';

import { api } from './api.js';

/**
 * Opening a pull request — OSADE.md §11.2 and §11.3.
 *
 * This does not open a PR. It **requests a gate**, which appears at the top of the ledger for
 * a human to approve, deny or edit. Nothing reaches GitHub until then, and the approval is
 * bound to the exact title and body shown here.
 *
 * §11.3 — the fork plan is fetched and shown *before* the request, because the spec is
 * explicit that push permission is checked before offering the action rather than after.
 */

interface Plan {
  viaFork: boolean;
  head: string;
  target: string;
  base: string;
  title: string;
  body: string;
}

export function PrOpen({ task, lanes }: { task: TaskView; lanes?: TaskView[] }): JSX.Element {
  const choices = lanes && lanes.length > 1 ? lanes : [task];
  const [picked, setPicked] = useState(task.task.id);
  const active = choices.find((l) => l.task.id === picked) ?? task;
  const [plan, setPlan] = useState<Plan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [title, setTitle] = useState(task.task.title);
  const [body, setBody] = useState('');
  const [draft, setDraft] = useState(false);
  const [requested, setRequested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPicked(task.task.id);
  }, [task.task.id]);

  useEffect(() => {
    let cancelled = false;
    setPlan(null);
    setPlanError(null);
    setRequested(false);
    api.prPlan(active.task.id).then(
      (p) => {
        if (!cancelled) {
          setPlan(p);
          if (p.title) setTitle(p.title);
          if (p.body) setBody(p.body);
        }
      },
      (err: Error) => {
        if (!cancelled) setPlanError(err.message);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [active.task.id]);

  if (active.scm?.pr_number != null) {
    return (
      <p style={{ fontSize: 'var(--t-xs)' }}>
        Pull request{' '}
        <a href={active.scm.pr_url ?? '#'} style={{ color: 'var(--st-live)' }}>
          #{active.scm.pr_number}
        </a>{' '}
        is open.
      </p>
    );
  }

  // §11.3 — no push access and no fork. Say what is blocking and what would unblock it,
  // rather than offering a button that would 403.
  if (planError) {
    return (
      <div style={{ fontSize: 'var(--t-xs)' }}>
        <p className="mono" style={{ color: 'var(--st-fail)' }}>
          {planError}
        </p>
      </div>
    );
  }

  if (!plan) return <p style={{ fontSize: 'var(--t-xs)', color: 'var(--ink-soft)' }}>Checking…</p>;

  if (requested) {
    // §14.2 — the gate card is at the top of the ledger. Point there rather than duplicating
    // approve/deny controls in two places.
    return (
      <p style={{ fontSize: 'var(--t-xs)', color: 'var(--st-needs)' }}>
        Requested. Approve it at the top of the ledger — nothing is sent to GitHub until you do.
      </p>
    );
  }

  const verifyBlocks = active.status === 'verify_failed';

  return (
    <div style={{ fontSize: 'var(--t-xs)' }}>
      {choices.length > 1 && (
        <label style={{ display: 'block', marginBottom: 8 }}>
          <span style={{ color: 'var(--ink-soft)' }}>Lane</span>
          <select
            value={active.task.id}
            onChange={(event) => setPicked(event.target.value)}
            style={{ display: 'block', width: '100%', marginTop: 2 }}
          >
            {choices.map((lane) => (
              <option key={lane.task.id} value={lane.task.id}>
                {lane.agentId} · {lane.task.branch}
              </option>
            ))}
          </select>
        </label>
      )}
      <p style={{ color: 'var(--ink-soft)', margin: '0 0 8px' }}>
        <span className="mono">{plan.head}</span> → <span className="mono">{plan.target}</span>:
        <span className="mono"> {plan.base}</span>
        {plan.viaFork && ' (via your fork)'}
      </p>

      {verifyBlocks && (
        <p style={{ color: 'var(--st-fail)', margin: '0 0 8px' }}>
          Verification is failing. §10.2 makes it a policy default that this is fixed first.
        </p>
      )}

      <label style={{ display: 'block', marginBottom: 6 }}>
        <span style={{ color: 'var(--ink-soft)' }}>Title</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          style={inputStyle}
        />
      </label>

      <label style={{ display: 'block', marginBottom: 6 }}>
        <span style={{ color: 'var(--ink-soft)' }}>Description</span>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={6}
          style={{ ...inputStyle, resize: 'vertical' }}
        />
      </label>

      <label
        style={{ display: 'flex', gap: 6, alignItems: 'center', color: 'var(--ink-soft)' }}
      >
        <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
        Open as a draft
      </label>

      {error && (
        <p className="mono" style={{ color: 'var(--st-fail)' }}>
          {error}
        </p>
      )}

      <button
        disabled={busy || title.trim().length === 0}
        style={buttonStyle}
        onClick={() => {
          setBusy(true);
          setError(null);
          api.prOpenRequest(active.task.id, title, body, draft).then(
            () => {
              setRequested(true);
              setBusy(false);
            },
            (err: Error) => {
              setError(err.message);
              setBusy(false);
            },
          );
        }}
      >
        {/* §19.4 — an action keeps its name through the whole flow. */}
        Open pull request
      </button>
      <p style={{ color: 'var(--ink-soft)', margin: '6px 0 0' }}>
        This asks for your approval first. Osade never opens a pull request on its own.
      </p>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  marginTop: 2,
  padding: '5px 7px',
  border: '1px solid var(--rule)',
  borderRadius: 'var(--radius)',
  background: 'var(--paper)',
  color: 'var(--ink)',
  font: 'inherit',
  fontSize: 'var(--t-xs)',
};

const buttonStyle: React.CSSProperties = {
  marginTop: 10,
  padding: '5px 12px',
  border: '1px solid var(--rule)',
  borderRadius: 'var(--radius)',
  background: 'var(--field)',
  color: 'var(--ink)',
  font: 'inherit',
  cursor: 'pointer',
};
