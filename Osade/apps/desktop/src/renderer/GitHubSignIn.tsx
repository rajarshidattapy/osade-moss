import { useEffect, useState, type JSX } from 'react';

export interface GithubStatus {
  signedIn: boolean;
  login: string | null;
}

export interface DevicePrompt {
  userCode: string;
  verificationUri: string;
}

export function GitHubSignIn({
  status,
  onSignedIn,
  onSkip,
}: {
  status: GithubStatus;
  onSignedIn: (login: string) => void;
  onSkip?: () => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [device, setDevice] = useState<DevicePrompt | null>(null);
  const [paste, setPaste] = useState(false);
  const [token, setToken] = useState('');

  useEffect(() => {
    return window.osade?.onGithubDevice((next) => setDevice(next));
  }, []);

  async function login(pasted?: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await window.osade?.githubLogin(pasted);
      if (result == null) throw new Error('the osade app is not running');
      if (!result.ok) {
        if ('need' in result && result.need === 'paste') {
          setPaste(true);
          setError(result.message);
          return;
        }
        throw new Error('error' in result ? result.error : 'sign-in failed');
      }
      setDevice(null);
      onSignedIn(result.login);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (status.signedIn && status.login) {
    return (
      <p style={{ margin: 0, color: 'var(--ink-2)', fontSize: 'var(--t-s)' }}>
        GitHub · {status.login}
      </p>
    );
  }

  return (
    <div>
      <p style={{ marginTop: 0, lineHeight: 1.45 }}>
        Sign in to GitHub so Osade can open pull requests and import issues. The token stays on
        this machine.
      </p>
      {device && (
        <p className="mono" style={{ fontSize: 'var(--t-m)', color: 'var(--ink)' }}>
          Enter {device.userCode} in the browser
        </p>
      )}
      {paste ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void login(token);
          }}
        >
          <input
            type="password"
            autoComplete="off"
            placeholder="Personal access token (repo scope)"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            style={{ marginBottom: 8 }}
          />
          <button className="primary" disabled={busy || token.trim().length === 0} type="submit">
            Save token
          </button>
        </form>
      ) : (
        <button className="primary" disabled={busy} onClick={() => void login()}>
          {busy ? 'Waiting on GitHub…' : 'Sign in with GitHub'}
        </button>
      )}
      {!paste && (
        <button
          disabled={busy}
          onClick={() => setPaste(true)}
          style={{ marginLeft: 8 }}
        >
          Use a token
        </button>
      )}
      {onSkip && (
        <button data-github-skip disabled={busy} onClick={onSkip} style={{ marginLeft: 8 }}>
          Not now
        </button>
      )}
      {error && (
        <p style={{ margin: '10px 0 0', color: 'var(--st-fail)', fontSize: 'var(--t-s)' }}>{error}</p>
      )}
    </div>
  );
}

export function useGithub(): {
  ready: boolean;
  status: GithubStatus;
  setStatus: (status: GithubStatus) => void;
} {
  const [status, setStatus] = useState<GithubStatus>({ signedIn: false, login: null });
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const pending = window.osade?.githubStatus() ?? Promise.resolve({ signedIn: false, login: null });
    void pending
      .then((next) => {
        if (cancelled) return;
        setStatus(next);
        setReady(true);
      })
      .catch(() => {
        if (cancelled) return;
        setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { ready, status, setStatus };
}
