# Boy or Girl? Gender Reveal Party Games

A self-contained, pink-and-blue party game website. Open `index.html` in a browser or play through GitHub Pages. No installation, external assets, or build step is required.

## Games

- **Baby Word Scramble:** 20 words with draggable letters and an answer row. Drag letters down, rearrange them, and press Submit to check your answer. Tap-to-place, Clear, picture hints, and answer reveals are also available.
- **Baby Picture Puzzles:** 20 illustrated scenes, each divided into six interlocking jigsaw pieces. Drag with a finger or mouse, or tap a piece and its matching space. The board and scrollable piece tray use a 75/25 layout.

Game 1, Baby Word Scramble, opens by default. Use the game selector to switch games. Progress stays available while the page is open. Full-screen mode is available for a TV or projector.

## Timer and leaderboard

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

Future changes to `index.html` on `main` will publish automatically while that source remains enabled.

## Controls

- Word scramble: **H** for Hint, **R** for Reveal, arrow keys to change words.
- Picture puzzles: **H** for the picture guide, arrow keys to change pictures, **Escape** to deselect a piece.
- **F** toggles full-screen mode when supported by the browser.

Everything needed to play is embedded in `index.html`.
