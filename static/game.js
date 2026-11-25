/* Urjo game — port of the KUAL client (ui/app.js) for the plain-HTTP relay.
   Conservative ES5: no arrow functions, no let/const, no template literals, no fetch. */
(function () {
  'use strict';

  var ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

  var state = null;   // {solveId, setup, t0, log}
  var cells = [];     // {colored, solution, number, filled, value, mistaked}
  var side = 0;
  var selected = 'X';
  var mistakes = 0;
  var timerInt = null;
  var saveInt = null;
  var busy = false;
  var saving = false;
  var finalPending = false;
  var dirtyPending = false;
  var startWall = 0;
  var solved = false;
  var resumePending = false;
  var ratingBefore = null;  // rating at page load (or at last solve)
  var ratingAfter = null;   // rating right after current solve

  /* Log timestamps: t0 <= t <= server_now, >=350ms apart (use 400ms).
     Anchor to t0 + elapsed; do NOT clamp to Date.now(). */
  function nextLogTime() {
    var elapsed = Date.now() - startWall;
    if (elapsed < 0) elapsed = 0;
    var t = state.t0 + elapsed;
    var n = state.log.length;
    if (n > 0) {
      var minT = state.log[n - 1].t + 400;
      if (t < minT) t = minT;
    }
    if (t < state.t0) t = state.t0;
    return t;
  }

  function $(id) { return document.getElementById(id); }

  function setStatus(msg, cls) {
    var el = $('status');
    el.innerHTML = msg;
    el.className = cls || '';
  }

  function decodeSetup(setup) {
    var out = [];
    var i, ch, r, colored, sol, num;
    for (i = 0; i < setup.length; i++) {
      ch = setup.charAt(i);
      r = ALPHABET.indexOf(ch);
      if (r < 0) r = 0;
      colored = (r & 1) === 1;
      sol = ((r >> 1) & 1) === 1 ? 'X' : 'O';
      num = (r >> 2) - 1;
      if (num < 0) num = null;
      out.push({ colored: colored, solution: sol, number: num, filled: false, value: null, mistaked: false });
    }
    return out;
  }

  function paintCell(td, cell) {
    var numHtml = '';
    if (cell.number !== null && cell.number !== undefined) {
      numHtml = '<span class="num">' + cell.number + '</span>';
    }
    if (cell.colored) {
      td.className = 'given ' + (cell.solution === 'X' ? 'x' : 'o');
      td.innerHTML = '<span class="sym">' + cell.solution + '</span>' + numHtml;
    } else if (cell.filled) {
      td.className = 'given ' + (cell.value === 'X' ? 'x' : 'o');
      td.innerHTML = '<span class="sym">' + cell.value + '</span>' + numHtml;
    } else {
      td.className = numHtml ? 'has-num' : '';
      td.innerHTML = numHtml;
    }
  }

  function renderGrid() {
    var t = $('grid');
    t.innerHTML = '';
    var r, c, idx, td, cell, tr;
    for (r = 0; r < side; r++) {
      tr = document.createElement('tr');
      for (c = 0; c < side; c++) {
        idx = r * side + c;
        cell = cells[idx];
        td = document.createElement('td');
        td.setAttribute('data-i', idx);
        paintCell(td, cell);
        tr.appendChild(td);
      }
      t.appendChild(tr);
    }
    var tds = t.getElementsByTagName('td');
    var k;
    for (k = 0; k < tds.length; k++) {
      tds[k].onclick = onCellTap;
    }
  }

  function findTd(i) {
    var t = $('grid');
    var td = t.querySelector ? t.querySelector('td[data-i="' + i + '"]') : null;
    if (!td) {
      var rows = t.getElementsByTagName('tr');
      var r = Math.floor(i / side), c = i % side;
      if (rows[r]) td = rows[r].getElementsByTagName('td')[c];
    }
    return td;
  }

  function updateCell(i) {
    var td = findTd(i);
    if (td) paintCell(td, cells[i]);
  }

  function onCellTap(ev) {
    var el = ev.target || ev.srcElement;
    var i = parseInt(el.getAttribute('data-i'), 10);
    if (isNaN(i)) return;
    var cell = cells[i];
    if (!cell || cell.colored || cell.filled) return;
    if (busy) return;

    if (cell.solution === selected) {
      cell.filled = true;
      cell.value = selected;
      state.log.push({ t: nextLogTime(), type: 'fill', i: i });
      dirty = true;
      updateCell(i);
      flash(i, 'flash-good');
      checkComplete();
    } else {
      if (cell.mistaked) {
        flash(i, 'flash-bad');
        setStatus('Wrong — that spot should be ' + cell.solution, 'err');
        return;
      }
      cell.mistaked = true;
      mistakes++;
      $('mistakes').innerHTML = 'Mistakes: ' + mistakes;
      state.log.push({ t: nextLogTime(), type: 'mistake', i: i });
      dirty = true;
      flash(i, 'flash-bad');
      setStatus('Wrong — that spot should be ' + cell.solution, 'err');
    }
    doSave(false);
  }

  function flash(i, cls) {
    var td = findTd(i);
    if (!td) return;
    var old = td.className;
    td.className = old + ' ' + cls;
    // PW2 partial refresh eats ~150ms; 350ms flash was barely visible
    setTimeout(function () { td.className = old; }, 700);
  }

  function emptyCount() {
    var n = 0, i;
    for (i = 0; i < cells.length; i++) {
      if (!cells[i].colored && !cells[i].filled) n++;
    }
    return n;
  }

  function checkComplete() {
    if (solved) { return; }
    if (emptyCount() === 0) {
      solved = true;
      setNewEnabled(true);
      stopTimer();
      if (state) { $('timer').innerHTML = fmtTime(Date.now() - state.t0); }
      showResult();
      setStatus('Solved! Saving...', 'ok');
      doSave(true);
    }
  }

  /* ---------- rating ---------- */

  var TOP_FN = 'b36b81a6ef94f87ffeede021e5fd01d42f323635e0d6ec43781a661583b77c6e';

  function fetchRating(cb) {
    serverFn(TOP_FN, { view: 'me', country: '', region: '' }, function (err, val) {
      if (err || !val || !val.result) { cb(null); return; }
      var v = val.result.userRating;
      cb(typeof v === 'number' ? v : null);
    });
  }

  function renderRating() {
    var el = $('res-rating');
    if (!el) return;
    if (!state || state.solveId === 'local' ||
        (ratingAfter === null && ratingBefore === null)) {
      el.style.display = 'none';
      return;
    }
    var v = ratingAfter !== null ? ratingAfter : ratingBefore;
    var html = '<b>Rating:</b> ' + v;
    if (ratingBefore !== null && ratingAfter !== null) {
      var d = ratingAfter - ratingBefore;
      if (d > 0) html += ' <span style="color:#060">(+' + d + ')</span>';
      else if (d < 0) html += ' <span style="color:#c00">(' + d + ')</span>';
      else html += ' <span class="muted">(no change)</span>';
    }
    el.innerHTML = html;
    el.style.display = 'block';
  }

  function applyFinalRating(data) {
    var rec = data && data.state;
    if (rec && typeof rec.userRating === 'number') {
      ratingAfter = rec.userRating;
      renderRating();
      return;
    }
    // response lacked rating — refetch current rating from server
    fetchRating(function (v) {
      if (v !== null) { ratingAfter = v; renderRating(); }
    });
  }

  /* ---------- save ---------- */

  var saveRetries = 0;
  var dirty = false;
  function doSave(final, force) {
    if (!state) return;
    if (state.solveId === 'local') return;
    if (final) finalPending = true;
    if (saving) {
      if (dirty) dirtyPending = true;
      return;
    }
    if (!final && !force && !dirty && !dirtyPending) return;
    saving = true;
    var isFinal = finalPending;
    var snapshot = { solveId: state.solveId,
                     data: { setup: state.setup, t0: state.t0, log: state.log.slice(0) } };
    dirtyPending = false;
    setSaveState('saving...');
    apiPost('v1/', snapshot, function (err, data) {
      saving = false;
      if (!err && data && data.success) {
        saveRetries = 0;
        var newDuringFlight = dirty;
        dirty = false;
        setSaveState(isFinal ? 'saved (done)' : 'saved');
        if (isFinal) {
          finalPending = false;
          setStatus('Puzzle complete!', 'ok');
          applyFinalRating(data);
        }
        if (data.state && data.state.state && data.state.state.log) {
          state.log = data.state.state.log;
        }
        if (dirtyPending || finalPending || newDuringFlight) {
          dirtyPending = false;
          setTimeout(function () { doSave(finalPending, true); }, 400);
        }
      } else {
        saveRetries++;
        setSaveState('save failed');
        if (isFinal) setStatus('Complete, but save failed — tap Save', 'err');
        if (saveRetries <= 3) {
          setTimeout(function () { doSave(isFinal); }, 3000 * saveRetries);
        } else {
          finalPending = false;
        }
      }
    });
  }

  /* ---------- timer ---------- */
  function fmtTime(ms) {
    if (ms < 0) ms = 0;
    var s = Math.floor(ms / 1000);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var ss = s % 60;
    if (h > 0) return pad(h) + ':' + pad(m) + ':' + pad(ss);
    return pad(m) + ':' + pad(ss);
  }
  function startTimer() {
    stopTimer();
    timerInt = setInterval(function () {
      if (!state) return;
      $('timer').innerHTML = fmtTime(Date.now() - state.t0);
    }, 500);
  }
  function stopTimer() {
    if (timerInt) { clearInterval(timerInt); timerInt = null; }
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  /* ---------- result screen ---------- */
  function showResult() {
    $('res-time').innerHTML = $('timer').innerHTML;
    $('res-mistakes').innerHTML = String(mistakes);
    if (mistakes === 0) $('res-msg').innerHTML = 'Perfect run \u2014 no mistakes!';
    else if (mistakes === 1) $('res-msg').innerHTML = 'Completed with 1 mistake.';
    else $('res-msg').innerHTML = 'Completed with ' + mistakes + ' mistakes.';
    setSaveState(state && state.solveId === 'local' ? 'local (not saved)' : 'saving...');
    renderRating();
    $('grid-wrap').style.display = 'none';
    $('result').style.display = 'block';
    $('btn-result').style.display = 'inline-block';
  }
  function hideResult() {
    $('result').style.display = 'none';
    $('grid-wrap').style.display = 'block';
    if (!solved) $('btn-result').style.display = 'none';
  }
  function showBoard() {
    $('result').style.display = 'none';
    $('grid-wrap').style.display = 'block';
  }
  function restartPuzzle() {
    if (!state || busy || resumePending) return;
    state.log = [];
    state.t0 = Date.now();
    beginGame();
    setStatus('Playing again \u2014 tap a cell to fill.', 'ok');
    doSave(false, true);
  }
  function setSaveState(txt) {
    $('save-state').innerHTML = txt;
    var r = $('res-save');
    if (r) r.innerHTML = txt;
  }

  /* ---------- new puzzle ---------- */
  function setNewEnabled(on) {
    var b = $('btn-new');
    if (!b) return;
    b.disabled = !on;
    b.className = on ? 'btn' : 'btn disabled';
  }

  /* Offline fallback: serve a puzzle from the baked pool when the server
     is unreachable (GitHub Pages, relay down). solveId 'local' keeps
     doSave() from POSTing and showResult() labels it "local (not saved)". */
  function startLocalPuzzle() {
    var pool = window.LOCAL_PUZZLES;
    if (!pool || !pool.length) return false;
    var s = pool[Math.floor(Math.random() * pool.length)];
    state = { solveId: 'local', setup: s, t0: Date.now(), log: [] };
    beginGame();
    setSaveState('');
    return true;
  }

  function fetchActive() {
    if (busy || resumePending) return;
    if (state) {
      setStatus('Puzzle already loaded.', '');
      return;
    }
    resumePending = true;
    setNewEnabled(false);
    $('btn-resume').disabled = true;
    $('btn-resume').className = 'btn disabled';
    setStatus('Checking for saved puzzle...', '');
    serverFn('acf7ee259b95fc50fdc85ccd72b3144e37a124fde0336961933f185929387cad', null, function (err, val) {
      resumePending = false;
      $('btn-resume').disabled = false;
      $('btn-resume').className = 'btn';
      var st = null;
      if (!err && val && val.result && val.result.state && val.result.state.state) {
        var s2 = val.result.state.state;
        if (s2.solveId && s2.setup) st = s2;
      }
      if (st) {
        state = { solveId: st.solveId, setup: st.setup, t0: st.t0, log: st.log || [] };
        beginGame();
        setSaveState('');
        setStatus('Resumed saved puzzle.', 'ok');
        if (emptyCount() === 0) checkComplete();
      } else {
        setNewEnabled(true);
        if (err) {
          if (startLocalPuzzle()) {
            setStatus('Server unreachable \u2014 loaded a local puzzle.', 'ok');
          } else {
            setStatus('Could not reach server to check for a saved puzzle.', 'err');
          }
        } else {
          setStatus('No saved puzzle on server. Tap "New puzzle" to start.', '');
        }
      }
    });
  }

  function newPuzzle() {
    if (busy) return;
    if (resumePending) {
      setStatus('Checking for saved puzzle — one moment.', 'err');
      return;
    }
    if (state && !solved) {
      setStatus('Finish the current puzzle before starting a new one.', 'err');
      return;
    }
    busy = true;
    setStatus('Loading puzzle...', '');
    setSaveState('');
    apiPost('v1/', { next: true }, function (err, data) {
      busy = false;
      if (!err && data && data.success && data.state && data.state.state) {
        var st = data.state.state;
        state = { solveId: st.solveId, setup: st.setup, t0: st.t0, log: st.log || [] };
        beginGame();
        setStatus('Puzzle loaded. Tap a cell to fill.', 'ok');
      } else if (!err && data && data.success === false) {
        setStatus('Rate limited — wait 10–45s and try New again.', 'err');
      } else if (startLocalPuzzle()) {
        setStatus('Server unreachable \u2014 loaded a local puzzle.', 'ok');
      } else {
        setStatus('Failed to load puzzle. Check Wi-Fi.', 'err');
      }
    });
  }

  function beginGame() {
    cells = decodeSetup(state.setup);
    side = Math.round(Math.sqrt(cells.length));
    mistakes = 0;
    startWall = Date.now();
    solved = false;
    setNewEnabled(false);
    dirty = false;
    dirtyPending = false;
    finalPending = false;
    saveRetries = 0;
    if (ratingAfter !== null) { ratingBefore = ratingAfter; }
    ratingAfter = null;
    renderRating();
    var k, ev, c;
    for (k = 0; k < state.log.length; k++) {
      ev = state.log[k];
      c = cells[ev.i];
      if (!c) continue;
      if (ev.type === 'fill') { c.filled = true; c.value = c.solution; }
      else if (ev.type === 'mistake') { c.mistaked = true; mistakes++; }
    }
    $('mistakes').innerHTML = 'Mistakes: ' + mistakes;
    hideResult();
    renderGrid();
    startTimer();
  }

  function setSel(color) {
    selected = color;
    $('pick-x').className = 'swatch swatch-x' + (color === 'X' ? ' selected' : '');
    $('pick-o').className = 'swatch swatch-o' + (color === 'O' ? ' selected' : '');
  }

  function init() {
    fetchRating(function (v) {
      if (v !== null && ratingBefore === null) { ratingBefore = v; renderRating(); }
    });
    if ($('btn-new')) $('btn-new').onclick = newPuzzle;
    $('btn-save').onclick = function () { doSave(false, true); };
    $('btn-resume').onclick = fetchActive;
    $('btn-res-new').onclick = newPuzzle;
    $('btn-res-again').onclick = restartPuzzle;
    $('btn-res-board').onclick = showBoard;
    $('btn-result').onclick = showResult;
    $('pick-x').onclick = function () { setSel('X'); };
    $('pick-o').onclick = function () { setSel('O'); };
    setSel('X');
    setStatus('Tap "New puzzle" to start.', '');
    var m = /[?&]setup=([0-9a-zA-Z]+)/.exec(location.search);
    if (m) {
      state = { solveId: 'local', setup: m[1], t0: Date.now(), log: [] };
      beginGame();
      setStatus('Local puzzle loaded.', 'ok');
    } else if (location.hash === '#new') {
      newPuzzle();
    } else {
      fetchActive();
    }
  }

  /* shared with tutorial/create/trainer pages */
  window.Urjo = {
    decodeSetup: decodeSetup,
    encodeSetup: function (cells) {
      var out = '', i, c, r, num;
      for (i = 0; i < cells.length; i++) {
        c = cells[i];
        num = (c.number === null || c.number === undefined) ? 0 : c.number + 1;
        r = (c.colored ? 1 : 0) | (c.solution === 'X' ? 2 : 0) | (num << 2);
        out += ALPHABET.charAt(r);
      }
      return out;
    },
    fmtTime: fmtTime
  };

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init, false);
  }
})();
