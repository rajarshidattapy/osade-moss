import { useEffect, useState, type CSSProperties, type JSX } from 'react';

import type { ConventionView } from '@osade/contract';

import { api } from './api.js';
import { rulesAttach, type ComposerAttach } from './compose-attach.js';

/**
 * Per-repo rules — pasted into `<repo>/.osade/rules.md` and injected at agent launch.
 * Mining is a separate, optional path; this panel never needs an API key.
 */
export function Conventions({
  repoId,
  onAttach,
}: {
  repoId: string;
  onAttach?: (attach: ComposerAttach | null) => void;
}): JSX.Element {
  const [text, setText] = useState('');
  const [saved, setSaved] = useState('');
  const [path, setPath] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rules, setRules] = useState<ConventionView[]>([]);
  const [focusId, setFocusId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .repoRulesGet(repoId)
      .then((next) => {
        if (cancelled) return;
        setText(next.text);
        setSaved(next.text);
        setPath(next.path);
        setError(null);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    void api.conventionList(repoId).then(
      (list) => {
        if (!cancelled) {
          setRules(list);
          setFocusId((current) => current ?? list[0]?.id ?? null);
        }
      },
      () => {
        /* mining optional */
      },
    );
    return () => {
      cancelled = true;
    };
  }, [repoId]);

  const focused = rules.find((r) => r.id === focusId) ?? null;
  useEffect(() => {
    if (!onAttach) return;
    if (focused) {
      onAttach(rulesAttach(focused.id, focused.ruleText));
      return;
    }
    if (path) onAttach(rulesAttach(path, text.slice(0, 800)));
    else onAttach(null);
  }, [onAttach, focused, path, text]);

  useEffect(() => {
    let cancelled = false;
    void api
      .repoRulesGet(repoId)
      .then((next) => {
        if (cancelled) return;
        setText(next.text);
        setSaved(next.text);
        setPath(next.path);
        setError(null);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [repoId]);

  async function save(): Promise<void> {
    if (text === saved) return;
    setSaving(true);
    try {
      await api.repoRulesSave(repoId, text);
      setSaved(text);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const dirty = text !== saved;

  return (
    <section style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      {rules.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          {rules.map((rule) => (
            <button
              key={rule.id}
              type="button"
              onClick={() => setFocusId(rule.id)}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '4px 8px',
                marginBottom: 4,
                border: '0.5px solid var(--line)',
                background: rule.id === focusId ? 'var(--bg-2)' : 'transparent',
                fontSize: 'var(--t-xs)',
              }}
            >
              <span className="mono">{rule.id}</span> · {rule.ruleText}
            </button>
          ))}
        </div>
      )}
      <p style={{ color: 'var(--ink-2)', fontSize: 'var(--t-xs)', margin: '0 0 10px' }}>
        Paste the rules agents should follow. Saved as{' '}
        <span className="mono">{path ?? '.osade/rules.md'}</span> in this repository.
      </p>
      <textarea
        value={text}
        spellCheck={false}
        placeholder="Paste rules here."
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
            event.preventDefault();
            void save();
          }
        }}
        style={{
          flex: 1,
          minHeight: 220,
          width: '100%',
          resize: 'vertical',
          fontFamily: 'var(--mono)',
          fontSize: 'var(--t-s)',
        }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
        <button type="button" disabled={!dirty || saving} style={buttonStyle} onClick={() => void save()}>
          {saving ? 'Saving' : 'Save'}
        </button>
        {dirty && (
          <span style={{ color: 'var(--ink-3)', fontSize: 'var(--t-xs)' }}>Unsaved</span>
        )}
      </div>
      {error && (
        <p className="mono" style={{ color: 'var(--st-fail)', fontSize: 'var(--t-xs)', margin: '8px 0 0' }}>
          {error}
        </p>
      )}
    </section>
  );
}

const buttonStyle: CSSProperties = {
  padding: '5px 12px',
  border: '1px solid var(--rule)',
  borderRadius: 'var(--radius)',
  background: 'var(--paper)',
  color: 'var(--ink)',
  font: 'inherit',
  cursor: 'pointer',
};
