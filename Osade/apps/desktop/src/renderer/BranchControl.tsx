import { useEffect, useState, type JSX } from 'react';

import type { TaskView } from '@osade/contract';

import { api } from './api.js';
import { attachCheckoutHint, heldReason, isolatedWorktreeHint } from './branch-copy.js';

export function BranchControl({
  task,
  onNewIsolatedChat,
  onMoveToBranch,
}: {
  task: TaskView;
  onNewIsolatedChat: (opts: { checkoutRef?: string; baseRef?: string }) => void;
  onMoveToBranch: (checkoutRef: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [moving, setMoving] = useState(false);
  const [carry, setCarry] = useState(true);
  const [branchName, setBranchName] = useState('');
  const [branches, setBranches] = useState<string[]>([]);
  const [holders, setHolders] = useState<Record<string, { title: string }>>({});
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const attached = task.attachment === 'repo';
  const holder = holders[task.branch];
  const onBranchDisabled = heldReason(task.branch, holder);

  useEffect(() => {
    if (!open) return;
    setError(null);
    void Promise.all([
      api.repoBranchList(task.task.repo_id),
      api.repoStatus(task.task.repo_id),
      api.repoBranchHolders(task.task.repo_id),
    ])
      .then(([list, status, occupancy]) => {
        setBranches(list);
        setDirty(status.dirty);
        const next: Record<string, { title: string }> = {};
        for (const row of occupancy) {
          if (row.holder) next[row.branch] = { title: row.holder.title };
        }
        setHolders(next);
      })
      .catch((err: Error) => setError(err.message));
  }, [open, task.task.repo_id]);

  async function branchOut(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api.taskBranchOut({
        taskId: task.task.id,
        branch: branchName.trim() || undefined,
        carryChanges: carry,
      });
      setOpen(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function switchTo(name: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api.taskSwitchBranch(task.task.id, name);
      setOpen(false);
      setSwitching(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        title={attached ? attachCheckoutHint() : isolatedWorktreeHint()}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 'var(--t-xs)',
          padding: '2px 8px',
          color: 'var(--ink-2)',
        }}
      >
        <span className="mono">{task.branch}</span>
        {!attached && (
          <span aria-label="worktree" style={{ color: 'var(--ink-3)' }}>
            ⎇
          </span>
        )}
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            right: 0,
            top: '100%',
            marginTop: 6,
            width: 280,
            zIndex: 20,
            background: 'var(--bg-1)',
            border: '0.5px solid var(--line)',
            borderRadius: 'var(--radius)',
            padding: 10,
            boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
          }}
        >
          {attached && (
            <>
              <button
                className="primary"
                disabled={busy}
                onClick={() => void branchOut()}
                style={{ width: '100%', marginBottom: 8 }}
              >
                Use a worktree
              </button>
              <label
                style={{
                  display: 'flex',
                  gap: 8,
                  alignItems: 'center',
                  fontSize: 'var(--t-xs)',
                  color: 'var(--ink-2)',
                  marginBottom: 8,
                }}
              >
                <input
                  type="checkbox"
                  checked={carry}
                  onChange={(event) => setCarry(event.target.checked)}
                  style={{ width: 'auto' }}
                />
                Bring my uncommitted changes
              </label>
              <input
                placeholder="Branch name (optional)"
                value={branchName}
                onChange={(event) => setBranchName(event.target.value)}
                style={{ marginBottom: 10, fontSize: 'var(--t-xs)' }}
              />
            </>
          )}
          {attached ? (
            <button
              disabled={busy}
              onClick={() => setSwitching((v) => !v)}
              style={{ width: '100%', marginBottom: 6 }}
            >
              Switch branch
            </button>
          ) : (
            <button
              disabled={busy}
              onClick={() => setMoving((v) => !v)}
              title={isolatedWorktreeHint()}
              style={{ width: '100%', marginBottom: 6 }}
            >
              Move to another branch
            </button>
          )}
          {switching && attached && dirty && (
            <p style={{ margin: '0 0 8px', fontSize: 'var(--t-xs)', color: 'var(--st-needs)' }}>
              This changes your real checkout. Branch out instead if you want to keep this tree.
            </p>
          )}
          {switching && attached && (
            <div style={{ maxHeight: 160, overflow: 'auto', marginBottom: 8 }}>
              {branches.map((name) => (
                <button
                  key={name}
                  disabled={busy || name === task.branch}
                  onClick={() => void switchTo(name)}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    marginBottom: 2,
                    fontSize: 'var(--t-xs)',
                    background: name === task.branch ? 'var(--bg-2)' : 'transparent',
                  }}
                >
                  {name}
                </button>
              ))}
            </div>
          )}
          {moving && !attached && (
            <div style={{ maxHeight: 160, overflow: 'auto', marginBottom: 8 }}>
              {branches.map((name) => {
                const reason = heldReason(name, holders[name]);
                return (
                  <button
                    key={name}
                    disabled={busy || name === task.branch || Boolean(reason)}
                    title={reason}
                    onClick={() => {
                      onMoveToBranch(name);
                      setOpen(false);
                      setMoving(false);
                    }}
                    style={{
                      width: '100%',
                      textAlign: 'left',
                      marginBottom: 2,
                      fontSize: 'var(--t-xs)',
                      background: name === task.branch ? 'var(--bg-2)' : 'transparent',
                    }}
                  >
                    {name}
                  </button>
                );
              })}
            </div>
          )}
          <button
            disabled={busy || Boolean(onBranchDisabled)}
            title={onBranchDisabled}
            onClick={() => {
              onNewIsolatedChat({ checkoutRef: task.branch });
              setOpen(false);
            }}
            style={{ width: '100%', marginBottom: 6 }}
          >
            New chat on {task.branch}
          </button>
          <button
            disabled={busy}
            onClick={() => {
              onNewIsolatedChat({ baseRef: task.branch });
              setOpen(false);
            }}
            style={{ width: '100%' }}
          >
            New chat from this commit
          </button>
          {error && (
            <p style={{ margin: '8px 0 0', fontSize: 'var(--t-xs)', color: 'var(--st-fail)' }}>
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
