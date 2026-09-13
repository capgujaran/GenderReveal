# Set up shared host-controlled games

The website is published by GitHub Pages. Shared game codes, host start, and winner reveal need the Supabase database and Auth service below. Until a project is configured, local practice games remain available; hosted games cannot synchronize across phones.

## 1. Create the database

Create a Supabase project that you control. In its SQL editor, run the complete contents of [`migrations/202609130001_party_rooms.sql`](migrations/202609130001_party_rooms.sql) once. It creates the room tables and public RPC functions in one transaction. Existing practice scores in browsers are unchanged. The migration expects the standard Supabase `pgcrypto` extension in the `extensions` schema.

Keep `party_private` out of the API's exposed schemas and out of Realtime publications. The frontend polls the checked RPC functions; it does not subscribe to database tables. Supabase supports creating these functions directly in the [SQL editor](https://supabase.com/docs/guides/database/functions).

The migration is designed for a new hosted-game schema. If a run fails, the transaction rolls back. Do not rerun it over a successfully installed schema; use a new migration for later schema changes.

## 2. Enable the host email sign-in

1. In **Authentication → Users**, create a user with the exact email **pradeepb@icai.org** and mark that email as confirmed. Keep this account under your control. The app deliberately disables automatic account creation during sign-in.
2. Enable the Email provider. Configure email delivery/SMTP so that messages can reach **pradeepb@icai.org**. Supabase's built-in email service has delivery restrictions; use your own supported SMTP settings if this address is not an allowed recipient. See [custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp).
3. Edit the **Magic Link** email template to display the one-time code using `{{ .Token }}`. For example: `<p>Your Gender Reveal host sign-in code is <strong>{{ .Token }}</strong>.</p>`. The app asks for the email code and verifies it in place; the template should not require opening a magic link.
4. Set the Auth Site URL to `https://capgujaran.github.io/GenderReveal/`.

Supabase's [email OTP guide](https://supabase.com/docs/guides/auth/auth-email-passwordless) documents token templates and verification. Entering the host email alone does not authorize host actions: the host must also verify the code sent to that inbox. The database checks the signed-in user ID, the JWT email, and the confirmed account email for every host request.

## 3. Connect the site

Copy the project URL and its **publishable key** (or legacy public `anon` key) from the project's API settings. Put those two public values in the repository's `party-config.js`:

```js
window.PARTY_CONFIG = {
  supabaseUrl: 'https://YOUR_PROJECT_REF.supabase.co',
  publishableKey: 'YOUR_PUBLIC_PUBLISHABLE_OR_ANON_KEY',
  hostEmail: 'pradeepb@icai.org'
};
```

Commit `party-config.js` along with the hosted-game application files to `main`. Wait for the GitHub Pages deployment to finish, then reload the site on the host's device and each player's device.

Only the public project key belongs in this file. A secret key, database password, or `service_role` key must never be included in the repository or browser. Supabase describes the roles of these keys in its [API key guide](https://supabase.com/docs/guides/api/api-keys).

Changing `hostEmail` in this public configuration does not change who the database authorizes. The allowlist in the migration is **pradeepb@icai.org**.

## Host and player flow

1. Choose **Host**, enter **pradeepb@icai.org**, and verify the email code.
2. Choose Word Scramble or Picture Puzzles and create a room. The server generates a random six-letter game code.
3. Share the code or the room link, such as `https://capgujaran.github.io/GenderReveal/?game=ABCDEF`. Players enter a name and join while the room is waiting. Each room supports up to 200 entries.
4. When everyone has joined, choose **Start**. A five-second countdown leads to the same server start time on every device. New entries close when the host starts the countdown.
5. Players finish and see the completion message asking them to wait for the host to announce the AED 100 Amazing gift voucher winner. Other players' scores and finish times remain unavailable until reveal.
6. Choose **Reveal winner** to publish all results. Finished players appear first, fastest time at the top; unfinished players appear last. Partial and zero scores can finish, and the score is shown alongside the time. The host can reveal before everyone finishes; this closes submission for unfinished players.
7. Create another code for another round or the other game. A started room cannot be reset and a revealed room cannot be reopened.

The player's private entry token is retained in that browser so refreshes can reconnect the same entry. Clearing browser storage or switching devices loses that entry token. Player names are visible to people who have joined the room; use names that players are comfortable sharing with the group.

## Timing, scoring, and access

- The server owns the countdown, room state, finish timestamp, and the one-time final result. Time runs from the shared start until the server accepts the finish request. It includes time spent away from the game and network delays; a disconnected finish cannot be backdated.
- Score is a bounded client report, from 0–20 correct words or 0–120 placed pieces. Progress cannot decrease, and a finished result cannot be changed. This supports a casual party game; it is not a cheat-proof prize competition.
- Players authenticate a room entry using a random 32-byte token. Only a SHA-256 token hash is stored in the database, and the token is never included in room snapshots.
- Both tables have RLS enabled with no client access policies, and the private schema/tables/helpers have no `anon` or `authenticated` access grants. All public calls go through explicit RPC permissions and checks.
- Before reveal, participant snapshots contain names and completion status but return `null` for other players' scores and times. The host can inspect results. After reveal, every member receives the sorted scores.
- Room creation is restricted to the verified host account. Knowing a room code allows someone to join a waiting room; keep the code within the party. The code is an invitation, not the host credential.

The security-definer functions use an empty `search_path` and fully qualified table/helper names, following the [PostgreSQL function security guidance](https://www.postgresql.org/docs/current/sql-createfunction.html).

## RPC contract

All functions return JSON. Function arguments must use the names below.

| Function | Arguments | Result |
| --- | --- | --- |
| `party_host_create` | `p_game`: `words` or `jigsaw` | New room snapshot |
| `party_host_rooms` | none | Latest 50 owned room snapshots, newest first |
| `party_host_view` | `p_code` | Owned room snapshot with all scores |
| `party_host_start` | `p_code` | Room snapshot; retries retain the original start |
| `party_host_reveal` | `p_code` | Revealed snapshot; retries do not change results |
| `party_join` | `p_code`, `p_name` | `{token, room}`; waiting rooms only |
| `party_view` | `p_code`, `p_token` | Member-filtered snapshot |
| `party_progress` | `p_code`, `p_token`, `p_score` | `{score, server_now}` |
| `party_finish` | `p_code`, `p_token`, `p_score` | Member-filtered snapshot; idempotent |

A room snapshot has `id`, `code`, `game`, `status`, `created_at`, `starts_at`, `revealed_at`, `server_now`, `players`, and `self`. Each player has `id`, `name`, `finished`, `score`, `max_score`, and `time_ms`; an unfinished player's time is `null`. `self` has the same player fields and is `null` for a host view. Before reveal, the player's own score remains available in `self`.

## Verify before the party

Run a short hosted round in at least three separate browser sessions: one host and two players. Check that joining works on both phones; gameplay remains locked before Start; countdowns agree; finished players receive the waiting message; another player's score/time is absent from the `party_view` network response; and Reveal displays the same fastest-first results everywhere. Refresh one player's tab to confirm the same entry reconnects.

Check both game types, a partial-score finish, a retry after finish, and a reveal with one unfinished player. A late join, a finish before Start, a random participant token, and a signed-in account with a different email must all be rejected. This check should run against the configured Supabase project before using the prize flow with guests.

The code has not been applied to a live Supabase project as part of repository preparation. Database installation, email delivery, and a real multi-device round require the project configuration above.
