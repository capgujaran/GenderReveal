/* Public browser client. Database policies, not this UI allowlist, authorize the host. */
(function (global) {
  'use strict';

  const HOST_EMAIL = 'pradeepb@icai.org';
  const SESSION_KEY = 'genderReveal.hostSession.v1';
  const TIMEOUT_MS = 12000;
  const CONFIG_MESSAGE = 'Live games are not connected yet. Please ask the host to finish the live-game setup.';
  const PARTY_MESSAGES = new Set([
    'Sign in with the verified host email to use host controls.',
    'Enter the six-letter game code.',
    'Your game entry is not valid. Join using the game code.',
    'Choose Word Scramble or Picture Puzzles.',
    'Game not found for this host.',
    'This game has ended. Create a new game code.',
    'Wait for at least one player to join before starting.',
    'Start the game and wait for the countdown before revealing results.',
    'Enter a player name from 1 to 24 characters.',
    'Game code not found. Please check the code with the host.',
    'This game has already started. Ask the host for the next game code.',
    'This game already has 200 players.',
    'Game not found.',
    'Progress can only be saved after the host starts the game and before results are revealed.',
    'Your result has already been submitted.',
    'Score is outside the allowed range.',
    'Results can only be submitted after the host starts the game and before the winner is revealed.',
    'Could not generate a game code. Please try again.'
  ]);
  let config = null;
  let session = null;
  let epoch = 0;
  let refreshPromise = null;

  function email(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
  }

  function jwtPayload(value) {
    try {
      const part = value.split('.')[1];
      if (!part) return null;
      const base64 = part.replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(global.atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')));
    } catch (_) {
      return null;
    }
  }

  function publicKey(value) {
    if (typeof value !== 'string') return null;
    const key = value.trim();
    if (!key || /\s/.test(key) || key.startsWith('sb_secret_')) return null;
    if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) return key;
    const payload = jwtPayload(key);
    return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key) && payload && payload.role === 'anon' ? key : null;
  }

  function parseConfig(value) {
    try {
      if (!value || typeof value.supabaseUrl !== 'string') return null;
      if (value.hostEmail && email(value.hostEmail) !== HOST_EMAIL) return null;
      const url = new URL(value.supabaseUrl.trim());
      const key = publicKey(value.publishableKey);
      if (url.protocol !== 'https:' || !url.hostname || url.username || url.password ||
          url.search || url.hash || url.pathname !== '/' || !key) return null;
      return Object.freeze({ url: url.origin, key: key });
    } catch (_) {
      return null;
    }
  }

  function validToken(value) {
    return typeof value === 'string' && value.length > 0 && !/\s/.test(value);
  }

  function storeSession() {
    try {
      if (session) global.sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
      else global.sessionStorage.removeItem(SESSION_KEY);
    } catch (_) {
      // Private browsing can reject storage; this tab still keeps its session in memory.
    }
  }

  function restoreSession() {
    if (!config) return null;
    try {
      const saved = JSON.parse(global.sessionStorage.getItem(SESSION_KEY));
      if (saved && saved.version === 1 && saved.project === config.url &&
          email(saved.email) === HOST_EMAIL && validToken(saved.accessToken) &&
          validToken(saved.refreshToken) && Number.isFinite(saved.expiresAt) && saved.expiresAt >= 0) {
        return saved;
      }
    } catch (_) {
      // A missing, malformed, or inaccessible saved session simply means signed out.
    }
    return null;
  }

  function configure(value) {
    const next = parseConfig(value);
    if (config && next && config.url === next.url && config.key === next.key) return true;
    config = next;
    epoch += 1;
    refreshPromise = null;
    session = restoreSession();
    return ready();
  }

  function ready() {
    return Boolean(config);
  }

  function hostSignedIn() {
    return Boolean(config && session && session.project === config.url &&
      email(session.email) === HOST_EMAIL && validToken(session.accessToken) && validToken(session.refreshToken));
  }

  function requireConfig() {
    if (!config) throw new Error(CONFIG_MESSAGE);
    return config;
  }

  function requireHostEmail(value) {
    if (email(value) !== HOST_EMAIL) throw new Error('Please enter the registered host ID.');
    return HOST_EMAIL;
  }

  function apiError(status, data, context) {
    const codeValue = data && (data.error_code || data.code);
    const code = typeof codeValue === 'string' && /^[A-Za-z0-9_]+$/.test(codeValue) ? codeValue : '';
    let message = 'That request could not be completed. Please try again.';
    if (context === 'rpc' && ['22023', '42501', 'P0001'].includes(code) && PARTY_MESSAGES.has(data.message)) {
      message = data.message;
    } else if (status === 429 || code === 'over_email_send_rate_limit' || code === 'over_request_rate_limit') {
      message = 'Please wait a minute before trying again.';
    } else if (code === 'otp_expired' || code === 'otp_disabled' || (context === 'verify' && (status === 400 || status === 403))) {
      message = 'That sign-in code is invalid or has expired. Please request a new code.';
    } else if (code === 'email_not_confirmed' || code === 'user_not_found' || code === 'signup_disabled') {
      message = 'The host account is not ready yet. Please complete the host email setup.';
    } else if (code === 'PGRST202' || code === 'PGRST205') {
      message = 'The live-game service needs its database setup. Please ask the host to finish setup.';
    } else if (status === 401) {
      message = context === 'rpc' ? 'Please sign in as the host again.' : 'Sign-in could not be verified. Please try again.';
    } else if (status === 403 || code === '42501') {
      message = 'This action is only available to the signed-in host.';
    } else if (status >= 500) {
      message = 'The live-game service is temporarily unavailable. Please try again shortly.';
    }
    const error = new Error(message);
    error.status = status;
    error.code = code;
    return error;
  }

  async function request(target, path, body, bearer, context) {
    const controller = new AbortController();
    const timeout = global.setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
    const headers = { apikey: target.key, 'Content-Type': 'application/json', Accept: 'application/json' };
    if (bearer) headers.Authorization = 'Bearer ' + bearer;
    try {
      const response = await global.fetch(target.url + path, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body || {}),
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        signal: controller.signal
      });
      const raw = await response.text();
      let data = null;
      if (raw) {
        try { data = JSON.parse(raw); }
        catch (_) {
          if (response.ok) throw new Error('The live-game service returned an unreadable response. Please try again.');
        }
      }
      if (!response.ok) throw apiError(response.status, data, context);
      return data;
    } catch (error) {
      if (controller.signal.aborted || (error && error.name === 'AbortError')) {
        throw new Error('The connection took too long. Please check your internet connection and try again.');
      }
      if (error && (error.status || /^The live-game service returned/.test(error.message))) throw error;
      throw new Error('Unable to reach the live game. Please check your internet connection and try again.');
    } finally {
      global.clearTimeout(timeout);
    }
  }

  function saveAuth(data, target, expectedEpoch) {
    if (expectedEpoch !== epoch || config !== target) throw new Error('Your host session changed. Please try again.');
    if (!data || !data.user || email(data.user.email) !== HOST_EMAIL ||
        !validToken(data.access_token) || !validToken(data.refresh_token)) {
      session = null;
      storeSession();
      throw new Error('This account is not the registered host. Please use the registered host ID.');
    }
    const jwt = jwtPayload(data.access_token);
    let expiresAt = Number(data.expires_at) * 1000;
    if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
      expiresAt = Number.isFinite(Number(data.expires_in)) && Number(data.expires_in) > 0
        ? Date.now() + Number(data.expires_in) * 1000 : Number(jwt && jwt.exp) * 1000;
    }
    session = {
      version: 1,
      project: target.url,
      email: HOST_EMAIL,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : 0
    };
    storeSession();
    return true;
  }

  async function requestHostCode(value) {
    const hostEmail = requireHostEmail(value);
    const target = requireConfig();
    await request(target, '/auth/v1/otp', { email: hostEmail, create_user: false }, null, 'otp');
    return true;
  }

  async function verifyHostCode(value, token) {
    const hostEmail = requireHostEmail(value);
    const target = requireConfig();
    const cleanToken = typeof token === 'string' ? token.trim() : '';
    if (!/^\d{6,10}$/.test(cleanToken)) throw new Error('Please enter the sign-in code from your email.');
    const expectedEpoch = ++epoch;
    refreshPromise = null;
    const data = await request(target, '/auth/v1/verify', { email: hostEmail, token: cleanToken, type: 'email' }, null, 'verify');
    return saveAuth(data, target, expectedEpoch);
  }

  async function refreshSession() {
    if (refreshPromise) return refreshPromise;
    const target = requireConfig();
    if (!hostSignedIn()) throw new Error('Please sign in as the host first.');
    const expectedEpoch = epoch;
    const oldRefreshToken = session.refreshToken;
    const operation = (async function () {
      try {
        const data = await request(target, '/auth/v1/token?grant_type=refresh_token', { refresh_token: oldRefreshToken }, null, 'refresh');
        saveAuth(data, target, expectedEpoch);
        return session.accessToken;
      } catch (error) {
        if (expectedEpoch === epoch && error && (error.status === 400 || error.status === 401 || error.status === 403)) {
          session = null;
          storeSession();
          throw new Error('Your host session has expired. Please sign in again.');
        }
        throw error;
      }
    })();
    refreshPromise = operation;
    try { return await operation; }
    finally { if (refreshPromise === operation) refreshPromise = null; }
  }

  async function hostToken() {
    if (!hostSignedIn()) throw new Error('Please sign in as the host first.');
    if (session.expiresAt <= Date.now() + 30000) return refreshSession();
    return session.accessToken;
  }

  async function rpc(name, args, options) {
    if (typeof name !== 'string' || !/^party_[a-z_]+$/.test(name)) throw new Error('This game action is unavailable.');
    if (args !== undefined && (!args || typeof args !== 'object' || Array.isArray(args))) throw new Error('The game action needs valid details.');
    const target = requireConfig();
    const asHost = Boolean(options && options.host);
    const expectedEpoch = epoch;
    let bearer = asHost ? await hostToken() : null;
    if (config !== target || (asHost && expectedEpoch !== epoch)) throw new Error('Your host session changed. Please try again.');
    try {
      return await request(target, '/rest/v1/rpc/' + name, args, bearer, 'rpc');
    } catch (error) {
      if (!asHost || !error || error.status !== 401) throw error;
      if (config !== target || expectedEpoch !== epoch || !hostSignedIn()) throw new Error('Please sign in as the host again.');
      // Concurrent requests may already have refreshed the access token.
      bearer = session.accessToken !== bearer ? await hostToken() : await refreshSession();
      if (config !== target || expectedEpoch !== epoch || !hostSignedIn()) throw new Error('Please sign in as the host again.');
      return request(target, '/rest/v1/rpc/' + name, args, bearer, 'rpc');
    }
  }

  async function signOut() {
    const target = config;
    const bearer = session && session.accessToken;
    epoch += 1;
    session = null;
    refreshPromise = null;
    storeSession();
    if (target && bearer) {
      try { await request(target, '/auth/v1/logout?scope=local', {}, bearer, 'logout'); }
      catch (_) { /* The local session is cleared even if the connection is unavailable. */ }
    }
    return true;
  }

  global.PartyApi = Object.freeze({
    configure: configure,
    ready: ready,
    hostSignedIn: hostSignedIn,
    requestHostCode: requestHostCode,
    verifyHostCode: verifyHostCode,
    signOut: signOut,
    rpc: rpc
  });
  configure(global.PARTY_CONFIG);
})(window);
