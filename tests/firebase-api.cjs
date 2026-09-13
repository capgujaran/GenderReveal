/* Contract tests with an in-memory Firebase SDK; never connects to Firebase. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '..', 'party-api.js'), 'utf8').replace(/\bimport\(/g, '__testImport(');
const SENTINEL = Symbol('serverTimestamp');
const config = { provider: 'firebase', hostEmail: 'pradeepb@icai.org', firebase: {
  apiKey: 'example-public-key', authDomain: 'example.firebaseapp.com', projectId: 'example-project',
  storageBucket: '', messagingSenderId: '', appId: '1:123:web:example'
} };
class Timestamp { constructor(value) { this.value = value; } toMillis() { return this.value; } }
const clone = value => value instanceof Timestamp ? new Timestamp(value.value) : Array.isArray(value)
  ? value.map(clone) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)])) : value;
const server = { data: new Map(), watches: new Set(), now: 1800000000000, uid: 0, version: 0 };
function browser(options = {}) {
  const apps = new Map();
  const metrics = { imports: 0, anonymous: 0, reads: 0, writes: 0, privateLists: 0, deniedLists: 0, authReset: 0 };
  let nextHostUser = null;
  function user(fields) { return Object.assign({ uid: 'verified-host-000000000000001', email: 'pradeepb@icai.org', emailVerified: true, isAnonymous: false, getIdToken: async () => 'token' }, fields); }
  function authChanged(auth, value) { auth.currentUser = value; auth.listeners.forEach(callback => callback(value)); }
  function ref(db, parts, kind = 'doc') { return { db, path: parts.join('/'), kind }; }
  function current(ref) { return ref.db.app.auth.currentUser; }
  function documentSnapshot(reference) {
    const value = server.data.get(reference.path);
    return { id: reference.path.split('/').at(-1), metadata: { hasPendingWrites: false, fromCache: false }, exists: () => value !== undefined, data: () => clone(value) };
  }
  function snapshot(reference) {
    if (reference.kind === 'doc') return documentSnapshot(reference);
    const match = reference.path.match(/^genderRevealRooms\/([A-Z]{6})\/players$/);
    if (match) {
      const room = server.data.get('genderRevealRooms/' + match[1]);
      const who = current(reference);
      if (!who || (who.uid !== room?.hostId && room?.status !== 'revealed')) {
        metrics.deniedLists += 1;
        throw Object.assign(new Error('private scores'), { code: 'permission-denied' });
      }
      metrics.privateLists += 1;
    }
    let entries = [...server.data].filter(([key]) => key.startsWith(reference.path + '/') && key.split('/').length === reference.path.split('/').length + 1);
    for (const constraint of reference.constraints || []) {
      if (constraint.kind === 'where') entries = entries.filter(([, value]) => value[constraint.field] === constraint.value);
      if (constraint.kind === 'order') entries.sort((a, b) => (a[1][constraint.field].toMillis() - b[1][constraint.field].toMillis()) * (constraint.direction === 'desc' ? -1 : 1));
      if (constraint.kind === 'limit') entries = entries.slice(0, constraint.value);
    }
    return { docs: entries.map(([key]) => documentSnapshot({ path: key })), metadata: { hasPendingWrites: false, fromCache: false } };
  }
  function emit() { for (const watcher of server.watches) queueMicrotask(() => { if (!watcher.closed) { try { watcher.callback(snapshot(watcher.reference)); } catch (error) { watcher.error(error); } } }); }
  function canonical(value) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, item === SENTINEL ? new Timestamp(server.now) : clone(item)]));
  }
  const app = {
    getApps: () => [...apps.values()],
    initializeApp(settings, name) {
      const created = { name, options: settings, auth: { currentUser: name === 'gender-reveal-host' && options.restoredHost ? user() : null, listeners: new Set(), authStateReady: async () => {} } };
      apps.set(name, created); return created;
    },
    deleteApp: async value => { apps.delete(value.name); }
  };
  const auth = {
    getAuth: app => app.auth,
    onAuthStateChanged(value, callback) { value.listeners.add(callback); queueMicrotask(() => callback(value.currentUser)); return () => value.listeners.delete(callback); },
    async signInAnonymously(value) { metrics.anonymous += 1; const result = user({ uid: 'guest-' + String(++server.uid).padStart(28, '0'), email: null, emailVerified: false, isAnonymous: true }); authChanged(value, result); return { user: result }; },
    async signInWithEmailAndPassword(value, email, password) { if (password !== 'host-password') throw { code: 'auth/invalid-credential' }; const result = nextHostUser || user(); nextHostUser = null; authChanged(value, result); return { user: result }; },
    async signInWithPopup(value) { const result = nextHostUser || user(); nextHostUser = null; authChanged(value, result); return { user: result }; },
    GoogleAuthProvider: class { setCustomParameters(value) { this.parameters = value; } },
    reload: async () => {},
    sendPasswordResetEmail: async () => { metrics.authReset += 1; },
    signOut: async value => authChanged(value, null)
  };
  const store = {
    getFirestore: app => ({ app }),
    doc: (db, ...parts) => ref(db, parts),
    collection: (db, ...parts) => ref(db, parts, 'collection'),
    query: (reference, ...constraints) => ({ ...reference, constraints }),
    where: (field, operator, value) => ({ kind: 'where', field, value }),
    orderBy: (field, direction) => ({ kind: 'order', field, direction }),
    limit: value => ({ kind: 'limit', value }),
    serverTimestamp: () => SENTINEL,
    async setDoc(reference, value) { metrics.writes += 1; server.data.set(reference.path, canonical(value)); server.version += 1; emit(); },
    async getDocFromServer(reference) { metrics.reads += 1; return documentSnapshot(reference); },
    onSnapshot(reference, options, callback, error) {
      const watcher = { reference, callback, error, closed: false }; server.watches.add(watcher);
      queueMicrotask(() => { if (!watcher.closed) { try { callback(snapshot(reference)); } catch (failure) { error(failure); } } });
      return () => { watcher.closed = true; server.watches.delete(watcher); };
    },
    async runTransaction(db, action) {
      for (let retry = 0; retry < 10; retry += 1) {
        const version = server.version;
        const writes = [];
        const result = await action({
          get: async reference => { assert.equal(writes.length, 0, 'all transaction reads precede writes'); metrics.reads += 1; return documentSnapshot(reference); },
          set: (reference, value) => writes.push({ reference, value, update: false }),
          update: (reference, value) => writes.push({ reference, value, update: true })
        });
        if (version !== server.version) continue;
        for (const write of writes) { metrics.writes += 1; server.data.set(write.reference.path, write.update ? { ...server.data.get(write.reference.path), ...canonical(write.value) } : canonical(write.value)); }
        if (writes.length) { server.version += 1; emit(); }
        return result;
      }
      throw Error('too much contention in mock');
    }
  };
  const window = { PARTY_CONFIG: options.blank ? {} : config, crypto: crypto.webcrypto, performance: { now: () => server.now - 1800000000000 }, setTimeout, clearTimeout };
  vm.runInNewContext(source, { window, Uint8Array, __testImport: async url => {
    metrics.imports += 1;
    return url.endsWith('firebase-app.js') ? app : url.endsWith('firebase-auth.js') ? auth : store;
  } }, { filename: 'party-api.js' });
  return { api: window.PartyApi, apps, metrics, hostUser: value => { nextHostUser = user(value); }, authChanged, user, emit };
}
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
let checks = 0;
function check(value, message) { assert.ok(value, message); checks += 1; }
async function rejects(promise, expression) { await assert.rejects(promise, expression); checks += 1; }
(async () => {
  const empty = browser({ blank: true });
  check(!empty.api.ready(), 'blank configuration disables live mode');
  await rejects(empty.api.whenReady(), /Firebase setup/);
  check(empty.metrics.imports === 0, 'blank configuration never downloads Firebase');
  check(empty.api.configure(config), 'optional Firebase values can be blank');
  await empty.api.whenReady();
  check(empty.apps.has('gender-reveal-host') && empty.apps.has('gender-reveal-player'), 'host and player apps isolated');
  check(empty.metrics.anonymous === 0, 'auth initialization does not create a participant');
  await rejects(empty.api.signInHost('someone@example.com', 'host-password'), /registered host/);
  await rejects(empty.api.signInHost('pradeepb@icai.org', 'wrong'), /incorrect/);
  empty.hostUser({ emailVerified: false });
  await rejects(empty.api.signInHost('pradeepb@icai.org', 'host-password'), /verified host account/);
  check(!empty.api.hostSignedIn(), 'unverified account signed out');
  empty.hostUser({ email: 'someone@example.com' });
  await rejects(empty.api.signInHostWithGoogle('pradeepb@icai.org'), /verified host account/);
  check(!empty.api.hostSignedIn(), 'wrong Google account signed out');
  await empty.api.signInHost('PradeepB@icai.org', 'host-password');
  check(empty.api.hostSignedIn(), 'verified password account signed in');
  await empty.api.sendHostPasswordReset('pradeepb@icai.org');
  check(empty.metrics.authReset === 1, 'password reset uses Firebase auth');
  const room = await empty.api.rpc('party_host_create', { p_game: 'words' }, { host: true });
  check(/^[A-Z]{6}$/.test(room.code) && room.status === 'waiting', 'random waiting-room code');
  check(room.starts_at === null && room.players.length === 0, 'new room has no countdown or players');
  const raw = server.data.get('genderRevealRooms/' + room.code);
  check(Object.keys(raw).sort().join(',') === 'code,createdAt,game,hostId,playerCount,revealedAt,startedAt,status', 'room uses exact rules schema');
  check(raw.createdAt instanceof Timestamp, 'creation time is server generated');
  await rejects(empty.api.rpc('party_host_start', { p_code: room.code }, { host: true }), /at least one/);
  const joined = await empty.api.rpc('party_join', { p_code: room.code.toLowerCase(), p_name: '  Player One  ' });
  check(joined.room.self.name === 'Player One' && joined.token.startsWith('firebase:'), 'join returns uid-bound token and name');
  check(raw.playerCount === 0 && server.data.get('genderRevealRooms/' + room.code).playerCount === 1, 'join increments count exactly once');
  const ppath = 'genderRevealRooms/' + room.code + '/players/' + joined.room.self.id;
  const player = server.data.get(ppath);
  check(player.createdAt instanceof Timestamp && player.updatedAt instanceof Timestamp && player.finishedAt === null, 'player timestamps canonical');
  const repeated = await empty.api.rpc('party_join', { p_code: room.code, p_name: 'A new name' });
  check(repeated.room.self.name === 'Player One' && server.data.get('genderRevealRooms/' + room.code).playerCount === 1, 'join resumes without duplicate or name mutation');
  await rejects(empty.api.rpc('party_progress', { p_code: room.code, p_token: joined.token, p_score: 1 }), /after the host starts/);
  await rejects(empty.api.rpc('party_view', { p_code: room.code, p_token: joined.token + 'wrong' }), /Your game entry is not valid/);
  const second = browser();
  const joined2 = await second.api.rpc('party_join', { p_code: room.code, p_name: '<b>Player Two</b>' });
  check(joined2.room.players.length === 2 && joined2.room.players.every(item => item.score === null && item.time_ms === null), 'scores hidden from participant roster');
  check(empty.metrics.deniedLists === 0 && second.metrics.deniedLists === 0, 'never attempts prohibited private list');
  const reads = second.metrics.reads, watchers = server.watches.size;
  await second.api.rpc('party_view', { p_code: room.code, p_token: joined2.token });
  await second.api.rpc('party_view', { p_code: room.code, p_token: joined2.token });
  check(second.metrics.reads === reads && server.watches.size === watchers, 'poll contract served by existing realtime cache');
  const started = await empty.api.rpc('party_host_start', { p_code: room.code }, { host: true });
  check(Date.parse(started.starts_at) === server.now + 5000, 'shared start begins five seconds after server commit');
  const startStamp = server.data.get('genderRevealRooms/' + room.code).startedAt.toMillis();
  await rejects(empty.api.rpc('party_host_reveal', { p_code: room.code }, { host: true }), /countdown/);
  await rejects(second.api.rpc('party_finish', { p_code: room.code, p_token: joined2.token, p_score: 20 }), /after the host starts/);
  const resumed = await empty.api.rpc('party_join', { p_code: room.code, p_name: 'Still One' });
  check(resumed.room.self.id === joined.room.self.id, 'existing participant resumes started game');
  const late = browser();
  await rejects(late.api.rpc('party_join', { p_code: room.code, p_name: 'Too late' }), /already started/);
  server.now += 6500;
  const progress = await empty.api.rpc('party_progress', { p_code: room.code, p_token: joined.token, p_score: 12 });
  check(progress.score === 12 && typeof progress.server_now === 'string', 'progress retains old RPC response shape');
  const smaller = await empty.api.rpc('party_progress', { p_code: room.code, p_token: joined.token, p_score: 5 });
  check(smaller.score === 12, 'score never decreases');
  await rejects(empty.api.rpc('party_progress', { p_code: room.code, p_token: joined.token, p_score: 21 }), /outside/);
  await rejects(empty.api.rpc('party_progress', { p_code: room.code, p_token: joined.token, p_score: 1.5 }), /outside/);
  const firstFinish = await empty.api.rpc('party_finish', { p_code: room.code, p_token: joined.token, p_score: 16 });
  check(firstFinish.self.finished && firstFinish.self.score === 16 && firstFinish.self.time_ms === 1500, 'partial score finish uses canonical elapsed time');
  check(firstFinish.players.every(item => item.score === null), 'finish does not reveal anyone scores');
  server.now += 1200;
  const finished2 = await second.api.rpc('party_finish', { p_code: room.code, p_token: joined2.token, p_score: 20 });
  check(finished2.self.time_ms === 2700, 'everyone measured from same server start');
  const retry = await empty.api.rpc('party_finish', { p_code: room.code, p_token: joined.token, p_score: 20 });
  check(retry.self.score === 16 && retry.self.time_ms === 1500, 'finish retry immutable');
  const hostView = await empty.api.rpc('party_host_view', { p_code: room.code }, { host: true });
  check(hostView.players.every(item => item.finished && typeof item.score === 'number'), 'verified host sees progress before reveal');
  const revealed = await empty.api.rpc('party_host_reveal', { p_code: room.code }, { host: true });
  check(revealed.status === 'revealed' && revealed.revealed_at, 'host reveals shared results');
  await tick();
  const publicResults = await second.api.rpc('party_view', { p_code: room.code, p_token: joined2.token });
  check(publicResults.status === 'revealed' && publicResults.players.length === 2 && publicResults.players.every(item => typeof item.score === 'number'), 'all participants receive full scores after reveal');
  const revealedPartial = publicResults.players.find(player => player.id === joined.room.self.id);
  const revealedFull = publicResults.players.find(player => player.id === joined2.room.self.id);
  check(revealedPartial.score === 16 && revealedPartial.time_ms === 1500
    && revealedFull.score === 20 && revealedFull.time_ms === 2700,
    'reveal preserves each score and its authoritative elapsed time for frontend ranking');
  const postRevealRetry = await empty.api.rpc('party_finish', { p_code: room.code, p_token: joined.token, p_score: 20 });
  check(postRevealRetry.self.time_ms === 1500, 'finish safely retries after reveal');
  const list = await empty.api.rpc('party_host_rooms', {}, { host: true });
  check(list.some(item => item.code === room.code), 'host room list works');
  const priorReads = empty.metrics.reads;
  await empty.api.rpc('party_host_rooms', {}, { host: true });
  check(empty.metrics.reads === priorReads, 'host room list cached');
  const puzzles = await empty.api.rpc('party_host_create', { p_game: 'jigsaw' }, { host: true });
  const joinedPuzzle = await empty.api.rpc('party_join', { p_code: puzzles.code, p_name: 'Puzzle player' });
  check(joinedPuzzle.room.self.max_score === 120, 'jigsaw maximum is 120 pieces');
  await rejects(second.api.rpc('party_view', { p_code: puzzles.code, p_token: joined2.token }), /Your game entry is not valid/);
  await rejects(second.api.rpc('party_view', { p_code: 'ZZZZZZ', p_token: joined2.token }), /Game not found/);
  await empty.api.rpc('party_host_start', { p_code: puzzles.code }, { host: true }); server.now += 6000;
  const puzzleFinish = await empty.api.rpc('party_finish', { p_code: puzzles.code, p_token: joinedPuzzle.token, p_score: 120 });
  check(puzzleFinish.self.finished && puzzleFinish.self.score === 120, 'jigsaw uses same finish contract');
  await empty.api.signOut();
  check(!empty.api.hostSignedIn(), 'host signed out');
  check((await empty.api.rpc('party_view', { p_code: puzzles.code, p_token: joinedPuzzle.token })).self.finished, 'host signout preserves anonymous participant');
  await rejects(empty.api.rpc('party_host_rooms', {}, { host: true }), /verified host email/);
  const restored = browser({ restoredHost: true }); await restored.api.whenReady();
  check(restored.api.hostSignedIn(), 'Firebase restored host session recognized');
  const noSession = browser();
  await rejects(noSession.api.rpc('party_view', { p_code: room.code, p_token: joined.token }), /Your game entry is not valid/);
  check(noSession.metrics.anonymous === 0, 'expired session does not silently create new participant');
  const beforeDispose = server.watches.size; empty.api.configure({});
  check(server.watches.size < beforeDispose && !empty.api.ready(), 'configuration reset disposes listeners');
  for (const item of [empty, second, late, restored, noSession]) item.api.configure({});
  check(server.watches.size === 0, 'test clients release all subscriptions');
  console.log(`Firebase adapter: ${checks} contract checks passed (mock SDK, no live Firebase writes).`);
})().catch(error => { console.error(error); process.exitCode = 1; });
