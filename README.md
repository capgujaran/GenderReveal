# Boy or Girl? Gender Reveal Party Games

A pink-and-blue party game website with two illustrated games. The website runs on GitHub Pages. Firebase Authentication and Cloud Firestore provide shared host-controlled games, following the configuration used in [PowerBITraining](https://github.com/capgujaran/PowerBITraining).

## Host-controlled parties

Choose **Host** and sign in with the verified **pradeepb@icai.org** account using its email and password or Google, as on the Power BI training site. Generate a random game code for Word Scramble or Picture Puzzles and share the invite link. Players enter their names and join a waiting room; Firebase signs them in anonymously without asking them to create an account. **Start game** begins a five-second countdown and unlocks play for everyone together.

Players finish with: “You have completed! Let's wait for the host to announce the winner of an AED 100 Amazing gift voucher. All the best!” Their final result is submitted automatically. Other players' scores stay hidden until the host chooses **Reveal winner**. Everyone then sees all results, with the fastest finished player first and unfinished entries last. Partial scores remain eligible.

Hosted games use Cloud Firestore for room state, server timestamps, and private results. The game stores its data in separate `genderRevealRooms` and `genderRevealClocks` collections. Named Firebase app instances keep game sign-in sessions separate from the training app. Firestore rules restrict host actions to the verified host account and keep other players' results private until the host reveals them.

Follow [the Firebase setup instructions](firebase/README.md) to enable guest sign-in and publish the supplied rules and index. When sharing the training Firebase project, use the combined rules that preserve its existing training rules. **The checked-in configuration is intentionally empty: live hosting requires the Firebase repository variables, sign-in providers, and Firestore rules to be configured.** The original local games remain playable while hosting is unconfigured.

Once configured, a visitor must join a game code before playing. Each hosted attempt has a fixed game and a server-controlled clock; the local replay/reset controls are unavailable during the attempt. A refresh reconnects the same player and restores locally saved progress in the same browser. Shared results are separate from the older per-device practice leaderboards.

## Games

- **Baby Word Scramble:** 20 words with draggable letters and an answer row. Drag letters down, rearrange them, and press Submit to check your answer. Tap-to-place, Clear, picture hints, and answer reveals are also available.
- **Baby Picture Puzzles:** 20 illustrated scenes, each divided into six interlocking jigsaw pieces. Drag with a finger or mouse, or tap a piece and its matching space. The board and scrollable piece tray use a 75/25 layout.

In local play, Game 1, Baby Word Scramble, opens by default. Use the game selector to switch games. Progress stays available while the page is open. Full-screen mode is available for a TV or projector.

## Local-play timer and leaderboard

Choose **Scoreboard** beside the game selector at any time to view saved results for either game. Switch between Word Scramble and Picture Puzzles inside the scoreboard, then choose **Back to game** or close it to return to your current round. Opening the scoreboard keeps your progress and leaves a running timer running.

Each game has its own elapsed timer. It starts on the first game action, pauses when you switch games, and stops as soon as the last answer or piece is correct. Time spent entering your name does not count. Play again or Start over begins a fresh attempt.

At the end, optionally enter your name and choose **Save my score**. Any finished result can be saved, including partial or zero scores. Each game's leaderboard shows the top 10, with the **fastest time first**, measured to hundredths of a second. Every row includes the player's score: correct words out of 20, or placed pieces out of 120. Picture hints are allowed; word answers shown with Reveal do not add to the score. Skipped rounds do not prevent saving.

If you return to a finished attempt and continue playing, saving again updates the same leaderboard entry with its new score and cumulative time. Editing a name does not create a duplicate entry.

Times are saved in this browser on this device and remain after a refresh. They are not shared between devices. If browser storage is unavailable, the leaderboard lasts only for the current tab. Saved results remain when the next player starts a new attempt.

## Publish with GitHub Pages

The deployment uses the same public Firebase repository variable names as PowerBITraining. Configuration values are not stored in source control.

1. In **GenderReveal → Settings → Secrets and variables → Actions → Variables**, add the six public Firebase web-app values from the PowerBITraining repository or from the same Firebase project's web-app settings:

   | Repository variable | Firebase web-app field |
   | --- | --- |
   | `VITE_FIREBASE_API_KEY` | `apiKey` |
   | `VITE_FIREBASE_AUTH_DOMAIN` | `authDomain` |
   | `VITE_FIREBASE_PROJECT_ID` | `projectId` |
   | `VITE_FIREBASE_STORAGE_BUCKET` | `storageBucket` |
   | `VITE_FIREBASE_MESSAGING_SENDER_ID` | `messagingSenderId` |
   | `VITE_FIREBASE_APP_ID` | `appId` |

2. Complete [Firebase setup](firebase/README.md): retain Email/Password and Google for the host, enable Anonymous sign-in for guests, authorize `capgujaran.github.io`, and publish the merged Firestore rules and index.
3. Open **GenderReveal → Settings → Pages** and select **GitHub Actions** as the source.
4. In **Actions → Publish Gender Reveal Games**, choose **Run workflow**. Future pushes to `main` publish automatically. Changing repository variables requires running the workflow again.

After the Pages deployment completes, the site will be available at:

[https://capgujaran.github.io/GenderReveal/](https://capgujaran.github.io/GenderReveal/)

The workflow uses Node.js 22 and `node scripts/build-pages.mjs`; no package installation is needed. It copies the runtime files into `_site` and generates `party-config.js` from the repository variables. With all six values absent, the build succeeds for standalone play and Host shows setup guidance. A partially entered configuration fails with the missing variable names. `apiKey`, `authDomain`, `projectId`, and `appId` are required; the other two are accepted when available.

These are public browser configuration values. Never put an Admin SDK private key, service-account credential, or other server secret in them. The generated files are served publicly by GitHub Pages; Firebase Authentication and Firestore rules enforce access.

The Pages workflow checks the game bridge, hosted player flow, Firebase adapter, and configuration build before publishing. Run those checks locally with:

```sh
node --test tests/build-pages.test.mjs
node tests/host-flow.cjs
node tests/game-bridge.cjs
node tests/firebase-api.cjs
```

## Local preview

Open `index.html` beside the JavaScript and CSS files for standalone play. To preview hosted games, fill the public Firebase values into the local `party-config.js`, serve this folder over HTTP, and authorize that development hostname in Firebase Authentication. Alternatively, set the `VITE_FIREBASE_*` environment variables, run `node scripts/build-pages.mjs`, and serve `_site`. The Pages build reads environment variables and replaces the checked-in `party-config.js`.

## Controls

- Word scramble: **H** for Hint, **R** for Reveal, arrow keys to change words.
- Picture puzzles: **H** for the picture guide, arrow keys to change pictures, **Escape** to deselect a piece.
- **F** toggles full-screen mode when supported by the browser.

All baby artwork and puzzle geometry are embedded in `index.html`. Hosted games use the accompanying JavaScript/CSS files and the configured shared backend.
