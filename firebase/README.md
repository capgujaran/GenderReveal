# Firebase setup for the shared party

Gender Reveal uses the same Firebase Authentication and Cloud Firestore approach as `capgujaran/PowerBITraining`. It can share that Firebase project. Its documents live in `genderRevealRooms` and `genderRevealClocks`; the training collections remain separate.

## Connect the existing project

1. In **PowerBITraining → Settings → Secrets and variables → Actions → Variables**, find the existing Firebase web configuration. Copy these repository variables into **GenderReveal → Settings → Secrets and variables → Actions → Variables**:

   | Variable | Firebase web app setting |
   | --- | --- |
   | `VITE_FIREBASE_API_KEY` | `apiKey` |
   | `VITE_FIREBASE_AUTH_DOMAIN` | `authDomain` |
   | `VITE_FIREBASE_PROJECT_ID` | `projectId` |
   | `VITE_FIREBASE_STORAGE_BUCKET` | `storageBucket` |
   | `VITE_FIREBASE_MESSAGING_SENDER_ID` | `messagingSenderId` |
   | `VITE_FIREBASE_APP_ID` | `appId` |

   These are Firebase's public web app settings. A service-account key, private key, database password, or admin credential must never go in this site.

2. In that project's **Firebase console → Authentication → Sign-in method**, enable **Anonymous** for guests. Keep the existing **Email/Password** and/or **Google** host sign-in provider enabled. The host signs in with the existing, verified `pradeepb@icai.org` account. Entering that email alone does not grant host access.

3. In **Authentication → Settings → Authorized domains**, ensure `capgujaran.github.io` is present. This is the same domain used by PowerBITraining.

4. Publish the Firestore rules and composite index below, then rerun the GenderReveal GitHub Pages deployment workflow so it picks up the repository variables.

## Publish rules and the index

`firestore.rules` is the combined ruleset: the PowerBITraining rules are preserved verbatim, followed by the Gender Reveal additions. `firestore.fragment.rules` contains only those additions for merging into an existing ruleset inside `match /databases/{database}/documents`.

If the Firebase console contains other rules added since the repository version, merge the fragment into those rules before publishing. Keep any other existing composite indexes when adding the entry from `firestore.indexes.json`.

With the Firebase CLI authenticated to your project, from this folder run:

```sh
firebase deploy --only firestore:rules,firestore:indexes --project YOUR_EXISTING_PROJECT_ID
```

Alternatively, paste the combined rules into **Firestore Database → Rules** and publish. Under **Firestore Database → Indexes → Composite**, add:

| Setting | Value |
| --- | --- |
| Collection ID | `genderRevealRooms` |
| Query scope | Collection |
| First field | `hostId`, Ascending |
| Second field | `createdAt`, Descending |

Wait for the index to finish building before loading the host's room history.

## Run a party

1. Open **Host**, enter `pradeepb@icai.org`, and sign in using the same verified account as PowerBITraining.
2. Choose a game and generate its six-letter code. Share the link and code with guests.
3. Each guest enters the code and a name. Guests wait in the room until the host clicks **Start**. Joining closes when the host starts; all players receive a five-second countdown.
4. Guests play and submit their result. Partial scores and zero scores can finish. Completion time comes from Firestore server timestamps. Guests see the waiting message for the **AED 100 Amazing gift voucher** while results remain hidden.
5. Click **Reveal winner** when ready. Everyone who joined can then see all scores, with completed entries ordered by fastest time. Revealing closes further scoring; unfinished guests remain listed without a finishing time.

Each room holds up to 200 guests. For another round, generate a new code. Guest identity belongs to the browser's Firebase anonymous session, so guests should keep using the same browser and device during a round.

## Data and access

- The verified host can create, start, and reveal only rooms they own.
- Guests can read room details and, after joining, the roster of names. Before reveal, only the host and the player themselves can read that player's score and finishing time.
- A join creates a roster entry, a player record, and the room's updated player count in one atomic transaction. Rules reject late joins, count inflation, and joins exceeding capacity.
- Scores can only increase within each game's valid range. Finished results are immutable. Rules accept completion timestamps only from the server and reject scoring before the countdown or after reveal.
- The browser reports the score. Rules enforce ownership, range, timing, and privacy; they do not prove that every puzzle was solved honestly.

## Verify the rules locally

The included tests cover host identity, private scores, atomic joins, duplicate and late joins, capacity, countdown timing, partial results, score limits, immutable finishes, reveal permissions, clocks, and preservation of training-record access.

Use Node.js 22 or newer and Java 21, then install the pinned test dependencies and run the emulator from this folder:

```sh
npm install --no-audit --no-fund --package-lock=false
npm test
```

The suite requires `FIRESTORE_EMULATOR_HOST` and uses a `demo-` project ID; it does not run against a live project. The **Check Firestore rules** GitHub Actions workflow runs these same tests on changes to this folder and can also be started manually. It needs no Firebase project credentials and cannot deploy anything.

The rules and test script received static review during this change. Emulator execution was unavailable in the editing environment because dependency downloads returned HTTP 403; check that the GitHub workflow succeeds, or run the command above, before publishing the rules.

The test versions were checked against Firebase's official packages: [rules-unit-testing 5.0.2, supporting Firebase 12](https://github.com/firebase/firebase-js-sdk/blob/firebase%4012.18.0/packages/rules-unit-testing/package.json), [Firebase 12.18.0](https://github.com/firebase/firebase-js-sdk/blob/firebase%4012.18.0/packages/firebase/package.json), and [Firebase CLI 15.30.0](https://github.com/firebase/firebase-tools/releases/tag/v15.30.0).

Firebase references: [anonymous sign-in](https://firebase.google.com/docs/auth/web/anonymous-auth), [security rules and atomic operations](https://firebase.google.com/docs/firestore/security/rules-conditions), [queries and rules](https://firebase.google.com/docs/firestore/security/rules-query), and [rules unit tests](https://firebase.google.com/docs/rules/unit-tests).
