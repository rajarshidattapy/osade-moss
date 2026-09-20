import { useEffect, useState, type JSX } from 'react';

import { api } from './api.js';

export interface CatalogAgent {
  id: string;
  displayName: string;
  installed: boolean;
}

export function useAgentCatalog(ready = true): CatalogAgent[] {
  const [agents, setAgents] = useState<CatalogAgent[]>([]);
  useEffect(() => {
    if (!ready) return;
    void api.agentCatalogList().then(setAgents, () => setAgents([]));
  }, [ready]);
  return agents;
}

export function RepoSettings({
  repoId,
  defaultAgent,
  catalog,
  onSaved,
}: {
  repoId: string;
  defaultAgent: string | null;
  catalog: CatalogAgent[];
  onSaved: (agentId: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(defaultAgent ?? 'claude');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setValue(defaultAgent ?? 'claude');
  }, [defaultAgent]);

  async function save(next: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api.repoSetDefaultAgent(repoId, next);
      setValue(next);
      onSaved(next);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ position: 'relative' }}>
      <button title="Repo settings" onClick={() => setOpen((v) => !v)}>
        Settings
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            right: 0,
            top: '100%',
            marginTop: 4,
            width: 240,
            zIndex: 15,
            background: 'var(--bg-2)',
            border: '0.5px solid var(--line)',
            borderRadius: 'var(--radius)',
            padding: 12,
          }}
        >
          <label style={{ display: 'block', fontSize: 'var(--t-xs)', color: 'var(--ink-2)' }}>
            Default agent
            <select
              value={value}
              disabled={busy}
              onChange={(event) => void save(event.target.value)}
              style={{ display: 'block', width: '100%', marginTop: 6 }}
            >
              {catalog.map((agent) => (
                <option key={agent.id} value={agent.id} disabled={!agent.installed}>
                  {agent.displayName}
                  {agent.installed ? '' : ' (not on PATH)'}
                </option>
              ))}
            </select>
          </label>
          {error && (
            <p className="mono" style={{ color: 'var(--st-fail)', fontSize: 'var(--t-xs)', margin: '8px 0 0' }}>
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
