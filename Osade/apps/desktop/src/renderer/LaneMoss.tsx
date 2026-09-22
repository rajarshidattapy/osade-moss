import { useEffect, useState, type JSX } from 'react';

import type { CatchUpItem, CatchUpResult, ContextPack } from '@osade/contract';

import { api } from './api.js';
import { ago } from './status.js';

/**
 * What OSADE-MOSS adds to a single lane: who else is here, whether a named human attested its
 * head, what context the agent was handed, and what happened while you were away.
 *
 * Every piece is a read of daemon state. None of it is load-bearing for the lane itself: a
 * daemon without members, attestation or retrieval answers with an error or null, and the
 * corresponding piece simply does not render (R3 — retrieval never fails an operation, and it
 * does not get to fail a screen either).
 */

const BEAT_MS = 20_000;

/** §M.6.7 — presence avatars and the advisory claim. Hidden on a single-user daemon. */
export function LanePresence({ taskId }: { taskId: string }): JSX.Element | null {
  const [shared, setShared] = useState(false);
  const [present, setPresent] = useState<string[]>([]);
  const [claimedBy, setClaimedBy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.shareInfo().then(
      (info) => {
        if (!cancelled) setShared(info.members.length > 0);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!shared) return;
    let cancelled = false;
    const beat = (): void => {
      api.presenceBeat(taskId).then(
        (reply) => {
          if (cancelled) return;
          setPresent(reply.present);
          setClaimedBy(reply.claimedBy);
        },
        () => {},
      );
    };
    beat();
    const timer = setInterval(beat, BEAT_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [shared, taskId]);

  if (!shared) return null;

  async function toggle(): Promise<void> {
    setError(null);
    try {
      const next = claimedBy ? await api.taskRelease(taskId) : await api.taskClaim(taskId);
      setClaimedBy(next.claimedBy);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div data-lane-presence style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      {present.map((login) => (
        <span
          key={login}
          title={`${login} is on this lane`}
          className="mono"
          style={{
            width: 20,
            height: 20,
            borderRadius: '50%',
            background: 'var(--bg-3)',
            color: 'var(--ink)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 10,
            textTransform: 'uppercase',
            outline: claimedBy === login ? '1px solid var(--focus)' : 'none',
          }}
        >
          {login.slice(0, 2)}
        </span>
      ))}
      <button
        type="button"
        onClick={() => void toggle()}
        title="Advisory: tells teammates who is driving. It does not lock the lane."
        style={{ fontSize: 'var(--t-xs)', padding: '1px 8px' }}
      >
        {claimedBy ? `Driving: ${claimedBy} · release` : 'Claim'}
      </button>
      {error && (
        <span style={{ color: 'var(--st-fail)', fontSize: 'var(--t-xs)' }} title={error}>
          !
        </span>
      )}
    </div>
  );
}

/** §M.7.2 — the attestation this lane last issued. Nothing renders before the first one. */
export function AttestationBadge({ taskId }: { taskId: string }): JSX.Element | null {
  const [latest, setLatest] = useState<Awaited<ReturnType<typeof api.attestationGet>>>(null);
  useEffect(() => {
    let cancelled = false;
    api.attestationGet(taskId).then(
      (row) => {
        if (!cancelled) setLatest(row);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [taskId]);
  if (!latest) return null;
  return (
    <span
      data-attestation
      className="mono"
      title={`Signed by ${latest.approved_by} at ${latest.approved_at} for ${latest.head_sha}`}
      style={{ fontSize: 'var(--t-xs)', color: 'var(--st-live)' }}
    >
      ✓ attested {latest.head_sha.slice(0, 7)} · {latest.approved_by}
    </span>
  );
}

/**
 * §M.2.4 — the context pack behind this lane's most recent turn.
 *
 * Collapsed, it is one line: how many items, how many tokens, which backend. Expanded, it is
 * every cited item with its namespace and source row, so "why did the agent do that?" has an
 * answer that is not a guess.
 */
export function ContextPackChip({
  taskId,
  turnKey,
}: {
  taskId: string;
  /** Changes whenever a turn lands, so the chip re-reads after each one. */
  turnKey: number;
}): JSX.Element | null {
  const [pack, setPack] = useState<ContextPack | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.contextPackLatest(taskId).then(
      (next) => {
        if (!cancelled) setPack(next);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [taskId, turnKey]);

  if (!pack) return null;

  return (
    <div data-context-pack style={{ margin: '8px 0 0', fontSize: 'var(--t-xs)' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{ fontSize: 'var(--t-xs)', padding: '1px 8px' }}
        title="What the last turn was given from the index"
      >
        Context · {pack.items.length} item{pack.items.length === 1 ? '' : 's'} ·{' '}
        {pack.tokens_used} tokens · {pack.backend}
        {pack.degraded ? ' (degraded)' : ''}
        {pack.overflow > 0 ? ` · ${pack.overflow} dropped for budget` : ''}
      </button>
      {open && (
        <div
          style={{
            marginTop: 6,
            border: '0.5px solid var(--line)',
            borderRadius: 'var(--radius)',
            padding: '6px 10px',
            maxHeight: 260,
            overflow: 'auto',
            background: 'var(--bg-0)',
          }}
        >
          <div style={{ color: 'var(--ink-3)', marginBottom: 6 }} className="mono">
            retrieval {pack.retrieval_ms.toFixed(1)} ms · assembly {pack.assembly_ms.toFixed(1)} ms
            {pack.arm ? ` · arm ${pack.arm}` : ''}
          </div>
          {pack.items.length === 0 && (
            <div style={{ color: 'var(--ink-2)' }}>Nothing relevant was found for this turn.</div>
          )}
          {pack.items.map((item) => (
            <div key={item.id} style={{ padding: '4px 0', borderTop: '0.5px solid var(--line)' }}>
              <div className="mono" style={{ color: 'var(--ink-2)' }}>
                {item.ns} · {item.src_table}/{item.src_id} · {item.score.toFixed(3)}
              </div>
              {item.text && (
                <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.45, color: 'var(--ink)' }}>
                  {item.text.length > 400 ? `${item.text.slice(0, 400)}…` : item.text}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * §M.6.5 — what happened in this chat since you last looked, and a cited search over it.
 *
 * Items included by exact filter (gate decisions, verify failures) are marked as such: "every
 * decision, plus what else looked relevant" is a different promise from "the twelve most
 * relevant things", and the reader needs to know which one they are looking at.
 */
export function CatchUpPanel({
  chatId,
  onClose,
}: {
  chatId: string;
  onClose: () => void;
}): JSX.Element {
  const [result, setResult] = useState<CatchUpResult | null>(null);
  const [answers, setAnswers] = useState<CatchUpItem[] | null>(null);
  const [question, setQuestion] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.catchUp(chatId).then(
      (next) => {
        if (!cancelled) setResult(next);
      },
      (err: Error) => {
        if (!cancelled) setError(err.message);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [chatId]);

  async function ask(): Promise<void> {
    if (!question.trim()) return;
    setError(null);
    try {
      setAnswers(await api.askHistory(chatId, question.trim()));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <section
      data-catch-up
      style={{
        border: '0.5px solid var(--line)',
        borderRadius: 'var(--radius-panel)',
        padding: '10px 12px',
        marginBottom: 12,
        background: 'var(--bg-0)',
      }}
    >
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
        <strong style={{ fontSize: 'var(--t-s)' }}>While you were away</strong>
        {result && (
          <span className="mono" style={{ fontSize: 'var(--t-xs)', color: 'var(--ink-3)' }}>
            {result.backend} · {result.retrieval_ms.toFixed(1)} ms
          </span>
        )}
        <button type="button" onClick={onClose} style={{ marginLeft: 'auto', fontSize: 'var(--t-xs)' }}>
          Close
        </button>
      </header>
      {!result && !error && <div style={{ fontSize: 'var(--t-xs)', color: 'var(--ink-2)' }}>Reading…</div>}
      {result && result.items.length === 0 && (
        <div style={{ fontSize: 'var(--t-xs)', color: 'var(--ink-2)' }}>Nothing new since you last looked.</div>
      )}
      {result && <CatchUpList items={result.items} />}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void ask();
        }}
        style={{ display: 'flex', gap: 6, marginTop: 10 }}
      >
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask this chat's history, e.g. why was the PR rejected?"
          style={{ flex: 1, fontSize: 'var(--t-xs)' }}
        />
        <button type="submit" style={{ fontSize: 'var(--t-xs)' }}>
          Ask
        </button>
      </form>
      {answers && (
        <div style={{ marginTop: 8 }}>
          {answers.length === 0 ? (
            <div style={{ fontSize: 'var(--t-xs)', color: 'var(--ink-2)' }}>No matching history.</div>
          ) : (
            <CatchUpList items={answers} />
          )}
        </div>
      )}
      {error && (
        <p className="mono" style={{ color: 'var(--st-fail)', fontSize: 'var(--t-xs)', margin: '6px 0 0' }}>
          {error}
        </p>
      )}
    </section>
  );
}

function CatchUpList({ items }: { items: CatchUpItem[] }): JSX.Element {
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {items.map((item) => (
        <li
          key={`${item.src_table}-${item.src_id}`}
          style={{ padding: '4px 0', borderTop: '0.5px solid var(--line)', fontSize: 'var(--t-xs)' }}
        >
          <div className="mono" style={{ color: 'var(--ink-3)' }}>
            {item.guaranteed ? '● ' : ''}
            {item.kind} · {ago(item.at)}
            {item.score != null ? ` · ${item.score.toFixed(3)}` : ''}
          </div>
          <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.45 }}>
            {item.text.length > 300 ? `${item.text.slice(0, 300)}…` : item.text}
          </div>
        </li>
      ))}
    </ul>
  );
}
