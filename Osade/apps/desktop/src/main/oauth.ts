import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * GitHub sign-in — OSADE.md §18.1 `oauth.ts`.
 *
 * Device flow when `OSADE_GITHUB_CLIENT_ID` is set. Otherwise we reuse a GitHub CLI login
 * (`gh auth token`) so a machine that already talks to GitHub does not need a second OAuth app.
 * A pasted PAT is the last resort, handled by the caller.
 */

const execFileAsync = promisify(execFile);

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const USER_URL = 'https://api.github.com/user';
const SCOPES = 'repo,read:org';

export function githubClientId(): string {
  return (process.env.OSADE_GITHUB_CLIENT_ID ?? '').trim();
}

export interface DeviceBegin {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  intervalSec: number;
  expiresInSec: number;
}

export function parseDeviceBegin(body: unknown): DeviceBegin {
  const row = asRecord(body);
  const deviceCode = stringField(row, 'device_code');
  const userCode = stringField(row, 'user_code');
  const verificationUri =
    stringField(row, 'verification_uri_complete') || stringField(row, 'verification_uri');
  if (!deviceCode || !userCode || !verificationUri) {
    throw new Error('GitHub did not return a device code');
  }
  return {
    deviceCode,
    userCode,
    verificationUri,
    intervalSec: Math.max(1, numberField(row, 'interval') ?? 5),
    expiresInSec: numberField(row, 'expires_in') ?? 900,
  };
}

export function parseAccessToken(body: unknown): string | 'pending' | 'slow_down' {
  const row = asRecord(body);
  const error = stringField(row, 'error');
  if (error === 'authorization_pending') return 'pending';
  if (error === 'slow_down') return 'slow_down';
  if (error === 'expired_token') throw new Error('the GitHub sign-in code expired');
  if (error === 'access_denied') throw new Error('GitHub sign-in was denied');
  if (error) throw new Error(error);
  const token = stringField(row, 'access_token');
  if (!token) throw new Error('GitHub did not return an access token');
  return token;
}

export async function beginDeviceFlow(clientId: string, post = githubPost): Promise<DeviceBegin> {
  const body = await post(DEVICE_CODE_URL, { client_id: clientId, scope: SCOPES });
  return parseDeviceBegin(body);
}

export async function pollDeviceFlow(
  clientId: string,
  deviceCode: string,
  post = githubPost,
): Promise<string | 'pending' | 'slow_down'> {
  const body = await post(ACCESS_TOKEN_URL, {
    client_id: clientId,
    device_code: deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  });
  return parseAccessToken(body);
}

export async function githubLogin(token: string): Promise<string> {
  const response = await fetch(USER_URL, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'osade',
    },
  });
  if (!response.ok) throw new Error('that GitHub token was rejected');
  const body = (await response.json()) as { login?: unknown };
  if (typeof body.login !== 'string' || body.login.length === 0) {
    throw new Error('GitHub did not return a login');
  }
  return body.login;
}

export async function tokenFromGh(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token'], {
      timeout: 8_000,
      windowsHide: true,
    });
    const token = stdout.trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

export type GithubPost = (url: string, fields: Record<string, string>) => Promise<unknown>;

export async function githubPost(url: string, fields: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': 'osade',
    },
    body: new URLSearchParams(fields).toString(),
  });
  return (await response.json()) as unknown;
}

function asRecord(body: unknown): Record<string, unknown> {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  return {};
}

function stringField(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value : '';
}

function numberField(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
