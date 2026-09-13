import { readFile } from 'node:fs/promises';
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  initializeTestEnvironment, assertFails, assertSucceeds,
} from '@firebase/rules-unit-testing';
import {
  collection, doc, getDoc, getDocs, query, where, orderBy,
  runTransaction, serverTimestamp, setDoc, Timestamp, updateDoc, writeBatch,
} from 'firebase/firestore';

// Run only against the local emulator; a demo project cannot target production.
const projectId = 'demo-gender-reveal';
let environment;
let host;
let alice;
let bob;
let outsider;
const roomCode = 'ABCDEF';
const hostUid = 'verified-host';
const hostClaims = { email: 'pradeepb@icai.org', email_verified: true };
const path = code => `genderRevealRooms/${code}`;
const ago = milliseconds => Timestamp.fromMillis(Date.now() - milliseconds);
const room = (overrides = {}) => ({
  code: roomCode, hostId: hostUid, game: 'words', status: 'waiting',
  createdAt: ago(20000), startedAt: null, revealedAt: null, playerCount: 0,
  ...overrides,
});
const roster = uid => ({ uid, name: uid, joinedAt: ago(10000) });
const player = (uid, overrides = {}) => ({
  uid, name: uid, score: 0, createdAt: ago(10000), updatedAt: ago(10000),
  finishedAt: null, ...overrides,
});
const liveRoom = overrides => room({
  status: 'running', startedAt: ago(10000), playerCount: 2, ...overrides,
});

before(async () => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST,
    'Start the Firestore emulator; production execution is forbidden.');
  environment = await initializeTestEnvironment({
    projectId,
    firestore: { rules: await readFile(new URL('./firestore.rules', import.meta.url), 'utf8') },
  });
});

beforeEach(async () => {
  await environment.clearFirestore();
  host = environment.authenticatedContext(hostUid, hostClaims).firestore();
  alice = environment.authenticatedContext('alice').firestore();
  bob = environment.authenticatedContext('bob').firestore();
  outsider = environment.authenticatedContext('outsider').firestore();
});

after(async () => { if (environment) await environment.cleanup(); });

async function seed(roomData = room(), members = []) {
  await environment.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    const batch = writeBatch(db);
    batch.set(doc(db, path(roomData.code)), roomData);
    for (const uid of members) {
      batch.set(doc(db, `${path(roomData.code)}/roster/${uid}`), roster(uid));
      batch.set(doc(db, `${path(roomData.code)}/players/${uid}`), player(uid));
    }
    await batch.commit();
  });
}

function newRoom() {
  return room({ createdAt: serverTimestamp() });
}

function join(db, uid, { code = roomCode, name = uid, score = 0, count = 1 } = {}) {
  return runTransaction(db, async transaction => {
    const roomRef = doc(db, path(code));
    const rosterRef = doc(db, `${path(code)}/roster/${uid}`);
    const playerRef = doc(db, `${path(code)}/players/${uid}`);
    const snapshot = await transaction.get(roomRef);
    await transaction.get(rosterRef);
    await transaction.get(playerRef);
    transaction.update(roomRef, { playerCount: snapshot.data().playerCount + count });
    transaction.set(rosterRef, { uid, name, joinedAt: serverTimestamp() });
    transaction.set(playerRef, {
      uid, name, score, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
      finishedAt: null,
    });
  });
}

const progress = (db, uid, score, finish = false) => updateDoc(
  doc(db, `${path(roomCode)}/players/${uid}`),
  { score, updatedAt: serverTimestamp(), ...(finish ? { finishedAt: serverTimestamp() } : {}) },
);

test('verified host creates a room; other identities and extra fields cannot', async () => {
  await assertFails(setDoc(doc(alice, path(roomCode)), newRoom()));
  const unverified = environment.authenticatedContext(hostUid, {
    email: 'pradeepb@icai.org', email_verified: false,
  }).firestore();
  await assertFails(setDoc(doc(unverified, path(roomCode)), newRoom()));
  await assertFails(setDoc(doc(host, path(roomCode)), { ...newRoom(), winner: 'alice' }));
  await assertFails(setDoc(doc(host, path(roomCode)), { ...newRoom(), hostId: 'alice' }));
  await assertSucceeds(setDoc(doc(host, path(roomCode)), newRoom()));
  await assertFails(setDoc(doc(host, path(roomCode)), newRoom()));
});

test('room reads require auth; room queries are limited to the verified owner', async () => {
  await seed();
  const anonymous = environment.unauthenticatedContext().firestore();
  await assertFails(getDoc(doc(anonymous, path(roomCode))));
  await assertSucceeds(getDoc(doc(alice, path(roomCode))));
  await assertFails(getDocs(collection(alice, 'genderRevealRooms')));
  await assertFails(getDocs(collection(host, 'genderRevealRooms')));
  await assertSucceeds(getDocs(query(collection(host, 'genderRevealRooms'),
    where('hostId', '==', hostUid), orderBy('createdAt', 'desc'))));
});

test('normal atomic join succeeds and all three documents agree', async () => {
  await seed();
  await assertSucceeds(join(alice, 'alice'));
  assert.equal((await getDoc(doc(host, path(roomCode)))).data().playerCount, 1);
  assert.equal((await getDoc(doc(alice, `${path(roomCode)}/roster/alice`))).data().name, 'alice');
  assert.equal((await getDoc(doc(alice, `${path(roomCode)}/players/alice`))).data().score, 0);
});

test('join cannot create one record alone or inflate the room count', async () => {
  await seed();
  await assertFails(updateDoc(doc(alice, path(roomCode)), { playerCount: 1 }));
  await assertFails(setDoc(doc(alice, `${path(roomCode)}/roster/alice`), {
    uid: 'alice', name: 'Alice', joinedAt: serverTimestamp(),
  }));
  await assertFails(join(alice, 'alice', { count: 2 }));
  await assertFails(join(alice, 'alice', { score: 1 }));
  await assertFails(join(alice, 'alice', { name: 'A'.repeat(25) }));
});

test('members cannot join twice or use another UID', async () => {
  await seed();
  await assertSucceeds(join(alice, 'alice'));
  await assertFails(join(alice, 'alice'));
  await assertFails(join(bob, 'outsider'));
  await assertFails(updateDoc(doc(alice, `${path(roomCode)}/roster/alice`), { name: 'Changed' }));
});

test('join is rejected when the game starts or the capacity is reached', async () => {
  await seed(liveRoom());
  await assertFails(join(alice, 'alice'));
  await seed(room({ playerCount: 200 }));
  await assertFails(join(alice, 'alice'));
});

test('host starts a nonempty room with a server timestamp only', async () => {
  await seed();
  await assertFails(updateDoc(doc(host, path(roomCode)), {
    status: 'running', startedAt: serverTimestamp(),
  }));
  await assertSucceeds(join(alice, 'alice'));
  await assertFails(updateDoc(doc(alice, path(roomCode)), {
    status: 'running', startedAt: serverTimestamp(),
  }));
  await assertFails(updateDoc(doc(host, path(roomCode)), {
    status: 'running', startedAt: ago(10000),
  }));
  await assertSucceeds(updateDoc(doc(host, path(roomCode)), {
    status: 'running', startedAt: serverTimestamp(),
  }));
});

test('countdown prevents progress and an immediate reveal', async () => {
  await seed(liveRoom({ startedAt: Timestamp.fromMillis(Date.now() + 60000) }), ['alice']);
  await assertFails(progress(alice, 'alice', 1));
  await assertFails(progress(alice, 'alice', 0, true));
  await assertFails(updateDoc(doc(host, path(roomCode)), {
    status: 'revealed', revealedAt: serverTimestamp(),
  }));
});

test('score must be an integer in range, monotonic, and owned by the caller', async () => {
  await seed(liveRoom(), ['alice', 'bob']);
  await assertSucceeds(progress(alice, 'alice', 16));
  await assertFails(progress(alice, 'alice', 15));
  await assertFails(progress(alice, 'alice', 20.5));
  await assertFails(progress(alice, 'alice', 21));
  await assertFails(progress(bob, 'alice', 20));
  await assertFails(updateDoc(doc(alice, `${path(roomCode)}/players/alice`), {
    score: 20, updatedAt: ago(10000),
  }));
  await assertFails(updateDoc(doc(alice, `${path(roomCode)}/players/alice`), {
    name: 'Changed', updatedAt: serverTimestamp(),
  }));
});

test('partial and zero finishes are valid and finished results are immutable', async () => {
  await seed(liveRoom(), ['alice', 'bob']);
  await assertSucceeds(progress(alice, 'alice', 16, true));
  await assertSucceeds(progress(bob, 'bob', 0, true));
  await assertFails(progress(alice, 'alice', 20, true));
  await assertFails(updateDoc(doc(alice, `${path(roomCode)}/players/alice`), {
    finishedAt: null, updatedAt: serverTimestamp(),
  }));
});

test('jigsaw accepts 120 pieces and rejects larger scores', async () => {
  await seed(liveRoom({ game: 'jigsaw' }), ['alice']);
  await assertFails(progress(alice, 'alice', 121));
  await assertSucceeds(progress(alice, 'alice', 120, true));
});

test('names are visible to members but opposing scores stay private', async () => {
  await seed(liveRoom(), ['alice', 'bob']);
  await assertSucceeds(getDocs(collection(alice, `${path(roomCode)}/roster`)));
  await assertFails(getDocs(collection(outsider, `${path(roomCode)}/roster`)));
  await assertSucceeds(getDoc(doc(alice, `${path(roomCode)}/players/alice`)));
  await assertFails(getDoc(doc(alice, `${path(roomCode)}/players/bob`)));
  await assertFails(getDocs(collection(alice, `${path(roomCode)}/players`)));
  await assertSucceeds(getDocs(collection(host, `${path(roomCode)}/players`)));
});

test('only owning host reveals; reveal grants members read access and ends writes', async () => {
  await seed(liveRoom(), ['alice', 'bob']);
  const anotherHost = environment.authenticatedContext('different-host', hostClaims).firestore();
  const reveal = db => updateDoc(doc(db, path(roomCode)), {
    status: 'revealed', revealedAt: serverTimestamp(),
  });
  await assertFails(reveal(alice));
  await assertFails(reveal(anotherHost));
  await assertSucceeds(reveal(host));
  await assertSucceeds(getDocs(collection(alice, `${path(roomCode)}/players`)));
  await assertFails(getDocs(collection(outsider, `${path(roomCode)}/players`)));
  await assertFails(progress(alice, 'alice', 1));
  await assertFails(progress(bob, 'bob', 0, true));
  await assertFails(updateDoc(doc(host, path(roomCode)), { status: 'waiting' }));
});

test('batch cannot finish a player while revealing the same room', async () => {
  await seed(liveRoom(), [hostUid]);
  const batch = writeBatch(host);
  batch.update(doc(host, path(roomCode)), { status: 'revealed', revealedAt: serverTimestamp() });
  batch.update(doc(host, `${path(roomCode)}/players/${hostUid}`), {
    score: 20, updatedAt: serverTimestamp(), finishedAt: serverTimestamp(),
  });
  await assertFails(batch.commit());
});

test('clock documents accept only their owner and the server timestamp', async () => {
  const clock = doc(alice, 'genderRevealClocks/alice');
  await assertSucceeds(setDoc(clock, { at: serverTimestamp() }));
  await assertSucceeds(getDoc(clock));
  await assertFails(setDoc(clock, { at: ago(10000) }));
  await assertFails(setDoc(clock, { at: serverTimestamp(), score: 20 }));
  await assertFails(getDoc(doc(bob, 'genderRevealClocks/alice')));
  await assertFails(setDoc(doc(bob, 'genderRevealClocks/alice'), { at: serverTimestamp() }));
  await assertFails(getDocs(collection(alice, 'genderRevealClocks')));
});

test('existing training record privacy is retained', async () => {
  const student = {
    uid: 'alice', email: 'alice@example.com', displayName: 'Alice',
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    progress: {
      version: 2, completed: [], learnerName: 'Alice', quizAnswers: {},
      assessmentLevel: null, assessmentAnswers: {}, assessmentResults: {},
      assessmentFinished: false,
    },
  };
  await assertSucceeds(setDoc(doc(alice, 'students/alice'), student));
  await assertSucceeds(getDoc(doc(alice, 'students/alice')));
  await assertSucceeds(getDoc(doc(host, 'students/alice')));
  await assertFails(getDoc(doc(bob, 'students/alice')));
  await assertFails(setDoc(doc(bob, 'students/alice'), student));
});
