/* Shared party rooms. Results come only from the server, never a local leaderboard. */
(() => {
  'use strict';
  const SESSION_KEY = 'genderReveal.liveParticipant.v2';
  const HOST_EMAIL = 'pradeepb@icai.org';
  const GAME_NAMES = { words: 'Baby Word Scramble', jigsaw: 'Baby Picture Puzzles' };
  const FINISH_MESSAGE = "You have completed! Let's wait for the host to announce the winner of an AED 100 Amazing gift voucher. All the best!";
  const state = {
    ready: false, member: null, room: null, phase: 'entry', begun: false,
    busy: false, finishing: null, booting: false, serverOffset: 0,
    pollTimer: null, snapshotTimer: null, progressTimer: null, clockTimer: null,
    hostPollTimer: null, hostRooms: [], hostRoom: null, hostBusy: false,
    hostViewVersion: 0, lastProgress: 0, connectionMessage: ''
  };
  const el = id => document.getElementById(id);
  const api = () => window.PartyApi;
  const bridge = () => window.PartyGameBridge;
  const projectIdentity = () => 'firebase:' + (window.PARTY_CONFIG?.firebase?.projectId || '');
  const now = () => Date.now() + state.serverOffset;
  const validCode = value => /^[A-Z]{6}$/.test(value);
  const codeOf = value => String(value || '').replace(/\s/g, '').toUpperCase();
  const setText = (id, value) => { if (el(id)) el(id).textContent = value; };
  const show = (id, visible) => { if (el(id)) el(id).hidden = !visible; };
  const message = (id, error) => setText(id, error instanceof Error ? error.message : error || '');
  const time = value => {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'Not finished';
    const ms = Math.max(0, Number(value));
    const seconds = Math.floor(ms / 1000);
    return Math.floor(seconds / 60).toString().padStart(2, '0') + ':'
      + (seconds % 60).toString().padStart(2, '0') + '.' + Math.floor(ms % 1000).toString().padStart(3, '0');
  };

  function readMember() {
    try {
      const value = JSON.parse(localStorage.getItem(SESSION_KEY));
      if (!value || value.project !== projectIdentity() || !validCode(value.code)
        || typeof value.token !== 'string' || value.token.length < 9 || value.token.length > 256
        || !Object.hasOwn(GAME_NAMES, value.game)) return null;
      return value;
    } catch (_) { return null; }
  }

  function saveMember() {
    if (!state.member) return;
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(state.member)); }
    catch (_) { setConnection('Keep this page open: this browser cannot save your place after a refresh.'); }
  }

  function setConnection(value) {
    state.connectionMessage = value;
    setText('partyConnection', value);
    show('partyConnection', !!value);
  }

  async function rpc(name, args, host = false) {
    const before = Date.now();
    const result = await api().rpc(name, args, { host });
    const serverTime = result && (result.server_now || result.room?.server_now);
    if (serverTime && Number.isFinite(Date.parse(serverTime))) {
      state.serverOffset = Date.parse(serverTime) - (before + Date.now()) / 2;
    }
    return result;
  }

  function mount() {
    const entry = document.createElement('div');
    entry.className = 'party-entry';
    entry.innerHTML = '<button type="button" class="party-button blue" id="partyJoinLaunch">Join with game code</button><button type="button" class="party-button" id="partyHostLaunch" aria-haspopup="dialog" aria-controls="partyHostDialog"><svg class="icon" aria-hidden="true"><use href="#i-trophy"/></svg>Host</button>';
    const anchor = document.querySelector('.game-menu');
    anchor.before(entry);
    const surfaces = document.createElement('div');
    surfaces.innerHTML = `
      <p class="party-connection" id="partyConnection" role="status" hidden></p>
      <section class="party-surface" id="partyEntryScreen" aria-labelledby="partyEntryTitle" hidden>
        <p class="party-eyebrow">Boy or girl? Let the party begin.</p><h2 id="partyEntryTitle">You're invited to play.</h2>
        <p>Enter the code from your host, choose your name, and join the waiting room.</p>
        <form id="partyJoinForm" class="party-form"><label>Game code<input class="party-code-input" id="partyJoinCode" maxlength="6" minlength="6" autocomplete="off" autocapitalize="characters" spellcheck="false" required></label><label>Your name<input id="partyJoinName" maxlength="24" autocomplete="nickname" required></label><button class="party-button primary" id="partyJoinSubmit" type="submit">Join game</button></form>
        <p class="party-status" id="partyJoinMessage" role="status"></p>
      </section>
      <section class="party-surface" id="partyRoomScreen" aria-labelledby="partyRoomTitle" hidden>
        <p class="party-eyebrow" id="partyRoomEyebrow">Your party game</p><h2 id="partyRoomTitle" tabindex="-1">Waiting for the host</h2>
        <p id="partyRoomMessage" role="status" aria-live="polite"></p><div id="partyRoomCountdown" class="party-countdown" hidden aria-label="Seconds until start"></div>
        <strong class="party-code" id="partyRoomCode"></strong><p class="party-note" id="partyRoomDetails"></p>
        <ul class="party-roster" id="partyRoomRoster" aria-label="Players who joined"></ul>
        <div id="partyRoomResults" hidden></div>
        <div class="party-actions"><button type="button" class="party-button blue" id="partyRetryFinish" hidden>Retry saving result</button><button type="button" class="party-button" id="partyNextParty" hidden>Join another game</button></div>
      </section>
      <section class="party-play-bar" id="partyPlayBar" aria-label="Current party game" hidden><span>Game code <strong id="partyPlayCode"></strong></span><span id="partyPlayName"></span><span>Scores stay hidden until the host reveals them.</span></section>`;
    anchor.before(surfaces);
    const dialogs = document.createElement('div');
    dialogs.innerHTML = `
      <dialog class="party-dialog" id="partyHostDialog" aria-labelledby="partyHostTitle">
        <div class="dialog-header"><h2 id="partyHostTitle">Host control</h2><button class="close-btn" id="partyHostClose" type="button" aria-label="Close host control"><svg class="icon" aria-hidden="true"><use href="#i-close"/></svg></button></div>
        <section id="partyHostSignIn"><p>Enter your host ID and sign in with your Power BI training account.</p>
          <form id="partyHostForm" class="party-form"><label>Host ID<input id="partyHostEmail" type="email" autocomplete="username" placeholder="Your host email" required></label><label>Password<input id="partyHostPassword" type="password" autocomplete="current-password" required></label><button class="party-button primary" id="partyHostSignInButton" type="submit">Sign in</button></form>
          <div class="party-actions"><button class="party-button blue" id="partyHostGoogle" type="button">Sign in with Google</button><button class="party-button" id="partyHostResetPassword" type="button">Forgot password?</button></div>
        </section>
        <section class="party-setup" id="partyHostSetup" hidden><p><strong>Live hosting needs its Firebase connection.</strong></p><p>Add the same Firebase configuration used by your Power BI site and publish the game access rules to enable shared rooms.</p><a href="https://github.com/capgujaran/GenderReveal/blob/main/firebase/README.md" target="_blank" rel="noopener">Open host setup instructions</a></section>
        <section id="partyHostDashboard" hidden>
          <p>Generate a code, invite players, and press Start when everyone has joined. Scores become public only when you choose Reveal winner.</p>
          <form id="partyCreateForm" class="party-form"><label>Choose a game<select id="partyHostGame"><option value="words">Game 1 · Baby Word Scramble</option><option value="jigsaw">Game 2 · Baby Picture Puzzles</option></select></label><button type="submit" class="party-button blue" id="partyCreateCode">Generate game code</button></form>
          <div class="party-host-layout"><nav class="party-host-games" id="partyHostGames" aria-label="Your game rooms"></nav><section class="party-host-details" id="partyHostDetails" hidden><h3 id="partyHostGameTitle"></h3><strong class="party-code" id="partyHostCode"></strong><p id="partyHostRoomStatus"></p><input class="party-share-input" id="partyHostShareLink" readonly aria-label="Player join link"><div class="party-actions"><button class="party-button" id="partyCopyLink" type="button">Copy invite link</button><button class="party-button blue" id="partyHostStart" type="button">Start game</button><button class="party-button primary" id="partyHostReveal" type="button">Reveal winner</button></div><div id="partyHostPlayers"></div></section></div>
          <div class="party-actions"><button type="button" class="party-button" id="partyHostSignOut">Sign out</button></div>
        </section><p class="party-status" id="partyHostMessage" role="status" aria-live="polite"></p>
      </dialog>
      <dialog class="party-dialog" id="partyScoresDialog" aria-labelledby="partyScoresTitle"><div class="dialog-header"><h2 id="partyScoresTitle">Party scores</h2><button type="button" class="close-btn" id="partyScoresClose" aria-label="Close party scores"><svg class="icon" aria-hidden="true"><use href="#i-close"/></svg></button></div><div id="partyScoresContent"></div></dialog>`;
    document.body.append(dialogs);
  }

  function sortedPlayers(room) {
    return [...(room.players || [])].sort((a, b) => Number(b.finished) - Number(a.finished)
      || (a.finished && b.finished ? Number(a.time_ms) - Number(b.time_ms) : 0));
  }

  function resultsView(room, host = false) {
    const fragment = document.createDocumentFragment();
    if (!host && room.status !== 'revealed') {
      const note = document.createElement('p');
      note.textContent = room.self?.finished ? FINISH_MESSAGE : 'Scores stay hidden until the host announces the winner. Keep playing and give it your best!';
      fragment.append(note);
      return fragment;
    }
    const players = sortedPlayers(room);
    const winner = room.status === 'revealed' ? players.find(player => player.finished) : null;
    if (winner) {
      const banner = document.createElement('div'); banner.className = 'party-winner';
      const label = document.createElement('span'); label.textContent = 'Our winner is';
      const name = document.createElement('strong'); name.textContent = winner.name;
      const prize = document.createElement('span'); prize.textContent = 'AED 100 Amazing gift voucher';
      banner.append(label, name, prize); fragment.append(banner);
    }
    const scroll = document.createElement('div'); scroll.className = 'party-result-scroll';
    const table = document.createElement('table'); table.className = 'party-results';
    const caption = document.createElement('caption'); caption.className = 'sr-only'; caption.textContent = host && room.status !== 'revealed' ? 'Private host player progress' : 'All players, fastest finished time first';
    const head = document.createElement('thead'); const heading = document.createElement('tr');
    ['Rank', 'Player', 'Score', 'Time'].forEach(text => { const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = text; heading.append(cell); });
    head.append(heading); const body = document.createElement('tbody');
    let rank = 0;
    players.forEach(player => {
      const row = document.createElement('tr'); if (winner?.id === player.id) row.className = 'winner';
      const values = [player.finished ? String(++rank) : '—', player.name,
        String(player.score ?? 0) + '/' + String(player.max_score || (room.game === 'words' ? 20 : 120)),
        player.finished ? time(player.time_ms) : 'Not finished'];
      values.forEach(value => { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); });
      body.append(row);
    });
    if (!players.length) { const row = document.createElement('tr'); const cell = document.createElement('td'); cell.colSpan = 4; cell.textContent = 'No players have joined yet.'; row.append(cell); body.append(row); }
    table.append(caption, head, body); scroll.append(table); fragment.append(scroll);
    if (room.status === 'revealed' && !winner) { const note = document.createElement('p'); note.textContent = 'No player finished before the reveal.'; fragment.prepend(note); }
    return fragment;
  }

  function renderRoom() {
    const room = state.room;
    document.body.classList.toggle('party-online', state.ready);
    document.body.classList.toggle('party-match', !!state.member);
    const playing = state.phase === 'playing';
    document.body.classList.toggle('party-gated', state.ready && !playing);
    show('partyEntryScreen', state.ready && !state.member);
    show('partyRoomScreen', !!state.member && !playing);
    show('partyPlayBar', !!state.member && playing);
    if (!state.member) return;
    setText('partyPlayCode', state.member.code); setText('partyPlayName', state.member.name);
    setText('partyRoomCode', state.member.code);
    setText('partyRoomEyebrow', GAME_NAMES[state.member.game]);
    show('partyRoomResults', state.phase === 'revealed');
    show('partyRoomRoster', state.phase === 'waiting');
    show('partyRoomCountdown', state.phase === 'countdown');
    show('partyRoomCode', ['waiting', 'countdown', 'reconnecting'].includes(state.phase));
    show('partyNextParty', state.phase === 'revealed' || state.phase === 'entry-error');
    show('partyRetryFinish', state.phase === 'finish-error');
    let title = 'Waiting for the host'; let text = 'You are in! Your host will start the game when everyone is ready.';
    if (state.phase === 'countdown') { title = 'Get ready!'; text = 'Everyone starts together. Your game will open automatically.'; }
    if (state.phase === 'saving' || state.phase === 'finish-error') { title = 'You have completed!'; text = state.phase === 'saving' ? 'Saving your result. Please keep this page open.' : 'Your result is waiting to be saved. Reconnect and tap Retry saving result.'; }
    if (state.phase === 'finished') { title = 'You have completed!'; text = FINISH_MESSAGE.replace('You have completed! ', ''); }
    if (state.phase === 'revealed') { title = 'The results are in!'; text = 'Thank you for playing. Here are everyone’s scores, with the fastest finisher on top.'; }
    if (state.phase === 'reconnecting') { title = 'Finding your game…'; text = 'Reconnecting to your party. Your game will resume automatically.'; }
    if (state.phase === 'entry-error') { title = 'Please rejoin the party'; text = 'This saved game entry is no longer available. Ask your host for the current code and join again.'; }
    setText('partyRoomTitle', title); setText('partyRoomMessage', text);
    setText('partyRoomDetails', state.phase === 'waiting' ? (room?.players?.length || 0) + ' players have joined.' : '');
    if (state.phase === 'waiting') {
      el('partyRoomRoster').replaceChildren(...(room?.players || []).map(player => { const item = document.createElement('li'); item.textContent = player.name; return item; }));
    }
    if (state.phase === 'revealed') el('partyRoomResults').replaceChildren(resultsView(room));
    if (el('partyScoresDialog').open && room) el('partyScoresContent').replaceChildren(resultsView(room));
  }

  function beginIfNeeded() {
    if (state.begun || !state.room || !bridge()) return;
    state.booting = true;
    try { bridge().begin(state.room.game, state.member.snapshot || undefined); state.begun = true; }
    finally { state.booting = false; }
  }

  function applyRoom(room) {
    if (!state.member || !room || room.code !== state.member.code) return;
    // Requests can finish out of order on mobile networks. A stale poll must not
    // reopen a submitted attempt or hide a winner that has already been revealed.
    if (state.room) {
      const stages = { waiting: 0, running: 1, revealed: 2 };
      if (stages[room.status] < stages[state.room.status]
        || (state.room.self?.finished && !room.self?.finished)
        || Date.parse(room.server_now) < Date.parse(state.room.server_now)) return;
    }
    state.room = room;
    if (room.self) {
      state.member.name = room.self.name;
      state.lastProgress = Math.max(state.lastProgress, Number(room.self.score) || 0);
    }
    if (room.status === 'revealed') state.phase = 'revealed';
    else if (room.self?.finished) {
      state.phase = 'finished'; state.member.pendingScore = null; state.member.finishedTimeMs = room.self.time_ms;
    } else if (state.member.pendingScore !== null && state.member.pendingScore !== undefined) state.phase = state.finishing ? 'saving' : 'finish-error';
    else if (room.status === 'waiting') state.phase = 'waiting';
    else if (room.status === 'running') state.phase = now() < Date.parse(room.starts_at) ? 'countdown' : 'playing';
    if (state.phase === 'playing') beginIfNeeded();
    saveMember(); renderRoom();
    if (state.phase === 'finish-error' && !state.finishing && room.status === 'running') submitFinish();
  }

  function schedulePoll(delay = 2000) {
    clearTimeout(state.pollTimer);
    if (state.member && state.phase !== 'entry-error') state.pollTimer = setTimeout(pollRoom, delay);
  }

  async function pollRoom() {
    if (!state.member) return;
    const current = state.member;
    try {
      const room = await rpc('party_view', { p_code: current.code, p_token: current.token });
      if (state.member !== current) return;
      setConnection(''); applyRoom(room);
    } catch (error) {
      if (state.member === current) {
        if (['Game not found.', 'Your game entry is not valid. Join using the game code.'].includes(error.message)) {
          state.phase = 'entry-error'; setConnection(''); renderRoom();
        } else setConnection('Connection interrupted. Keep this page open; we will reconnect and save your result automatically.');
      }
    } finally { if (state.member === current) schedulePoll(document.hidden ? 4500 : 2000); }
  }

  async function join(event) {
    event.preventDefault();
    if (state.busy || !state.ready) return;
    const code = codeOf(el('partyJoinCode').value); const name = el('partyJoinName').value.trim();
    if (!validCode(code) || !name) { message('partyJoinMessage', 'Enter the six-letter game code and your name.'); return; }
    state.busy = true; el('partyJoinSubmit').disabled = true; message('partyJoinMessage', 'Joining your game…');
    try {
      const result = await rpc('party_join', { p_code: code, p_name: name });
      state.member = { project: projectIdentity(), code, token: result.token,
        game: result.room.game, name: result.room.self.name, snapshot: null, pendingScore: null };
      state.begun = false; state.lastProgress = 0; applyRoom(result.room); schedulePoll();
      const url = new URL(location.href); url.searchParams.set('game', code); history.replaceState(null, '', url.href);
      el('partyRoomTitle').focus({ preventScroll: true }); message('partyJoinMessage', '');
    } catch (error) { message('partyJoinMessage', error); }
    finally { state.busy = false; el('partyJoinSubmit').disabled = false; }
  }

  function onGameRender(game, detail) {
    if (state.booting || !state.member || state.member.game !== game || state.phase !== 'playing') return;
    state.member.snapshot = detail.snapshot;
    clearTimeout(state.snapshotTimer); state.snapshotTimer = setTimeout(saveMember, 150);
    if (detail.finished) {
      clearTimeout(state.progressTimer);
      const finishElapsed = elapsedFor(game);
      state.member.pendingScore = detail.score;
      state.member.finishedTimeMs = finishElapsed;
      saveMember(); submitFinish(); return;
    }
    if (detail.score > state.lastProgress) {
      clearTimeout(state.progressTimer);
      state.progressTimer = setTimeout(async () => {
        const current = state.member;
        if (!current || state.phase !== 'playing') return;
        try {
          const progress = await rpc('party_progress', { p_code: current.code, p_token: current.token, p_score: detail.score });
          if (state.member === current) state.lastProgress = Math.max(state.lastProgress, progress.score);
        } catch (_) { /* A later update or final submission retries the score. */ }
      }, 400);
    }
  }

  async function submitFinish() {
    if (!state.member || state.finishing || state.member.pendingScore === null || state.member.pendingScore === undefined) return;
    const current = state.member;
    state.phase = 'saving'; renderRoom();
    const request = rpc('party_finish', { p_code: current.code, p_token: current.token, p_score: current.pendingScore });
    state.finishing = request;
    try {
      const room = await request;
      if (state.member === current) { state.finishing = null; setConnection(''); applyRoom(room); }
    } catch (_) {
      if (state.member === current && !['revealed', 'finished', 'entry-error'].includes(state.phase)) {
        state.phase = 'finish-error'; renderRoom();
      }
    } finally { if (state.finishing === request) state.finishing = null; }
  }

  function elapsedFor(game) {
    if (!state.member || state.member.game !== game) return null;
    if (state.room?.self?.finished) return Number(state.room.self.time_ms) || 0;
    if (state.member.pendingScore !== null && state.member.pendingScore !== undefined) return Number(state.member.finishedTimeMs) || 0;
    const start = Date.parse(state.room?.starts_at || '');
    return Number.isFinite(start) ? Math.max(0, now() - start) : 0;
  }

  function canInteract(game) {
    if (!state.ready) return true;
    return !!state.member && state.phase === 'playing' && state.member.game === game;
  }

  function showScoreboard() {
    if (!state.member || !state.room) return;
    el('partyScoresContent').replaceChildren(resultsView(state.room));
    if (!el('partyScoresDialog').open) el('partyScoresDialog').showModal();
  }

  function renderHost() {
    const signedIn = state.ready && api().hostSignedIn();
    show('partyHostSignIn', !signedIn); show('partyHostDashboard', signedIn); show('partyHostSetup', !state.ready);
    ['partyHostSignInButton', 'partyHostGoogle', 'partyHostResetPassword'].forEach(id => {
      el(id).disabled = !state.ready || state.hostBusy;
    });
    el('partyHostEmail').readOnly = state.hostBusy;
    el('partyHostPassword').readOnly = state.hostBusy;
    if (!signedIn) return;
    el('partyCreateCode').disabled = state.hostBusy;
    el('partyHostSignOut').disabled = state.hostBusy;
    el('partyHostGames').replaceChildren(...state.hostRooms.map(room => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'party-host-game' + (room.code === state.hostRoom?.code ? ' selected' : '');
      const code = document.createElement('strong'); code.textContent = room.code;
      const game = document.createElement('span'); game.textContent = GAME_NAMES[room.game];
      const status = document.createElement('span'); status.textContent = room.status;
      button.append(code, game, status); button.addEventListener('click', () => selectHostRoom(room.code)); return button;
    }));
    const room = state.hostRoom; show('partyHostDetails', !!room); if (!room) return;
    setText('partyHostGameTitle', GAME_NAMES[room.game]); setText('partyHostCode', room.code);
    const players = room.players || []; const done = players.filter(player => player.finished).length;
    setText('partyHostRoomStatus', room.status === 'waiting' ? players.length + ' players joined. Ready when you are.'
      : room.status === 'revealed' ? 'Winner revealed to every player.' : done + ' of ' + players.length + ' players have finished.');
    const link = new URL(location.origin + location.pathname); link.searchParams.set('game', room.code);
    el('partyHostShareLink').value = link.href;
    el('partyHostStart').disabled = state.hostBusy || room.status !== 'waiting' || players.length === 0;
    el('partyHostReveal').disabled = state.hostBusy || room.status !== 'running' || now() < Date.parse(room.starts_at);
    el('partyHostPlayers').replaceChildren(resultsView(room, true));
  }

  async function refreshHost() {
    if (!state.ready || !el('partyHostDialog').open) return;
    if (!api().hostSignedIn()) {
      state.hostRooms = []; state.hostRoom = null; renderHost(); return;
    }
    const version = state.hostViewVersion;
    try {
      const rooms = await rpc('party_host_rooms', {}, true);
      if (version !== state.hostViewVersion) return;
      if (!api().hostSignedIn()) { state.hostRooms = []; state.hostRoom = null; renderHost(); return; }
      state.hostRooms = Array.isArray(rooms) ? rooms : [];
      const code = state.hostRoom?.code || state.hostRooms[0]?.code;
      if (code) {
        const room = await rpc('party_host_view', { p_code: code }, true);
        if (version !== state.hostViewVersion) return;
        if (!api().hostSignedIn()) { state.hostRooms = []; state.hostRoom = null; renderHost(); return; }
        state.hostRoom = room;
      }
      renderHost();
    } catch (error) { message('partyHostMessage', error); renderHost(); }
    finally {
      clearTimeout(state.hostPollTimer);
      if (el('partyHostDialog').open && api().hostSignedIn()) state.hostPollTimer = setTimeout(refreshHost, 2500);
    }
  }

  async function selectHostRoom(code) {
    const version = ++state.hostViewVersion;
    state.hostBusy = true; renderHost();
    try {
      const room = await rpc('party_host_view', { p_code: code }, true);
      if (version === state.hostViewVersion) state.hostRoom = room;
    }
    catch (error) { message('partyHostMessage', error); }
    finally { if (version === state.hostViewVersion) { state.hostBusy = false; renderHost(); } }
  }

  async function hostSignIn(event, method = 'password') {
    event.preventDefault(); if (!state.ready || state.hostBusy) return;
    const email = el('partyHostEmail').value.trim().toLowerCase();
    if (email !== HOST_EMAIL) { message('partyHostMessage', 'This ID is not authorized to host this party.'); return; }
    state.hostBusy = true; renderHost(); message('partyHostMessage', '');
    try {
      if (method === 'google') await api().signInHostWithGoogle(email);
      else await api().signInHost(email, el('partyHostPassword').value);
      message('partyHostMessage', 'Signed in. Generate a code to invite players.');
      await refreshHost();
    } catch (error) { message('partyHostMessage', error); }
    finally { el('partyHostPassword').value = ''; state.hostBusy = false; renderHost(); }
  }

  async function resetHostPassword() {
    if (!state.ready || state.hostBusy) return;
    const email = el('partyHostEmail').value.trim().toLowerCase();
    if (email !== HOST_EMAIL) { message('partyHostMessage', 'Enter your authorized host ID first.'); return; }
    state.hostBusy = true; renderHost(); message('partyHostMessage', '');
    try {
      await api().sendHostPasswordReset(email);
      message('partyHostMessage', 'Check your email for a password reset link.');
    } catch (error) { message('partyHostMessage', error); }
    finally { state.hostBusy = false; renderHost(); }
  }

  async function openHost() {
    renderHost(); el('partyHostDialog').showModal();
    if (!state.ready) return;
    state.hostBusy = true; renderHost(); message('partyHostMessage', 'Connecting…');
    try {
      await api().whenReady();
      message('partyHostMessage', '');
      await refreshHost();
    } catch (error) { message('partyHostMessage', error); }
    finally { state.hostBusy = false; renderHost(); }
  }

  async function hostAction(action) {
    if (state.hostBusy || !state.hostRoom) return;
    const version = ++state.hostViewVersion;
    state.hostBusy = true; renderHost(); message('partyHostMessage', '');
    try {
      const room = await rpc(action === 'start' ? 'party_host_start' : 'party_host_reveal', { p_code: state.hostRoom.code }, true);
      if (version !== state.hostViewVersion) return;
      state.hostRoom = room;
      message('partyHostMessage', action === 'start' ? 'Starting everyone together in five seconds.' : 'The winner and all scores are now visible to everyone.');
    } catch (error) { message('partyHostMessage', error); }
    finally { if (version === state.hostViewVersion) { state.hostBusy = false; renderHost(); } }
  }

  function joinAnother() {
    clearTimeout(state.pollTimer); clearTimeout(state.snapshotTimer); clearTimeout(state.progressTimer);
    state.member = null; state.room = null; state.begun = false; state.finishing = null; state.phase = 'entry'; state.lastProgress = 0;
    try { localStorage.removeItem(SESSION_KEY); } catch (_) { /* Already absent. */ }
    const url = new URL(location.href); url.searchParams.delete('game'); history.replaceState(null, '', url.href);
    el('partyJoinCode').value = ''; setConnection(''); renderRoom(); el('partyJoinCode').focus();
  }

  function init() {
    if (!document.querySelector('.game-menu') || !api()) return;
    api().configure(window.PARTY_CONFIG || {}); state.ready = api().ready(); mount();
    el('partyJoinForm').addEventListener('submit', join);
    el('partyJoinLaunch').addEventListener('click', () => {
      if (!state.ready) { setConnection('The live party is being set up. Please check back with your host.'); return; }
      if (state.member) { showScoreboard(); return; }
      el('partyEntryScreen').scrollIntoView({ block: 'center', behavior: 'smooth' }); el('partyJoinCode').focus();
    });
    el('partyHostLaunch').addEventListener('click', openHost);
    el('partyHostClose').addEventListener('click', () => el('partyHostDialog').close());
    el('partyHostDialog').addEventListener('close', () => { clearTimeout(state.hostPollTimer); el('partyHostLaunch').focus({ preventScroll: true }); });
    el('partyHostForm').addEventListener('submit', event => hostSignIn(event));
    el('partyHostGoogle').addEventListener('click', event => hostSignIn(event, 'google'));
    el('partyHostResetPassword').addEventListener('click', resetHostPassword);
    el('partyHostSignOut').addEventListener('click', async () => {
      if (state.hostBusy) return;
      state.hostViewVersion += 1; state.hostBusy = true; renderHost();
      try {
        await api().signOut(); state.hostRooms = []; state.hostRoom = null;
        clearTimeout(state.hostPollTimer); message('partyHostMessage', 'Signed out.');
      } catch (error) { message('partyHostMessage', error); }
      finally { state.hostBusy = false; renderHost(); }
    });
    el('partyCreateForm').addEventListener('submit', async event => {
      event.preventDefault(); if (state.hostBusy) return;
      const version = ++state.hostViewVersion;
      state.hostBusy = true; renderHost(); message('partyHostMessage', '');
      try {
        const room = await rpc('party_host_create', { p_game: el('partyHostGame').value }, true);
        if (version !== state.hostViewVersion) return;
        state.hostRoom = room;
        state.hostRooms = [state.hostRoom, ...state.hostRooms.filter(room => room.code !== state.hostRoom.code)];
        message('partyHostMessage', 'Game code generated. Share the invite link with your players.');
      } catch (error) { message('partyHostMessage', error); }
      finally { if (version === state.hostViewVersion) { state.hostBusy = false; renderHost(); } }
    });
    el('partyHostStart').addEventListener('click', () => hostAction('start'));
    el('partyHostReveal').addEventListener('click', () => hostAction('reveal'));
    el('partyCopyLink').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(el('partyHostShareLink').value); message('partyHostMessage', 'Invite link copied.'); }
      catch (_) { el('partyHostShareLink').focus(); el('partyHostShareLink').select(); message('partyHostMessage', 'Select and copy the invite link above.'); }
    });
    el('partyScoresClose').addEventListener('click', () => el('partyScoresDialog').close());
    el('partyScoresDialog').addEventListener('close', () => el('scoreboardButton')?.focus({ preventScroll: true }));
    el('partyRetryFinish').addEventListener('click', submitFinish); el('partyNextParty').addEventListener('click', joinAnother);
    window.addEventListener('online', () => { if (state.member) { pollRoom(); if (state.member.pendingScore !== null) submitFinish(); } });
    window.addEventListener('pagehide', saveMember);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && state.member) pollRoom(); });
    state.clockTimer = setInterval(() => {
      if (state.phase === 'countdown' && state.room) {
        const remaining = Math.max(0, Math.ceil((Date.parse(state.room.starts_at) - now()) / 1000));
        setText('partyRoomCountdown', remaining);
        if (!remaining) { state.phase = 'playing'; beginIfNeeded(); renderRoom(); }
      }
      if (state.hostRoom?.status === 'running' && el('partyHostDialog').open) {
        el('partyHostReveal').disabled = state.hostBusy || now() < Date.parse(state.hostRoom.starts_at);
      }
    }, 200);
    const linkCode = codeOf(new URL(location.href).searchParams.get('game'));
    if (validCode(linkCode)) el('partyJoinCode').value = linkCode;
    if (state.ready) {
      const saved = readMember();
      if (saved && (!linkCode || linkCode === saved.code)) {
        state.member = saved; state.phase = 'reconnecting'; pollRoom();
      }
    }
    renderRoom();
  }

  window.LiveParty = Object.freeze({
    onGameRender, canInteract, elapsedFor, showScoreboard,
    isMatch: () => !!state.member,
    canSwitch: game => !state.ready || (state.member?.game === game && ['countdown', 'playing'].includes(state.phase)),
    blocksGameInput: () => !!el('partyHostDialog')?.open || !!el('partyScoresDialog')?.open || (state.ready && state.phase !== 'playing')
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
