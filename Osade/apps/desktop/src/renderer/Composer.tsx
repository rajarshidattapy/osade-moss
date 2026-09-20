import { useEffect, useMemo, useRef, useState, type JSX } from 'react';

import { agentColor } from './agent-color.js';
import type { ComposerAttach } from './compose-attach.js';
import { COMPOSE_EVENT } from './compose-event.js';
import {
  fileToPhoto,
  imageFilesFromDataTransfer,
  MAX_COMPOSER_PHOTOS,
  type ComposerPhoto,
} from './compose-photos.js';
import { parseMentions } from './mentions.js';
import type { CatalogAgent } from './RepoSettings.js';

/** Composer for a chat or a local draft tab. Parent owns the send path. */
export function Composer({
  placeholder,
  disabled,
  autoFocus,
  held,
  catalog = [],
  attach = null,
  onDismissAttach,
  onSend,
}: {
  placeholder: string;
  disabled?: boolean;
  autoFocus?: boolean;
  /** A turn is live — Send queues instead of interrupting. */
  held?: boolean;
  catalog?: CatalogAgent[];
  attach?: ComposerAttach | null;
  onDismissAttach?: () => void;
  onSend: (text: string, photos: ComposerPhoto[]) => Promise<void>;
}): JSX.Element {
  const [text, setText] = useState('');
  const [photos, setPhotos] = useState<ComposerPhoto[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState(0);
  const [over, setOver] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const ready = !disabled && !busy && (text.trim().length > 0 || photos.length > 0);
  const hintText = held
    ? 'Held until this turn finishes. Enter queues it.'
    : placeholder;

  const ids = catalog.map((a) => a.id);
  const mentions = useMemo(() => parseMentions(text, ids), [text, ids]);
  const prefix = mentionPrefix(text);
  const suggestions = prefix == null
    ? []
    : catalog.filter((a) => a.id.startsWith(prefix) || a.displayName.toLowerCase().startsWith(prefix));

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    function onCompose(event: Event): void {
      const detail = (event as CustomEvent<string>).detail;
      if (typeof detail !== 'string' || detail.trim().length === 0) return;
      setText((current) => {
        const chunk = detail.trim();
        if (current.trim().length === 0) return chunk;
        return `${current.replace(/\s+$/u, '')}\n${chunk}`;
      });
      ref.current?.focus();
    }
    window.addEventListener(COMPOSE_EVENT, onCompose);
    return () => window.removeEventListener(COMPOSE_EVENT, onCompose);
  }, []);

  useEffect(() => {
    setHint(0);
  }, [prefix]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 36), 140)}px`;
  }, [text]);

  function send(): void {
    if (!ready) return;
    const payload = text.trim();
    const attached = photos;
    setBusy(true);
    setError(null);
    void onSend(payload, attached)
      .then(() => {
        setText('');
        setPhotos([]);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  }

  function addFiles(files: File[]): void {
    if (files.length === 0) return;
    void Promise.all(files.map(fileToPhoto))
      .then((next) => {
        setPhotos((current) => [...current, ...next].slice(0, MAX_COMPOSER_PHOTOS));
        setError(null);
      })
      .catch((err: Error) => setError(err.message));
  }

  function insertMention(id: string): void {
    const next = text.replace(/(?:^|\n)@[a-z0-9_-]*$/iu, (chunk) => {
      const lead = chunk.startsWith('\n') ? '\n' : '';
      return `${lead}@${id} `;
    });
    setText(next.endsWith(`@${id} `) || next.includes(`@${id} `) ? next : `${text.replace(/@[a-z0-9_-]*$/iu, '')}@${id} `);
    ref.current?.focus();
  }

  return (
    <div
      style={{
        borderTop: '1px solid var(--line)',
        padding: 10,
        background: over ? 'var(--bg-2)' : 'var(--bg-1)',
      }}
      onDragEnter={(event) => {
        if (event.dataTransfer?.types.includes('Files')) {
          event.preventDefault();
          setOver(true);
        }
      }}
      onDragOver={(event) => {
        if (event.dataTransfer?.types.includes('Files')) {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
          setOver(true);
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setOver(false);
      }}
      onDrop={(event) => {
        const files = imageFilesFromDataTransfer(event.dataTransfer);
        if (files.length === 0) return;
        event.preventDefault();
        setOver(false);
        addFiles(files);
      }}
      onPaste={(event) => {
        const files = imageFilesFromDataTransfer(event.clipboardData);
        if (files.length === 0) return;
        event.preventDefault();
        addFiles(files);
        const pasted = event.clipboardData?.getData('text/plain') ?? '';
        if (pasted.length > 0) {
          setText((current) => `${current}${pasted}`);
        }
      }}
    >
      {attach && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 8,
            fontSize: 'var(--t-xs)',
            color: 'var(--ink-2)',
            border: '0.5px solid var(--line)',
            background: 'var(--bg-2)',
            padding: '3px 8px',
            maxWidth: '100%',
          }}
        >
          <span className="mono" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {attach.label}
          </span>
          {onDismissAttach && (
            <button type="button" onClick={onDismissAttach} aria-label="Dismiss context" style={{ padding: '0 4px' }}>
              ×
            </button>
          )}
        </div>
      )}
      {photos.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
          {photos.map((photo) => (
            <span key={photo.id} style={{ position: 'relative', display: 'block' }}>
              <img
                src={photo.preview}
                alt={photo.name}
                style={{
                  width: 56,
                  height: 56,
                  objectFit: 'cover',
                  borderRadius: 'var(--radius)',
                  border: '0.5px solid var(--line)',
                  display: 'block',
                  background: 'var(--bg-2)',
                }}
              />
              <button
                type="button"
                aria-label={`Remove ${photo.name}`}
                onClick={() => setPhotos((current) => current.filter((p) => p.id !== photo.id))}
                style={{
                  position: 'absolute',
                  top: -6,
                  right: -6,
                  width: 18,
                  height: 18,
                  padding: 0,
                  borderRadius: 999,
                  fontSize: 12,
                  lineHeight: 1,
                }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {mentions.targets.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
          {mentions.targets.map((target) => (
            <span
              key={target.agentId}
              className="mono"
              style={{
                fontSize: 'var(--t-xs)',
                color: agentColor(target.agentId),
                border: `0.5px solid ${agentColor(target.agentId)}`,
                borderRadius: 999,
                padding: '1px 8px',
              }}
            >
              @{target.agentId}
            </span>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          type="button"
          disabled={disabled || busy || photos.length >= MAX_COMPOSER_PHOTOS}
          onClick={() => fileRef.current?.click()}
          title="Attach photos"
          aria-label="Attach photos"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 36,
            height: 36,
            padding: 0,
            flexShrink: 0,
            background: 'transparent',
            border: 'none',
            color: 'var(--ink-2)',
          }}
        >
          <PaperclipIcon />
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
          multiple
          hidden
          onChange={(event) => {
            addFiles(Array.from(event.target.files ?? []));
            event.target.value = '';
          }}
        />
        <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
          <textarea
            ref={ref}
            rows={1}
            disabled={disabled || busy}
            value={text}
            placeholder={hintText}
            autoFocus={autoFocus}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (suggestions.length > 0 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
                event.preventDefault();
                const delta = event.key === 'ArrowDown' ? 1 : -1;
                setHint((h) => (h + delta + suggestions.length) % suggestions.length);
                return;
              }
              if (
                suggestions.length > 0 &&
                (event.key === 'Tab' || event.key === 'Enter') &&
                !event.metaKey &&
                !event.ctrlKey &&
                !event.shiftKey
              ) {
                const pick = suggestions[hint];
                if (pick?.installed) {
                  event.preventDefault();
                  insertMention(pick.id);
                  return;
                }
              }
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                event.stopPropagation();
                send();
              }
            }}
            style={{
              fontSize: 'var(--t-m)',
              minHeight: 36,
              overflow: 'hidden',
              resize: 'none',
              padding: '7px 10px',
              lineHeight: '20px',
            }}
          />
          {suggestions.length > 0 && (
            <ul
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: '100%',
                margin: 0,
                padding: '4px 0',
                listStyle: 'none',
                background: 'var(--bg-2)',
                border: '0.5px solid var(--line)',
                borderRadius: 'var(--radius)',
                zIndex: 5,
              }}
            >
              {suggestions.map((agent, i) => (
                <li key={agent.id}>
                  <button
                    type="button"
                    disabled={!agent.installed}
                    title={agent.installed ? undefined : `${agent.displayName} is not on PATH`}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      if (agent.installed) insertMention(agent.id);
                    }}
                    style={{
                      display: 'flex',
                      width: '100%',
                      justifyContent: 'space-between',
                      background: i === hint ? 'var(--bg-3)' : 'transparent',
                      border: 'none',
                      borderRadius: 0,
                      color: agent.installed ? agentColor(agent.id) : 'var(--ink-3)',
                      textAlign: 'left',
                      padding: '5px 10px',
                    }}
                  >
                    <span>@{agent.id}</span>
                    <span style={{ color: 'var(--ink-3)', fontSize: 'var(--t-xs)' }}>
                      {agent.installed ? agent.displayName : 'Not on PATH'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <button
          type="button"
          className="primary"
          disabled={!ready}
          onClick={send}
          style={{ height: 36, padding: '0 12px', flexShrink: 0 }}
        >
          {busy ? 'Sending…' : held ? 'Hold' : 'Send'}
        </button>
      </div>
      {error && (
        <p className="mono" style={{ margin: '8px 0 0', color: 'var(--st-fail)', fontSize: 'var(--t-xs)' }}>
          {error}
        </p>
      )}
    </div>
  );
}

function PaperclipIcon(): JSX.Element {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

function mentionPrefix(text: string): string | null {
  const line = text.split(/\r?\n/u).at(-1) ?? '';
  const match = /^@([a-z0-9_-]*)$/iu.exec(line);
  return match ? (match[1] ?? '').toLowerCase() : null;
}
