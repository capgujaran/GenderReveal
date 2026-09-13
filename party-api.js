/* Firebase browser client. Firestore rules authorize hosts and protect unrevealed scores. */
(function (global) {
  'use strict';

  const HOST_EMAIL = 'pradeepb@icai.org';
  const SDK_BASE = 'https://www.gstatic.com/firebasejs/12.18.0/';
  const CONFIG_MESSAGE = 'Live games need Firebase setup. Ask the host to configure the Firebase project and publish the game rules.';
  const INVALID_ENTRY = 'Your game entry is not valid. Join using the game code.';
  const START_DELAY = 5000;
  const TIMEOUT = 18000;
  const MAX_SCORE = Object.freeze({ words: 20, jigsaw: 120 });
  let config = null;
  let epoch = 0;
  let loading = null;
  let clients = null;
  let modulesPromise = null;

  function partyError(message) {
    const error = new Error(message);
    error.partyMessage = true;
    return error;
  }
  function email(value) { return typeof value === 'string' ? value.trim().toLowerCase() : ''; }
  function monotonicNow() { return global.performance ? global.performance.now() : Date.now(); }
  function millis(value) { return value && typeof value.toMillis === 'function' ? value.toMillis() : null; }
  function iso(value) { const ms = millis(value); return ms === null ? null : new Date(ms).toISOString(); }
  function exists(snapshot) { return Boolean(snapshot && snapshot.exists()); }
  function roomCode(value) {
    const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
    if (!/^[A-Z]{6}$/.test(code)) throw partyError('Enter the six-letter game code.');
    return code;
  }
  function playerName(value) {
    const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
    if (!name || Array.from(name).length > 24 || /[\u0000-\u001f\u007f]/.test(name)) {
      throw partyError('Enter a player name from 1 to 24 characters.');
    }
    return name;
  }
  function scoreOf(value, game) {
    if (!Number.isInteger(value) || value < 0 || value > MAX_SCORE[game]) throw partyError('Score is outside the allowed range.');
    return value;
  }
  function parseConfig(value) {
    if (!value || value.provider !== 'firebase' || (value.hostEmail && email(value.hostEmail) !== HOST_EMAIL) || !value.firebase) return null;
    const firebase = {};
    for (const key of ['apiKey', 'authDomain', 'projectId', 'storageBucket', 'messagingSenderId', 'appId']) {
      const item = value.firebase[key];
      if (item === undefined || item === null || item === '') {
        if (key === 'storageBucket' || key === 'messagingSenderId') continue;
        return null;
      }
      if (typeof item !== 'string' || !item.trim() || /\s/.test(item.trim()) || item.length > 512) return null;
      firebase[key] = item.trim();
    }
    return Object.freeze(firebase);
  }
  function ready() { return Boolean(config); }
  function sameConfig(a, b) { return a && b && JSON.stringify(a) === JSON.stringify(b); }

  function failWaiters(watch, error) {
    watch.error = error;
    for (const waiter of watch.waiters.splice(0)) { global.clearTimeout(waiter.timer); waiter.reject(error); }
  }
  function disposeWatch(watch) {
    if (!watch) return;
    watch.closed = true;
    if (watch.stop) watch.stop();
    failWaiters(watch, partyError('Your game session changed. Please try again.'));
  }
  function disposeRoom(client) {
    if (!client || !client.room) return;
    Object.values(client.room.watches).forEach(disposeWatch);
    client.room = null;
  }
  function disposeClient(client) {
    if (!client) return;
    disposeRoom(client);
    disposeWatch(client.rooms);
    client.rooms = null;
    if (client.stopAuth) client.stopAuth();
  }
  function configure(value) {
    const next = parseConfig(value);
    if (sameConfig(config, next)) return true;
    epoch += 1;
    if (clients) { disposeClient(clients.host); disposeClient(clients.player); }
    config = next;
    clients = null;
    loading = null;
    return ready();
  }

  function mapError(error, context) {
    if (error && error.partyMessage) return error;
    const code = String(error && error.code || '');
    let message = 'Unable to reach the live game. Check your internet connection and try again.';
    if (code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found') {
      message = 'The host email or password is incorrect. Try again or reset your password.';
    } else if (code === 'auth/operation-not-allowed' || code === 'auth/admin-restricted-operation') {
      message = context === 'player' ? 'Player access is not enabled. Ask the host to enable Anonymous sign-in in Firebase.' : 'This sign-in method is not enabled. Ask the host to enable Email/Password or Google sign-in in Firebase.';
    } else if (code === 'auth/unauthorized-domain') {
      message = 'Add this GitHub Pages domain to Firebase Authentication authorized domains, then try again.';
    } else if (code === 'auth/invalid-api-key' || code === 'auth/app-not-authorized' || code === 'auth/configuration-not-found') {
      message = 'The Firebase configuration is incomplete or invalid. Ask the host to check the Firebase web app settings.';
    } else if (code === 'auth/popup-blocked') {
      message = 'Allow the Google sign-in popup, or sign in with your host email and password.';
    } else if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
      message = 'Sign-in was cancelled. Please try again.';
    } else if (code === 'auth/too-many-requests' || code === 'resource-exhausted') {
      message = 'Too many requests right now. Wait a minute and try again.';
    } else if (code === 'auth/user-disabled' || code === 'auth/user-token-expired' || code === 'unauthenticated') {
      message = context === 'player' ? INVALID_ENTRY : 'Please sign in as the host again.';
    } else if (code === 'permission-denied') {
      message = 'Firebase blocked this action. Ask the host to publish the Gender Reveal Firestore rules and verify host access.';
    } else if (code === 'failed-precondition') {
      message = 'The Firebase database needs its game rules or indexes. Ask the host to finish Firebase setup.';
    }
    const result = partyError(message);
    result.code = code;
    return result;
  }
  async function bounded(promise) {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = global.setTimeout(() => reject(partyError('The connection took too long. Check your connection and try again.')), TIMEOUT);
      })]);
    } finally { global.clearTimeout(timer); }
  }
  async function sdk() {
    if (!modulesPromise) {
      modulesPromise = Promise.all([
        import(SDK_BASE + 'firebase-app.js'),
        import(SDK_BASE + 'firebase-auth.js'),
        import(SDK_BASE + 'firebase-firestore.js')
      ]).then(([app, auth, store]) => ({ app, auth, store })).catch(error => { modulesPromise = null; throw error; });
    }
    return modulesPromise;
  }
  async function whenReady() {
    if (!config) throw partyError(CONFIG_MESSAGE);
    if (clients) return true;
    if (!loading) {
      const expected = epoch;
      const settings = config;
      const operation = (async () => {
        const lib = await bounded(sdk());
        if (expected !== epoch) throw partyError('Your game configuration changed. Please try again.');
        async function create(kind) {
          const appName = kind === 'host' ? 'gender-reveal-host' : 'gender-reveal-player';
          let app = lib.app.getApps().find(item => item.name === appName);
          if (app && !Object.keys(settings).every(key => app.options[key] === settings[key])) {
            await lib.app.deleteApp(app);
            app = null;
          }
          app = app || lib.app.initializeApp(settings, appName);
          const auth = lib.auth.getAuth(app);
          await bounded(auth.authStateReady());
          const client = { kind, lib, app, auth, db: lib.store.getFirestore(app), room: null, rooms: null,
            clock: null, clockPromise: null, anonymousPromise: null, uid: auth.currentUser && auth.currentUser.uid, expected };
          client.stopAuth = lib.auth.onAuthStateChanged(auth, user => {
            const uid = user && user.uid;
            if (uid !== client.uid) {
              disposeRoom(client);
              disposeWatch(client.rooms);
              client.rooms = null;
              client.clock = null;
              client.clockPromise = null;
              client.uid = uid;
            }
          });
          return client;
        }
        const created = await Promise.all([create('host'), create('player')]);
        if (expected !== epoch) { created.forEach(disposeClient); throw partyError('Your game configuration changed. Please try again.'); }
        clients = { host: created[0], player: created[1] };
        return true;
      })();
      loading = operation;
      operation.catch(() => { if (loading === operation) loading = null; });
    }
    return loading;
  }
  function verifyCurrent(client) {
    if (client.expected !== epoch || !clients || clients[client.kind] !== client) throw partyError('Your game session changed. Please try again.');
  }
  function verifiedHost(user) { return Boolean(user && user.emailVerified && email(user.email) === HOST_EMAIL); }
  function hostSignedIn() { return Boolean(config && clients && verifiedHost(clients.host.auth.currentUser)); }
  function requireHostId(value) {
    if (email(value) !== HOST_EMAIL) throw partyError('Please enter the registered host ID.');
    return HOST_EMAIL;
  }
  async function syncClock(client) {
    const user = client.auth.currentUser;
    if (!user) throw partyError(client.kind === 'host' ? 'Please sign in as the host first.' : INVALID_ENTRY);
    if (client.clock && client.clock.uid === user.uid) return;
    if (client.clockPromise) return client.clockPromise;
    const operation = (async () => {
      const f = client.lib.store;
      const reference = f.doc(client.db, 'genderRevealClocks', user.uid);
      const before = monotonicNow();
      await f.setDoc(reference, { at: f.serverTimestamp() });
      const snapshot = await f.getDocFromServer(reference);
      const after = monotonicNow();
      verifyCurrent(client);
      if (!client.auth.currentUser || client.auth.currentUser.uid !== user.uid) throw partyError('Your game session changed. Please try again.');
      const at = exists(snapshot) ? millis(snapshot.data().at) : null;
      if (at === null) throw partyError('The live-game clock could not be synchronized. Please try again.');
      client.clock = { uid: user.uid, at, monotonic: (before + after) / 2 };
    })();
    client.clockPromise = operation;
    try { await bounded(operation); }
    finally { if (client.clockPromise === operation) client.clockPromise = null; }
  }
  function serverNow(client) { return client.clock ? client.clock.at + monotonicNow() - client.clock.monotonic : Date.now(); }
  async function hostClient() {
    await whenReady();
    const client = clients.host;
    if (!verifiedHost(client.auth.currentUser)) throw partyError('Sign in with the verified host email to use host controls.');
    await syncClock(client);
    verifyCurrent(client);
    return client;
  }
  async function playerClient(allowCreate) {
    await whenReady();
    const client = clients.player;
    if (!client.auth.currentUser) {
      if (!allowCreate) throw partyError(INVALID_ENTRY);
      if (!client.anonymousPromise) client.anonymousPromise = client.lib.auth.signInAnonymously(client.auth);
      const operation = client.anonymousPromise;
      try { await operation; } finally { if (client.anonymousPromise === operation) client.anonymousPromise = null; }
    }
    verifyCurrent(client);
    if (!client.auth.currentUser || !client.auth.currentUser.isAnonymous) throw partyError(INVALID_ENTRY);
    await syncClock(client);
    return client;
  }
  async function finishHostSignIn(client, credential) {
    verifyCurrent(client);
    await client.lib.auth.reload(credential.user);
    if (!verifiedHost(credential.user)) {
      await client.lib.auth.signOut(client.auth);
      throw partyError('Use the verified host account pradeepb@icai.org. Verify this email before signing in.');
    }
    await credential.user.getIdToken(true);
    await syncClock(client);
    return true;
  }
  async function signInHost(value, password) {
    const hostEmail = requireHostId(value);
    if (typeof password !== 'string' || !password) throw partyError('Please enter your host account password.');
    try {
      await whenReady();
      const client = clients.host;
      return await finishHostSignIn(client, await client.lib.auth.signInWithEmailAndPassword(client.auth, hostEmail, password));
    } catch (error) { throw mapError(error, 'host'); }
  }
  async function signInHostWithGoogle(value) {
    const hostEmail = requireHostId(value);
    try {
      await whenReady();
      const client = clients.host;
      const provider = new client.lib.auth.GoogleAuthProvider();
      provider.setCustomParameters({ login_hint: hostEmail, prompt: 'select_account' });
      return await finishHostSignIn(client, await client.lib.auth.signInWithPopup(client.auth, provider));
    } catch (error) { throw mapError(error, 'host'); }
  }
  async function sendHostPasswordReset(value) {
    const hostEmail = requireHostId(value);
    try {
      await whenReady();
      await clients.host.lib.auth.sendPasswordResetEmail(clients.host.auth, hostEmail);
      return true;
    } catch (error) { throw mapError(error, 'host'); }
  }
  async function signOut() {
    if (!clients) return true;
    const client = clients.host;
    disposeRoom(client);
    disposeWatch(client.rooms);
    client.rooms = null;
    client.clock = null;
    try { await client.lib.auth.signOut(client.auth); return true; }
    catch (error) { throw mapError(error, 'host'); }
  }

  function makeWatch(client, target) {
    const watch = { value: null, hasValue: false, connected: false, waiters: [], error: null, closed: false, stop: null };
    watch.stop = client.lib.store.onSnapshot(target, { includeMetadataChanges: true }, snapshot => {
      if (watch.closed || client.expected !== epoch) return;
      watch.connected = !snapshot.metadata.fromCache;
      if (snapshot.metadata.hasPendingWrites || !watch.connected) return;
      watch.value = snapshot;
      watch.hasValue = true;
      watch.error = null;
      for (const waiter of [...watch.waiters]) {
        if (!waiter.accept || waiter.accept(snapshot)) {
          watch.waiters.splice(watch.waiters.indexOf(waiter), 1);
          global.clearTimeout(waiter.timer);
          waiter.resolve(snapshot);
        }
      }
    }, error => { if (!watch.closed) failWaiters(watch, error); });
    return watch;
  }
  function waitFor(watch, accept) {
    if (watch.error) return Promise.reject(watch.error);
    if (watch.hasValue && watch.connected && (!accept || accept(watch.value))) return Promise.resolve(watch.value);
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, accept, timer: null };
      waiter.timer = global.setTimeout(() => {
        const index = watch.waiters.indexOf(waiter);
        if (index >= 0) watch.waiters.splice(index, 1);
        reject(partyError('The connection took too long. Check your connection and try again.'));
      }, TIMEOUT);
      watch.waiters.push(waiter);
    });
  }
  function getWatch(client, name, target) {
    const cache = client.room.watches;
    if (cache[name] && cache[name].error) { disposeWatch(cache[name]); delete cache[name]; }
    if (!cache[name]) cache[name] = makeWatch(client, target);
    return cache[name];
  }
  function ensureRoom(client, code) {
    verifyCurrent(client);
    const uid = client.auth.currentUser && client.auth.currentUser.uid;
    if (!uid) throw partyError(client.kind === 'host' ? 'Please sign in as the host first.' : INVALID_ENTRY);
    if (!client.room || client.room.code !== code || client.room.uid !== uid) {
      disposeRoom(client);
      client.room = { code, uid, watches: {} };
    }
    return client.room;
  }
  function roomRef(client, code) { return client.lib.store.doc(client.db, 'genderRevealRooms', code); }
  function checkRoom(data, client, asHost) {
    if (!data) throw partyError('Game not found.');
    if (asHost && data.hostId !== client.auth.currentUser.uid) throw partyError('Game not found for this host.');
    return data;
  }
  function resultPlayer(data, room, known) {
    const finishedAt = known ? millis(data.finishedAt) : null;
    const startedAt = millis(room.startedAt);
    return { id: data.uid, name: data.name, finished: finishedAt !== null,
      score: known ? data.score : null, max_score: MAX_SCORE[room.game],
      time_ms: finishedAt === null || startedAt === null ? null : Math.max(0, finishedAt - startedAt - START_DELAY) };
  }
  function roomSummary(room, client) {
    const startedAt = millis(room.startedAt);
    return { id: room.code, code: room.code, game: room.game, status: room.status, created_at: iso(room.createdAt),
      starts_at: startedAt === null ? null : new Date(startedAt + START_DELAY).toISOString(),
      revealed_at: iso(room.revealedAt), server_now: new Date(serverNow(client)).toISOString() };
  }
  async function view(client, code, asHost) {
    const selected = ensureRoom(client, code);
    const f = client.lib.store;
    const roomSnapshot = await waitFor(getWatch(client, 'room', roomRef(client, code)));
    const room = checkRoom(exists(roomSnapshot) ? roomSnapshot.data() : null, client, asHost);
    if (client.room !== selected) throw partyError('Your game session changed. Please try again.');
    // Own document reads are allowed before joining; validate membership before roster queries.
    const ownSnapshot = !asHost ? await waitFor(getWatch(client, 'self', f.doc(client.db, 'genderRevealRooms', code, 'players', selected.uid))) : null;
    if (client.room !== selected) throw partyError('Your game session changed. Please try again.');
    if (!asHost && !exists(ownSnapshot)) throw partyError(INVALID_ENTRY);
    const rosterSnapshot = await waitFor(getWatch(client, 'roster', f.collection(client.db, 'genderRevealRooms', code, 'roster')));
    if (client.room !== selected) throw partyError('Your game session changed. Please try again.');
    let players;
    if (asHost || room.status === 'revealed') {
      const all = await waitFor(getWatch(client, 'players', f.collection(client.db, 'genderRevealRooms', code, 'players')));
      players = all.docs.map(item => resultPlayer(item.data(), room, true));
    } else {
      players = rosterSnapshot.docs.map(item => resultPlayer(item.data(), room, false));
    }
    if (client.room !== selected) throw partyError('Your game session changed. Please try again.');
    verifyCurrent(client);
    const snapshot = Object.assign(roomSummary(room, client), { players });
    if (ownSnapshot) snapshot.self = resultPlayer(ownSnapshot.data(), room, true);
    return snapshot;
  }
  async function freshRoom(client, code) {
    const snapshot = await client.lib.store.getDocFromServer(roomRef(client, code));
    const selected = client.room;
    if (selected && selected.code === code && selected.watches.room && !snapshot.metadata.hasPendingWrites) {
      selected.watches.room.value = snapshot;
      selected.watches.room.hasValue = true;
      selected.watches.room.connected = true;
    }
    return checkRoom(exists(snapshot) ? snapshot.data() : null, client, client.kind === 'host');
  }
  async function freshSelf(client, code) {
    const snapshot = await client.lib.store.getDocFromServer(client.lib.store.doc(client.db, 'genderRevealRooms', code, 'players', client.auth.currentUser.uid));
    if (!exists(snapshot)) throw partyError(INVALID_ENTRY);
    if (client.room && client.room.code === code && client.room.watches.self && !snapshot.metadata.hasPendingWrites) {
      client.room.watches.self.value = snapshot;
      client.room.watches.self.hasValue = true;
      client.room.watches.self.connected = true;
    }
    return snapshot.data();
  }
  function randomCode() {
    let code = '';
    while (code.length < 6) {
      const bytes = new Uint8Array(12);
      global.crypto.getRandomValues(bytes);
      for (const value of bytes) { if (value < 234 && code.length < 6) code += String.fromCharCode(65 + value % 26); }
    }
    return code;
  }
  async function createRoom(client, game) {
    if (!Object.hasOwn(MAX_SCORE, game)) throw partyError('Choose Word Scramble or Picture Puzzles.');
    const f = client.lib.store;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const code = randomCode();
      const reference = roomRef(client, code);
      const created = await f.runTransaction(client.db, async transaction => {
        if (exists(await transaction.get(reference))) return false;
        transaction.set(reference, { code, hostId: client.auth.currentUser.uid, game, status: 'waiting',
          createdAt: f.serverTimestamp(), startedAt: null, revealedAt: null, playerCount: 0 });
        return true;
      });
      if (created) { await freshRoom(client, code); return view(client, code, true); }
    }
    throw partyError('Could not generate a game code. Please try again.');
  }
  async function hostRooms(client) {
    const f = client.lib.store;
    if (client.rooms && client.rooms.error) { disposeWatch(client.rooms); client.rooms = null; }
    if (!client.rooms) client.rooms = makeWatch(client, f.query(f.collection(client.db, 'genderRevealRooms'),
      f.where('hostId', '==', client.auth.currentUser.uid), f.orderBy('createdAt', 'desc'), f.limit(50)));
    const snapshot = await waitFor(client.rooms);
    return snapshot.docs.map(item => roomSummary(item.data(), client));
  }
  async function hostChange(client, code, action) {
    const f = client.lib.store;
    await f.runTransaction(client.db, async transaction => {
      const reference = roomRef(client, code);
      const snapshot = await transaction.get(reference);
      const room = checkRoom(exists(snapshot) ? snapshot.data() : null, client, true);
      if (action === 'start') {
        if (room.status === 'running') return;
        if (room.status !== 'waiting') throw partyError('This game has ended. Create a new game code.');
        if (room.playerCount < 1) throw partyError('Wait for at least one player to join before starting.');
        transaction.update(reference, { status: 'running', startedAt: f.serverTimestamp() });
      } else {
        if (room.status === 'revealed') return;
        if (room.status !== 'running' || serverNow(client) < millis(room.startedAt) + START_DELAY) {
          throw partyError('Start the game and wait for the countdown before revealing results.');
        }
        transaction.update(reference, { status: 'revealed', revealedAt: f.serverTimestamp() });
      }
    });
    await freshRoom(client, code);
    return view(client, code, true);
  }
  function requireToken(client, token) {
    if (!client.auth.currentUser || token !== 'firebase:' + client.auth.currentUser.uid) throw partyError(INVALID_ENTRY);
  }
  async function join(client, code, value) {
    const name = playerName(value);
    const f = client.lib.store;
    const uid = client.auth.currentUser.uid;
    await f.runTransaction(client.db, async transaction => {
      const reference = roomRef(client, code);
      const roster = f.doc(client.db, 'genderRevealRooms', code, 'roster', uid);
      const player = f.doc(client.db, 'genderRevealRooms', code, 'players', uid);
      const roomSnapshot = await transaction.get(reference);
      const rosterSnapshot = await transaction.get(roster);
      const playerSnapshot = await transaction.get(player);
      if (!exists(roomSnapshot)) throw partyError('Game code not found. Please check the code with the host.');
      const room = roomSnapshot.data();
      if (exists(rosterSnapshot) && exists(playerSnapshot)) return;
      if (exists(rosterSnapshot) || exists(playerSnapshot)) throw partyError(INVALID_ENTRY);
      if (room.status !== 'waiting') throw partyError('This game has already started. Ask the host for the next game code.');
      if (room.playerCount >= 200) throw partyError('This game already has 200 players.');
      transaction.set(roster, { uid, name, joinedAt: f.serverTimestamp() });
      transaction.set(player, { uid, name, score: 0, createdAt: f.serverTimestamp(), updatedAt: f.serverTimestamp(), finishedAt: null });
      transaction.update(reference, { playerCount: room.playerCount + 1 });
    });
    await freshRoom(client, code);
    return { token: 'firebase:' + uid, room: await view(client, code, false) };
  }
  async function saveProgress(client, code, value, finishing) {
    const f = client.lib.store;
    const uid = client.auth.currentUser.uid;
    const savedScore = await f.runTransaction(client.db, async transaction => {
      const reference = roomRef(client, code);
      const player = f.doc(client.db, 'genderRevealRooms', code, 'players', uid);
      const roomSnapshot = await transaction.get(reference);
      const playerSnapshot = await transaction.get(player);
      const room = checkRoom(exists(roomSnapshot) ? roomSnapshot.data() : null, client, false);
      if (!exists(playerSnapshot)) throw partyError(INVALID_ENTRY);
      const previous = playerSnapshot.data();
      const score = scoreOf(value, room.game);
      if (millis(previous.finishedAt) !== null) return previous.score;
      if (room.status !== 'running' || serverNow(client) < millis(room.startedAt) + START_DELAY) {
        throw partyError(finishing ? 'Results can only be submitted after the host starts the game and before the winner is revealed.' : 'Progress can only be saved after the host starts the game and before results are revealed.');
      }
      if (!finishing && score <= previous.score) return previous.score;
      const changes = { score: Math.max(previous.score, score), updatedAt: f.serverTimestamp() };
      if (finishing) changes.finishedAt = f.serverTimestamp();
      transaction.update(player, changes);
      return changes.score;
    });
    if (!finishing) return { score: savedScore, server_now: new Date(serverNow(client)).toISOString() };
    await Promise.all([freshRoom(client, code), freshSelf(client, code)]);
    return view(client, code, false);
  }
  async function rpc(name, args, options) {
    if (!args) args = {};
    if (typeof args !== 'object' || Array.isArray(args)) throw partyError('The game action needs valid details.');
    const hostActions = ['party_host_create', 'party_host_rooms', 'party_host_view', 'party_host_start', 'party_host_reveal'];
    const playerActions = ['party_join', 'party_view', 'party_progress', 'party_finish'];
    const asHost = Boolean(options && options.host);
    if (!(asHost ? hostActions : playerActions).includes(name)) throw partyError('This game action is unavailable.');
    try {
      const client = asHost ? await hostClient() : await playerClient(name === 'party_join');
      let result;
      if (name === 'party_host_create') result = await createRoom(client, args.p_game);
      else if (name === 'party_host_rooms') result = await hostRooms(client);
      else {
        const code = roomCode(args.p_code);
        if (!asHost && name !== 'party_join') requireToken(client, args.p_token);
        if (name === 'party_join') result = await join(client, code, args.p_name);
        else if (name === 'party_host_start' || name === 'party_host_reveal') result = await hostChange(client, code, name === 'party_host_start' ? 'start' : 'reveal');
        else if (name === 'party_progress' || name === 'party_finish') result = await saveProgress(client, code, args.p_score, name === 'party_finish');
        else result = await view(client, code, asHost);
      }
      verifyCurrent(client);
      return result;
    } catch (error) { throw mapError(error, asHost ? 'host' : 'player'); }
  }

  global.PartyApi = Object.freeze({ configure, ready, whenReady, hostSignedIn, signInHost,
    signInHostWithGoogle, sendHostPasswordReset, signOut, rpc });
  configure(global.PARTY_CONFIG);
})(window);
