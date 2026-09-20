import { describe, expect, it } from 'vitest';

import { parseAccessToken, parseDeviceBegin } from '../src/main/oauth.js';

describe('GitHub device flow parsing', () => {
  it('reads the user code and complete verification URL', () => {
    const begin = parseDeviceBegin({
      device_code: 'dev',
      user_code: 'ABCD-1234',
      verification_uri: 'https://github.com/login/device',
      verification_uri_complete: 'https://github.com/login/device?user_code=ABCD-1234',
      interval: 5,
      expires_in: 900,
    });
    expect(begin.userCode).toBe('ABCD-1234');
    expect(begin.verificationUri).toContain('ABCD-1234');
    expect(begin.intervalSec).toBe(5);
  });

  it('accepts numeric fields as strings', () => {
    const begin = parseDeviceBegin({
      device_code: 'dev',
      user_code: 'ABCD-1234',
      verification_uri: 'https://github.com/login/device',
      interval: '7',
      expires_in: '900',
    });
    expect(begin.intervalSec).toBe(7);
    expect(begin.expiresInSec).toBe(900);
  });

  it('treats authorization_pending as wait, not failure', () => {
    expect(parseAccessToken({ error: 'authorization_pending' })).toBe('pending');
    expect(parseAccessToken({ error: 'slow_down' })).toBe('slow_down');
  });

  it('returns the access token', () => {
    expect(parseAccessToken({ access_token: 'gho_x' })).toBe('gho_x');
  });
});
