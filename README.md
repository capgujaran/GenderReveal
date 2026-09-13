# Boy or Girl? Gender Reveal Party Games

A pink-and-blue party game website with two illustrated games. Play through GitHub Pages, or open `index.html` alongside the other files in this folder. No frontend build step is required.

## Host-controlled parties

Choose **Host** and sign in with **pradeepb@icai.org**, using the code sent to that email. Generate a random game code for Word Scramble or Picture Puzzles and share the invite link. Players enter their names and join a waiting room. **Start game** begins a five-second countdown and unlocks play for everyone together.

Players finish with: “You have completed! Let's wait for the host to announce the winner of an AED 100 Amazing gift voucher. All the best!” Their final result is submitted automatically. Other players' scores stay hidden until the host chooses **Reveal winner**. Everyone then sees all results, with the fastest finished player first and unfinished entries last. Partial scores remain eligible.

Hosted games use a shared Supabase backend for room state, verified host access, timing, and private results. Follow [the backend setup instructions](supabase/README.md), apply the included SQL migration, and fill in the public values in `party-config.js`. **The checked-in configuration is intentionally empty: live hosting will remain unavailable until that setup is completed.** The original local games remain playable while hosting is unconfigured.

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

1. Open this repository's **Settings → Pages**.
2. Choose **Deploy from a branch**.
3. Select **main** and **/(root)**, then **Save**.

After the Pages deployment completes, the site will be available at:

https://capgujaran.github.io/GenderReveal/

Future changes on `main` will publish automatically while that source remains enabled. Publish the entire folder, including `party-config.js`, `party-api.js`, `party-host.js`, and `party-host.css`.

## Controls

- Word scramble: **H** for Hint, **R** for Reveal, arrow keys to change words.
- Picture puzzles: **H** for the picture guide, arrow keys to change pictures, **Escape** to deselect a piece.
- **F** toggles full-screen mode when supported by the browser.

All baby artwork and puzzle geometry are embedded in `index.html`. Hosted games use the accompanying JavaScript/CSS files and the configured shared backend.
