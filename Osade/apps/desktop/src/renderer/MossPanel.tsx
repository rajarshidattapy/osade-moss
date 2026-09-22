import { useCallback, useEffect, useState, type CSSProperties, type JSX, type ReactNode } from 'react';

import type {
  AttestationCheck,
  DiscoveryMiss,
  Member,
  MigrationChangeKind,
  MigrationMetrics,
  MigrationSummary,
  MigrationView,
  PolicyReloadResult,
  RetrievalStats,
  ShareInfo,
  TriageRow,
} from '@osade/contract';

import { api } from './api.js';
import { ago } from './status.js';

/**
 * The workspace-level half of OSADE-MOSS — retrieval health, F1 migrations, F2 team, F3 pull
 * request triage, F4 policies and the audit export.
 *
 * Everything here is a view over daemon state or a call to a mutation the CLI already exposes;
 * the panel computes nothing the daemon did not. Where a number is shown, the `n` behind it is
 * shown too (§M.5.7), because at demo scale a percentage without its denominator is a claim.
 */

export type MossTab = 'retrieval' | 'migrations' | 'team' | 'prs' | 'compliance';

const TABS: { id: MossTab; label: string }[] = [
  { id: 'retrieval', label: 'Retrieval' },
  { id: 'migrations', label: 'Migrations' },
  { id: 'team', label: 'Team' },
  { id: 'prs', label: 'Pull requests' },
  { id: 'compliance', label: 'Policies & audit' },
];

export interface RepoChoice {
  id: string;
  label: string;
}

export function MossPanel({
  initialTab = 'retrieval',
  repos,
  onClose,
}: {
  initialTab?: MossTab;
  repos: RepoChoice[];
  onClose: () => void;
}): JSX.Element {
  const [tab, setTab] = useState<MossTab>(initialTab);

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-label="Workspace"
      data-moss-panel
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        background: 'rgba(0, 0, 0, 0.45)',
        display: 'flex',
        alignItems: 'stretch',
        justifyContent: 'center',
        padding: '32px 16px',
      }}
    >
      <div
        style={{
          width: 'min(960px, 100%)',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--bg-1)',
          border: '0.5px solid var(--line)',
          borderRadius: 'var(--radius-panel)',
          overflow: 'hidden',
        }}
      >
        <nav
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            padding: '8px 12px 0',
            borderBottom: '0.5px solid var(--line)',
          }}
        >
          {TABS.map((item) => {
            const selected = item.id === tab;
            return (
              <button
                key={item.id}
                data-moss-tab={item.id}
                onClick={() => setTab(item.id)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  borderBottom: selected ? '1px solid var(--focus)' : '1px solid transparent',
                  borderRadius: 0,
                  marginBottom: -1,
                  color: selected ? 'var(--ink)' : 'var(--ink-2)',
                  padding: '6px 10px 8px',
                }}
              >
                {item.label}
              </button>
            );
          })}
          <button onClick={onClose} style={{ marginLeft: 'auto', marginBottom: 6 }}>
            Close <kbd>esc</kbd>
          </button>
        </nav>
        <div style={{ flex: 1, overflow: 'auto', padding: '14px 18px' }}>
          {tab === 'retrieval' && <RetrievalTab />}
          {tab === 'migrations' && <MigrationsTab repos={repos} />}
          {tab === 'team' && <TeamTab />}
          {tab === 'prs' && <PullRequestsTab repos={repos} />}
          {tab === 'compliance' && <ComplianceTab repos={repos} />}
        </div>
      </div>
    </div>
  );
}

// ── Retrieval ───────────────────────────────────────────────────────────────

/** §M.1.7 — polled lightly while visible; the sidebar badge shares the same read. */
export function useRetrievalStats(intervalMs = 15_000): RetrievalStats | null {
  const [stats, setStats] = useState<RetrievalStats | null>(null);
  useEffect(() => {
    let cancelled = false;
    const read = (): void => {
      api.retrievalStats().then(
        (next) => {
          if (!cancelled) setStats(next);
        },
        () => {
          if (!cancelled) setStats(null);
        },
      );
    };
    read();
    const timer = setInterval(read, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [intervalMs]);
  return stats;
}

/** One word for the sidebar: which backend, and whether it is the one that was asked for. */
export function retrievalBadge(stats: RetrievalStats | null): { value: string; tone: string } {
  if (!stats) return { value: 'Unavailable', tone: 'var(--ink-3)' };
  if (stats.backend === 'moss') return { value: 'Moss', tone: 'var(--st-live)' };
  // FTS5 with no Moss configured is the normal state of a fresh install, not a fault.
  if (!stats.mossConfigured) return { value: 'Local (FTS5)', tone: 'var(--ink)' };
  return { value: 'Degraded · FTS5', tone: 'var(--st-needs)' };
}

function RetrievalTab(): JSX.Element {
  const stats = useRetrievalStats(5_000);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function rebuild(): Promise<void> {
    setBusy(true);
    setNote(null);
    try {
      const { indexed } = await api.indexRebuild();
      setNote(`Re-projected ${indexed} documents from SQLite.`);
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!stats) return <Muted>The retrieval layer is not answering.</Muted>;
  const badge = retrievalBadge(stats);

  return (
    <>
      <Row>
        <Label>Backend</Label>
        <span className="mono" style={{ color: badge.tone }} data-retrieval-backend={stats.backend}>
          {badge.value}
        </span>
      </Row>
      {stats.degradedReason && stats.mossConfigured && (
        <Row>
          <Label>Why</Label>
          <span style={{ color: 'var(--st-needs)' }}>{stats.degradedReason}</span>
        </Row>
      )}
      {!stats.mossConfigured && (
        <Muted>
          Moss is not configured, so search runs on SQLite FTS5. Set MOSS_PROJECT_ID and
          MOSS_PROJECT_KEY for the daemon to use semantic retrieval. Nothing else changes.
        </Muted>
      )}
      <Row>
        <Label>Indexer lag</Label>
        <span className="mono" style={{ color: stats.indexerLag > 0 ? 'var(--st-needs)' : 'var(--ink)' }}>
          {stats.indexerLag} row{stats.indexerLag === 1 ? '' : 's'} waiting
        </span>
      </Row>

      <Table
        head={['Namespace', 'Docs', 'Queries', 'p50', 'p95']}
        rows={stats.namespaces.map((ns) => [
          ns.ns,
          String(ns.docs),
          String(ns.queries),
          ms(ns.p50Ms),
          ms(ns.p95Ms),
        ])}
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14 }}>
        <button disabled={busy} onClick={() => void rebuild()}>
          {busy ? 'Rebuilding…' : 'Rebuild index'}
        </button>
        <Muted inline>
          Safe at any time: the index is derived from SQLite and can always be rebuilt.
        </Muted>
      </div>
      {note && <Muted>{note}</Muted>}
    </>
  );
}

// ── Migrations (F1) ─────────────────────────────────────────────────────────

const CHANGE_KINDS: MigrationChangeKind[] = ['rename', 'signature', 'removal', 'behavior'];

function MigrationsTab({ repos }: { repos: RepoChoice[] }): JSX.Element {
  const [list, setList] = useState<MigrationSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.migrationList().then(setList, (err: Error) => setError(err.message));
  }, []);
  useEffect(refresh, [refresh]);

  if (selected) {
    return (
      <MigrationDetail
        migrationId={selected}
        repos={repos}
        onBack={() => {
          setSelected(null);
          refresh();
        }}
      />
    );
  }

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <strong>API migrations</strong>
        <Muted inline>
          One SDK upgrade across many repositories, found by retrieval and grep side by side.
        </Muted>
        <button style={{ marginLeft: 'auto' }} onClick={() => setCreating((v) => !v)}>
          {creating ? 'Cancel' : 'New migration'}
        </button>
      </div>
      {creating && (
        <NewMigration
          onCreated={(id) => {
            setCreating(false);
            setSelected(id);
          }}
        />
      )}
      {error && <ErrorLine>{error}</ErrorLine>}
      {list && list.length === 0 && !creating && <Muted>No migrations yet.</Muted>}
      {list && list.length > 0 && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {list.map((m) => (
            <li key={m.id}>
              <button
                data-migration={m.id}
                onClick={() => setSelected(m.id)}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  display: 'flex',
                  gap: 12,
                  alignItems: 'baseline',
                  marginBottom: 4,
                }}
              >
                <span className="mono">
                  {m.package} {m.from_version ?? '?'} → {m.to_version}
                </span>
                <span style={{ color: 'var(--ink-2)', fontSize: 'var(--t-xs)' }}>{m.provider}</span>
                <span style={{ marginLeft: 'auto', color: 'var(--ink-2)', fontSize: 'var(--t-xs)' }}>
                  {m.changes} changes · {m.targets} repos ·{' '}
                  {m.changes_confirmed_at ? 'confirmed' : 'draft'} · {ago(m.created_at)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function NewMigration({ onCreated }: { onCreated: (id: string) => void }): JSX.Element {
  const [provider, setProvider] = useState('');
  const [pkg, setPkg] = useState('');
  const [fromVersion, setFromVersion] = useState('');
  const [toVersion, setToVersion] = useState('');
  const [changelog, setChangelog] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const { migrationId } = await api.migrationCreate({
        provider: provider.trim(),
        package: pkg.trim(),
        fromVersion: fromVersion.trim() || null,
        toVersion: toVersion.trim(),
        changelogText: changelog,
      });
      onCreated(migrationId);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      style={{ ...box, display: 'grid', gap: 8, marginBottom: 12 }}
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8 }}>
        <input placeholder="Provider, e.g. stripe" value={provider} onChange={(e) => setProvider(e.target.value)} />
        <input placeholder="Package" value={pkg} onChange={(e) => setPkg(e.target.value)} />
        <input placeholder="From version" value={fromVersion} onChange={(e) => setFromVersion(e.target.value)} />
        <input placeholder="To version" value={toVersion} onChange={(e) => setToVersion(e.target.value)} />
      </div>
      <textarea
        placeholder="Paste the changelog for this upgrade. Every extracted change must cite a line of it."
        rows={6}
        value={changelog}
        onChange={(e) => setChangelog(e.target.value)}
        className="mono"
        style={{ fontSize: 'var(--t-xs)' }}
      />
      <div>
        <button
          className="primary"
          type="submit"
          disabled={busy || !provider.trim() || !pkg.trim() || !toVersion.trim() || !changelog.trim()}
        >
          Create migration
        </button>
      </div>
      {error && <ErrorLine>{error}</ErrorLine>}
    </form>
  );
}

function MigrationDetail({
  migrationId,
  repos,
  onBack,
}: {
  migrationId: string;
  repos: RepoChoice[];
  onBack: () => void;
}): JSX.Element {
  const [view, setView] = useState<MigrationView | null>(null);
  const [metrics, setMetrics] = useState<MigrationMetrics | null>(null);
  const [misses, setMisses] = useState<DiscoveryMiss[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [targetIds, setTargetIds] = useState<Set<string>>(new Set());

  const refresh = useCallback(() => {
    api.migrationView(migrationId).then(setView, (err: Error) => setError(err.message));
    api.migrationMetrics(migrationId).then(setMetrics, () => setMetrics(null));
    api.migrationMisses(migrationId).then(setMisses, () => setMisses([]));
  }, [migrationId]);
  useEffect(refresh, [refresh]);

  async function step(name: string, action: () => Promise<string | null>): Promise<void> {
    setBusy(name);
    setError(null);
    setNote(null);
    try {
      setNote(await action());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
      refresh();
    }
  }

  if (!view) {
    return (
      <>
        <button onClick={onBack}>← Migrations</button>
        {error ? <ErrorLine>{error}</ErrorLine> : <Muted>Reading…</Muted>}
      </>
    );
  }

  const confirmed = view.changes_confirmed_at != null;
  const hasTargets = view.targets.length > 0;
  const chunked = view.discovery.some((d) => d.chunks > 0);
  const waves = [...new Set(view.targets.map((t) => t.wave))].sort((a, b) => a - b);

  return (
    <div data-migration-detail={view.id}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12 }}>
        <button onClick={onBack}>← Migrations</button>
        <strong className="mono">
          {view.package} {view.from_version ?? '?'} → {view.to_version ?? '?'}
        </strong>
        <span style={{ color: 'var(--ink-2)', fontSize: 'var(--t-xs)' }}>{view.provider}</span>
        <span className="mono" style={{ marginLeft: 'auto', color: 'var(--ink-3)', fontSize: 'var(--t-xs)' }}>
          {view.id}
        </span>
      </div>

      {/* 1. Changes — nothing downstream runs until a human confirms them (§M.5.3). */}
      <Step n={1} title="Breaking changes" done={confirmed}>
        {view.changes.length === 0 ? (
          <Muted>No changes yet. Extract them from the changelog, or add them by hand.</Muted>
        ) : (
          <Table
            head={['Kind', 'Old', 'New', 'Description', 'Source']}
            rows={view.changes.map((c) => [
              c.kind,
              c.old_symbol ?? '—',
              c.new_symbol ?? '—',
              c.description,
              c.source,
            ])}
          />
        )}
        {!confirmed && (
          <>
            <AddChange
              onAdd={(input) =>
                step('add', async () => {
                  await api.migrationAddChange({ migrationId, ...input });
                  return null;
                })
              }
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button
                disabled={busy != null}
                onClick={() =>
                  void step('extract', async () => {
                    const r = await api.migrationExtract(migrationId);
                    return `Kept ${r.kept}, dropped ${r.dropped} that did not cite the changelog.`;
                  })
                }
              >
                {busy === 'extract' ? 'Extracting…' : 'Extract with an agent'}
              </button>
              <button
                className="primary"
                disabled={busy != null || view.changes.length === 0}
                onClick={() =>
                  void step('confirm', async () => {
                    await api.migrationChangesConfirm(migrationId);
                    return 'Changes confirmed.';
                  })
                }
              >
                Confirm changes
              </button>
            </div>
          </>
        )}
        {confirmed && (
          <Muted>
            Confirmed by {view.changes_confirmed_by ?? 'someone'} {ago(view.changes_confirmed_at)}.
          </Muted>
        )}
      </Step>

      {/* 2. Targets — strata, arms and waves are fixed at assignment (§M.5.7). */}
      <Step n={2} title="Target repositories" done={hasTargets}>
        {hasTargets ? (
          <Table
            head={['Repo', 'Wave', 'Arm', 'Stratum', 'Sites', 'Lane']}
            rows={view.targets.map((t) => [
              t.repo_slug,
              t.wave === 0 ? '0 (canary)' : String(t.wave),
              t.arm,
              t.stratum,
              String(t.sites),
              t.task_id ?? '—',
            ])}
          />
        ) : repos.length === 0 ? (
          <Muted>Open a repository in Osade first; targets are chosen from the repos it knows.</Muted>
        ) : (
          <>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              {repos.map((repo) => (
                <label key={repo.id} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 'var(--t-s)' }}>
                  <input
                    type="checkbox"
                    checked={targetIds.has(repo.id)}
                    style={{ width: 'auto' }}
                    onChange={(e) => {
                      const next = new Set(targetIds);
                      if (e.target.checked) next.add(repo.id);
                      else next.delete(repo.id);
                      setTargetIds(next);
                    }}
                  />
                  {repo.label}
                </label>
              ))}
            </div>
            <button
              style={{ marginTop: 8 }}
              disabled={!confirmed || targetIds.size === 0 || busy != null}
              title={confirmed ? undefined : 'Confirm the changes first'}
              onClick={() =>
                void step('targets', async () => {
                  await api.migrationTargetsSet(migrationId, [...targetIds]);
                  return null;
                })
              }
            >
              Set targets
            </button>
          </>
        )}
      </Step>

      {/* 3. Chunk + discover — the grep-vs-retrieval comparison is the point (§M.5.5). */}
      <Step n={3} title="Discover call sites" done={view.discovery.some((d) => d.both + d.moss_only + d.grep_only > 0)}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <button
            disabled={!hasTargets || busy != null}
            onClick={() =>
              void step('chunk', async () => {
                const r = await api.migrationChunk(migrationId);
                return `Wrote ${r.chunks} chunks${r.unparsed.length ? `; ${r.unparsed.length} files did not parse (grep still covers them)` : ''}.`;
              })
            }
          >
            {busy === 'chunk' ? 'Parsing…' : 'Parse and chunk'}
          </button>
          <button
            disabled={!chunked || busy != null}
            onClick={() =>
              void step('discover', async () => {
                const r = await api.migrationDiscover(migrationId);
                return `Found ${r.sites} call sites in ${r.queryMs.toFixed(1)} ms of retrieval.`;
              })
            }
          >
            {busy === 'discover' ? 'Discovering…' : 'Discover'}
          </button>
        </div>
        {view.discovery.length > 0 && (
          <>
            <Table
              head={['Repo', 'Both', 'Retrieval only', 'Grep only', 'Unparsed', 'Chunks', 'Query']}
              rows={view.discovery.map((d) => [
                d.repo_slug,
                String(d.both),
                String(d.moss_only),
                String(d.grep_only),
                String(d.unparsed),
                String(d.chunks),
                ms(d.query_ms),
              ])}
            />
            <DiscoveryBars view={view} />
          </>
        )}
      </Step>

      {/* 4. Waves — wave 1+ waits on a green canary, not a timer (§M.5.6). */}
      <Step n={4} title="Launch lanes" done={view.targets.length > 0 && view.targets.every((t) => t.task_id)}>
        <Muted>
          Live lanes {view.liveLanes} of {view.maxLiveLanes}. Canary{' '}
          {view.canaryGreen ? 'is green' : 'has not passed yet'}.
        </Muted>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {waves.map((wave) => {
            const blocked = wave > 0 && !view.canaryGreen;
            return (
              <button
                key={wave}
                disabled={busy != null || view.nextWave == null || wave !== view.nextWave || blocked}
                title={blocked ? 'Wave 1 and later wait for a green canary' : undefined}
                onClick={() =>
                  void step(`wave-${wave}`, async () => {
                    const r = await api.migrationLaunchWave(migrationId, wave);
                    return `Launched ${r.launched.length} lane(s)${r.deferred.length ? `, deferred ${r.deferred.length} at the lane cap` : ''}.`;
                  })
                }
              >
                Launch wave {wave}
                {wave === 0 ? ' (canary)' : ''}
              </button>
            );
          })}
          {waves.length === 0 && <Muted inline>Set targets first.</Muted>}
        </div>
      </Step>

      {/* 5. The A/B readout — every number derived, n beside it (§M.5.7). */}
      {metrics && metrics.arms.some((a) => a.n > 0) && (
        <Step n={5} title="Digest A/B" done={false}>
          <Table
            head={['Arm', 'n', 'First-attempt pass', 'Turns to green', 'Edits at gate', 'Context tokens']}
            rows={metrics.arms.map((a) => [
              a.arm,
              String(a.n),
              a.n === 0 ? '—' : `${a.firstAttemptPass}/${a.n}`,
              a.turnsToGreen == null ? '—' : a.turnsToGreen.toFixed(1),
              String(a.humanEditsAtGate),
              String(a.contextTokens),
            ])}
          />
          <Muted>
            Retrieval p50 {ms(metrics.retrievalP50Ms)} · p95 {ms(metrics.retrievalP95Ms)}. At this
            many repositories this demonstrates the method; it is not a significant result.
          </Muted>
        </Step>
      )}

      {misses.length > 0 && (
        <Step n={6} title="Discovery misses" done={false}>
          <Muted>Sites verification failed on that discovery never proposed. Each one is a recall test case.</Muted>
          <Table
            head={['File', 'Line', 'Diagnostic']}
            rows={misses.map((m) => [m.file, String(m.line), m.pattern])}
          />
        </Step>
      )}

      {note && <Muted>{note}</Muted>}
      {error && <ErrorLine>{error}</ErrorLine>}
    </div>
  );
}

/** Stacked bars: how much each method found, and how much only it found. */
function DiscoveryBars({ view }: { view: MigrationView }): JSX.Element {
  return (
    <div style={{ marginTop: 10, display: 'grid', gap: 6 }}>
      {view.discovery.map((d) => {
        const total = d.both + d.moss_only + d.grep_only;
        if (total === 0) return null;
        const pct = (n: number): string => `${(n / total) * 100}%`;
        return (
          <div key={d.repo_id} style={{ fontSize: 'var(--t-xs)' }}>
            <div className="mono" style={{ color: 'var(--ink-2)', marginBottom: 2 }}>
              {d.repo_slug} · grep {d.both + d.grep_only}/{total} · retrieval {d.both + d.moss_only}/{total}
            </div>
            <div style={{ display: 'flex', height: 8, borderRadius: 2, overflow: 'hidden', background: 'var(--bg-3)' }}>
              <span title={`both ${d.both}`} style={{ width: pct(d.both), background: 'var(--ink-2)' }} />
              <span title={`retrieval only ${d.moss_only}`} style={{ width: pct(d.moss_only), background: 'var(--st-live)' }} />
              <span title={`grep only ${d.grep_only}`} style={{ width: pct(d.grep_only), background: 'var(--st-needs)' }} />
            </div>
          </div>
        );
      })}
      <Muted inline>
        <Swatch colour="var(--ink-2)" /> both <Swatch colour="var(--st-live)" /> retrieval only{' '}
        <Swatch colour="var(--st-needs)" /> grep only
      </Muted>
    </div>
  );
}

function AddChange({
  onAdd,
}: {
  onAdd: (input: {
    kind: MigrationChangeKind;
    oldSymbol: string | null;
    newSymbol: string | null;
    description: string;
  }) => Promise<void>;
}): JSX.Element {
  const [kind, setKind] = useState<MigrationChangeKind>('rename');
  const [oldSymbol, setOldSymbol] = useState('');
  const [newSymbol, setNewSymbol] = useState('');
  const [description, setDescription] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!description.trim()) return;
        void onAdd({
          kind,
          oldSymbol: oldSymbol.trim() || null,
          newSymbol: newSymbol.trim() || null,
          description: description.trim(),
        }).then(() => {
          setOldSymbol('');
          setNewSymbol('');
          setDescription('');
        });
      }}
      style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}
    >
      <select value={kind} onChange={(e) => setKind(e.target.value as MigrationChangeKind)} style={{ width: 'auto' }}>
        {CHANGE_KINDS.map((k) => (
          <option key={k} value={k}>
            {k}
          </option>
        ))}
      </select>
      <input placeholder="Old symbol" value={oldSymbol} onChange={(e) => setOldSymbol(e.target.value)} style={{ width: 150 }} />
      <input placeholder="New symbol" value={newSymbol} onChange={(e) => setNewSymbol(e.target.value)} style={{ width: 150 }} />
      <input
        placeholder="What changed"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        style={{ flex: 1, minWidth: 160 }}
      />
      <button type="submit" disabled={!description.trim()}>
        Add change
      </button>
    </form>
  );
}

// ── Team (F2) ───────────────────────────────────────────────────────────────

function TeamTab(): JSX.Element {
  const [info, setInfo] = useState<ShareInfo | null>(null);
  const [login, setLogin] = useState('');
  const [role, setRole] = useState<'maintainer' | 'viewer'>('maintainer');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.shareInfo().then(setInfo, (err: Error) => setError(err.message));
  }, []);
  useEffect(refresh, [refresh]);

  async function act(action: () => Promise<unknown>): Promise<void> {
    setError(null);
    try {
      await action();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      refresh();
    }
  }

  return (
    <>
      <Row>
        <Label>Listening</Label>
        <span className="mono">{info ? (info.mode === 'lan' ? 'LAN (TLS, auth required)' : 'This machine only') : '…'}</span>
      </Row>
      {info?.mode === 'lan' && (
        <>
          <Row>
            <Label>Join code</Label>
            <span className="mono" data-join-code>{info.joinCode ?? '—'}</span>
          </Row>
          <Row>
            <Label>TLS fingerprint</Label>
            <span className="mono" style={{ fontSize: 'var(--t-xs)', wordBreak: 'break-all' }}>
              {info.fingerprint ?? '—'}
            </span>
          </Row>
        </>
      )}
      {info?.mode === 'loopback' && (
        <Muted>
          Teammates can join only when the daemon listens on the LAN: set server.listen to "lan"
          in ~/.osade/config.json and restart it. Invites made now take effect then.
        </Muted>
      )}

      <h3 style={{ fontSize: 'var(--t-s)', margin: '16px 0 6px' }}>Members</h3>
      {info && info.members.length === 0 && <Muted>Nobody invited. You are the only user.</Muted>}
      {info && info.members.length > 0 && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {info.members.map((m) => (
            <MemberRow key={m.login} member={m} onAct={act} />
          ))}
        </ul>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!login.trim()) return;
          void act(() => api.memberInvite(login.trim(), role)).then(() => setLogin(''));
        }}
        style={{ display: 'flex', gap: 6, marginTop: 12 }}
      >
        <input placeholder="GitHub login" value={login} onChange={(e) => setLogin(e.target.value)} style={{ width: 220 }} />
        <select value={role} onChange={(e) => setRole(e.target.value as 'maintainer' | 'viewer')} style={{ width: 'auto' }}>
          <option value="maintainer">maintainer</option>
          <option value="viewer">viewer</option>
        </select>
        <button type="submit" disabled={!login.trim()} style={{ flexShrink: 0 }}>
          Invite
        </button>
      </form>
      <Muted>
        Maintainers can drive lanes and decide gates. Viewers read. Only you, the host, reach shells
        and run code on this machine, and every GitHub write still uses your token behind a gate.
      </Muted>
      {error && <ErrorLine>{error}</ErrorLine>}
    </>
  );
}

function MemberRow({
  member,
  onAct,
}: {
  member: Member;
  onAct: (action: () => Promise<unknown>) => Promise<void>;
}): JSX.Element {
  const isOwner = member.role === 'owner';
  return (
    <li style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 0', borderTop: '0.5px solid var(--line)' }}>
      <span className="mono" style={{ minWidth: 140 }}>
        {member.login}
      </span>
      {isOwner ? (
        <span style={{ color: 'var(--ink-2)', fontSize: 'var(--t-xs)' }}>owner (host)</span>
      ) : (
        <select
          style={{ width: 'auto' }}
          value={member.role}
          onChange={(e) =>
            void onAct(() => api.memberSetRole(member.login, e.target.value as 'maintainer' | 'viewer'))
          }
        >
          <option value="maintainer">maintainer</option>
          <option value="viewer">viewer</option>
        </select>
      )}
      <span style={{ color: 'var(--ink-3)', fontSize: 'var(--t-xs)' }}>
        invited by {member.invited_by} {ago(member.invited_at)}
      </span>
      {!isOwner && (
        <button
          style={{ marginLeft: 'auto', fontSize: 'var(--t-xs)' }}
          onClick={() => void onAct(() => api.memberRemove(member.login))}
          title="Removes them and ends their live sessions"
        >
          Remove
        </button>
      )}
    </li>
  );
}

// ── Pull requests (F3) ──────────────────────────────────────────────────────

function PullRequestsTab({ repos }: { repos: RepoChoice[] }): JSX.Element {
  const [repoId, setRepoId] = useState<string>(repos[0]?.id ?? '');
  const [rows, setRows] = useState<TriageRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!repoId) return;
    let cancelled = false;
    setRows(null);
    setError(null);
    api.prSignals(repoId).then(
      (next) => {
        if (!cancelled) setRows(next);
      },
      (err: Error) => {
        if (!cancelled) setError(err.message);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [repoId]);

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <strong style={{ whiteSpace: 'nowrap' }}>Incoming pull requests</strong>
        <RepoPicker repos={repos} value={repoId} onChange={setRepoId} />
      </div>
      <Muted>
        Attested first, then unique, then near-duplicate clusters. Signals order this list; nothing
        is posted, labelled or closed because of them.
      </Muted>
      {error && <ErrorLine>{error}</ErrorLine>}
      {rows && rows.length === 0 && <Muted>No open pull requests with signals yet.</Muted>}
      {rows && rows.length > 0 && (
        <Table
          head={['#', 'Title', 'Author', 'Attestation', 'Similar to']}
          rows={rows.map((r) => [
            `#${r.number}`,
            r.title,
            r.author,
            r.invalid ? '✗ invalid' : r.stale ? '◐ stale' : r.attested ? '✓ attested' : '—',
            r.similar_to.length
              ? `${r.similar_to.map((n) => `#${n}`).join(', ')}${r.top_score != null ? ` (${r.top_score.toFixed(2)})` : ''}`
              : '—',
          ])}
        />
      )}
      <VerifyAttestation />
    </>
  );
}

/** §M.7.4 — paste a PR body and its head; see whether the block in it holds up. */
function VerifyAttestation(): JSX.Element {
  const [body, setBody] = useState('');
  const [head, setHead] = useState('');
  const [result, setResult] = useState<AttestationCheck | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function check(): Promise<void> {
    setError(null);
    setResult(null);
    try {
      setResult(await api.attestationVerify({ body, currentHead: head.trim() }));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const tone =
    result?.state === 'valid'
      ? 'var(--st-live)'
      : result?.state === 'stale'
        ? 'var(--st-needs)'
        : result?.state === 'invalid'
          ? 'var(--st-fail)'
          : 'var(--ink-2)';

  return (
    <section style={{ ...box, marginTop: 16 }}>
      <strong style={{ fontSize: 'var(--t-s)' }}>Check an attestation</strong>
      <textarea
        placeholder="Paste the pull request body"
        rows={4}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        className="mono"
        style={{ width: '100%', marginTop: 6, fontSize: 'var(--t-xs)' }}
      />
      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
        <input placeholder="Current head sha" value={head} onChange={(e) => setHead(e.target.value)} style={{ flex: 1 }} />
        <button disabled={!body.trim() || !head.trim()} onClick={() => void check()}>
          Verify
        </button>
      </div>
      {result && (
        <p style={{ margin: '8px 0 0', color: tone, fontSize: 'var(--t-s)' }} data-attestation-state={result.state}>
          {result.state === 'valid' && `Valid: ${result.approved_by} approved this exact head.`}
          {result.state === 'stale' &&
            `Stale, not forged: ${result.approved_by} approved ${result.approved_head?.slice(0, 7)}, and commits landed after.`}
          {result.state === 'invalid' && `Invalid: ${result.reason ?? 'the signature does not verify'}.`}
          {result.state === 'absent' && 'No attestation block in this body.'}
        </p>
      )}
      {error && <ErrorLine>{error}</ErrorLine>}
    </section>
  );
}

// ── Policies & audit (F4) ───────────────────────────────────────────────────

function ComplianceTab({ repos }: { repos: RepoChoice[] }): JSX.Element {
  const [reload, setReload] = useState<PolicyReloadResult | null>(null);
  const [days, setDays] = useState(30);
  const [repoId, setRepoId] = useState<string>('');
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function reloadPolicies(): Promise<void> {
    setError(null);
    try {
      setReload(await api.policyReload());
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function exportAudit(): Promise<void> {
    setError(null);
    setNote(null);
    try {
      const since = Date.now() - days * 24 * 60 * 60 * 1000;
      const rows = await api.auditExport({ since, ...(repoId ? { repoId } : {}) });
      // JSON Lines, one gate per line: the same bytes `osade audit export` writes.
      const text = rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
      const url = URL.createObjectURL(new Blob([text], { type: 'application/x-ndjson' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `osade-audit-${new Date().toISOString().slice(0, 10)}.jsonl`;
      a.click();
      URL.revokeObjectURL(url);
      setNote(`Exported ${rows.length} gate${rows.length === 1 ? '' : 's'}.`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <>
      <strong>Policies</strong>
      <Muted>
        Policy files are read from .osade/policies/*.md in each repository and ~/.osade/policies.
        Clauses marked requires_ack hold a gate's approve button until someone acknowledges them.
        Reloading is explicit so a half-saved file never voids a pending approval.
      </Muted>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button onClick={() => void reloadPolicies()}>Reload policies</button>
        {reload && (
          <span className="mono" style={{ fontSize: 'var(--t-xs)' }}>
            {reload.policies} policies · {reload.clauses} clauses · {reload.removed} removed
          </span>
        )}
      </div>

      <strong style={{ display: 'block', marginTop: 20 }}>Audit export</strong>
      <Muted>
        Every gate in the window: who decided, the exact payload hash, the head it was bound to,
        the verification behind it, the clauses shown and acknowledged, and the attestation.
        Nothing in it is written by a model.
      </Muted>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 'var(--t-s)' }}>Last</span>
        <input
          type="number"
          min={1}
          value={days}
          onChange={(e) => setDays(Math.max(1, Number(e.target.value) || 1))}
          style={{ width: 70 }}
        />
        <span style={{ fontSize: 'var(--t-s)' }}>days</span>
        <RepoPicker repos={repos} value={repoId} onChange={setRepoId} allowAll />
        <button onClick={() => void exportAudit()}>Download .jsonl</button>
      </div>
      {note && <Muted>{note}</Muted>}
      {error && <ErrorLine>{error}</ErrorLine>}
    </>
  );
}

// ── small pieces ────────────────────────────────────────────────────────────

const box: CSSProperties = {
  border: '0.5px solid var(--line)',
  borderRadius: 'var(--radius)',
  padding: '10px 12px',
  background: 'var(--bg-0)',
};

function Step({
  n,
  title,
  done,
  children,
}: {
  n: number;
  title: string;
  done: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <section style={{ ...box, marginBottom: 10 }}>
      <header style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 8 }}>
        <span className="mono" style={{ color: done ? 'var(--st-live)' : 'var(--ink-3)' }}>
          {done ? '✓' : n}
        </span>
        <strong style={{ fontSize: 'var(--t-s)' }}>{title}</strong>
      </header>
      {children}
    </section>
  );
}

function Table({ head, rows }: { head: string[]; rows: string[][] }): JSX.Element {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--t-xs)' }}>
        <thead>
          <tr>
            {head.map((h) => (
              <th
                key={h}
                style={{
                  textAlign: 'left',
                  fontWeight: 500,
                  color: 'var(--ink-2)',
                  padding: '4px 8px 4px 0',
                  borderBottom: '0.5px solid var(--line)',
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td
                  key={j}
                  className={j === 0 ? 'mono' : undefined}
                  style={{ padding: '4px 8px 4px 0', borderBottom: '0.5px solid var(--line)', verticalAlign: 'top' }}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RepoPicker({
  repos,
  value,
  onChange,
  allowAll = false,
}: {
  repos: RepoChoice[];
  value: string;
  onChange: (id: string) => void;
  allowAll?: boolean;
}): JSX.Element | null {
  if (repos.length === 0 && !allowAll) return <Muted inline>No repositories open.</Muted>;
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={{ width: 'auto' }}>
      {allowAll && <option value="">All repositories</option>}
      {repos.map((repo) => (
        <option key={repo.id} value={repo.id}>
          {repo.label}
        </option>
      ))}
    </select>
  );
}

function Row({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'baseline', padding: '3px 0', fontSize: 'var(--t-s)' }}>
      {children}
    </div>
  );
}

function Label({ children }: { children: ReactNode }): JSX.Element {
  return <span style={{ color: 'var(--ink-2)', minWidth: 110 }}>{children}</span>;
}

function Muted({ children, inline = false }: { children: ReactNode; inline?: boolean }): JSX.Element {
  const style: CSSProperties = { color: 'var(--ink-2)', fontSize: 'var(--t-xs)', lineHeight: 1.5 };
  return inline ? <span style={style}>{children}</span> : <p style={{ ...style, margin: '6px 0' }}>{children}</p>;
}

function ErrorLine({ children }: { children: ReactNode }): JSX.Element {
  return (
    <p className="mono" style={{ color: 'var(--st-fail)', fontSize: 'var(--t-xs)', margin: '6px 0' }}>
      {children}
    </p>
  );
}

function Swatch({ colour }: { colour: string }): JSX.Element {
  return (
    <span
      style={{ display: 'inline-block', width: 8, height: 8, background: colour, marginRight: 3, verticalAlign: 'middle' }}
    />
  );
}

function ms(value: number | null): string {
  return value == null ? '—' : `${value.toFixed(1)} ms`;
}
