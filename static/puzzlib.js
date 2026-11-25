/* Urjo puzzle engine — row-pattern solver, generator, reducer (ES5 only).
 * Rules: every row has equal X/O; adjacent rows differ; a clue N on a spot
 * means exactly N of its up-to-8 neighbours share that spot's colour.
 */
window.Puzz = (function () {
  'use strict';

  var BUDGET = 400000;   /* max solver nodes per solve() call */

  function countBits(n) {
    var c = 0;
    while (n) { c += n & 1; n >>= 1; }
    return c;
  }

  /* all balanced bit-rows for even side (bit0 = first cell, 1 = X) */
  function rowPatterns(side) {
    var out = [], max = 1 << side, i;
    for (i = 0; i < max; i++) {
      if (countBits(i) === side / 2) out.push(i);
    }
    return out;
  }

  function neighbours(i, side) {
    var r = Math.floor(i / side), c = i % side, out = [], dr, dc, rr, cc;
    for (dr = -1; dr <= 1; dr++) {
      for (dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        rr = r + dr; cc = c + dc;
        if (rr >= 0 && rr < side && cc >= 0 && cc < side) out.push(rr * side + cc);
      }
    }
    return out;
  }

  var neighCache = {};
  function getNeigh(i, side) {
    var key = side + ':' + i;
    if (!neighCache[key]) neighCache[key] = neighbours(i, side);
    return neighCache[key];
  }

  var patCache = {};
  function getPatterns(side) {
    if (!patCache[side]) patCache[side] = rowPatterns(side);
    return patCache[side];
  }

  function bitOf(pattern, c) { return (pattern >> c) & 1; }   /* 1 = X, 0 = O */

  /* cells: [{colored, solution:'X'|'O', number}] — the puzzle.
     Returns {count: 0|1|2(>=2)|-1(timeout), solution: ['X'/'O']|null} */
  function solve(cells, side, opts) {
    opts = opts || {};
    var budget = opts.budget || BUDGET;
    var patterns = getPatterns(side);
    var n = side * side;
    var sol = new Array(n);
    var placed = 0;          /* rows placed */
    var used = 0;            /* nodes */
    var solutions = [];
    var t0 = Date.now();
    var timeCap = opts.timeCap || 3000;   /* ms */
    var i, r, c;

    /* pre-check given colour cells per row */
    var givenMask = [], givenBits = [];   /* per row: required pattern bits */
    for (r = 0; r < side; r++) {
      givenMask[r] = 0; givenBits[r] = 0;
      for (c = 0; c < side; c++) {
        var cell = cells[r * side + c];
        if (cell && cell.colored) {
          givenMask[r] |= (1 << c);
          if (cell.solution === 'X') givenBits[r] |= (1 << c);
        }
      }
    }

    function clueOk(idx) {
      var cell = cells[idx];
      if (!cell || cell.number === null || cell.number === undefined) return true;
      var col = sol[idx];
      if (col === null || col === undefined) return true;   /* row not placed yet */
      var ns = getNeigh(idx, side), k, cnt = 0;
      for (k = 0; k < ns.length; k++) {
        if (sol[ns[k]] === col) cnt++;
      }
      return cnt === cell.number;
    }

    /* check all clues whose rows are fully within placed range */
    function checkClues(upToRow) {
      var rr, cc, idx;
      for (rr = 0; rr <= upToRow; rr++) {
        for (cc = 0; cc < side; cc++) {
          idx = rr * side + cc;
          if (cells[idx] && cells[idx].number !== null &&
              cells[idx].number !== undefined) {
            /* clue needs rows rr-1..rr+1 placed */
            if (rr + 1 <= upToRow || rr + 1 >= side) {
              if (!clueOk(idx)) return false;
            }
          }
        }
      }
      return true;
    }

    function rec() {
      if (solutions.length >= 2) return;
      if (used++ > budget) return;
      if ((used & 1023) === 0 && Date.now() - t0 > timeCap) return;
      if (placed === side) {
        if (!checkClues(side - 1)) return;
        solutions.push(sol.slice(0));
        return;
      }
      var p, match, k;
      var prev = placed > 0 ? solRowPattern(placed - 1) : -1;
      for (k = 0; k < patterns.length; k++) {
        p = patterns[k];
        if (p === prev) continue;
        match = true;
        if (givenMask[placed]) {
          if ((p & givenMask[placed]) !== givenBits[placed]) match = false;
        }
        if (match) {
          for (c = 0; c < side; c++) sol[placed * side + c] = bitOf(p, c) ? 'X' : 'O';
          /* clue rows up to placed-1 now have all their neighbour rows */
          if (placed > 0 && !checkClues(placed)) match = false;
        }
        if (match) {
          placed++;
          rec();
          placed--;
          if (solutions.length >= 2 || (used > budget)) return;
        }
      }
    }

    function solRowPattern(rowIdx) {
      var p = 0, cc2;
      for (cc2 = 0; cc2 < side; cc2++) {
        if (sol[rowIdx * side + cc2] === 'X') p |= (1 << cc2);
      }
      return p;
    }

    /* empty-board fast paths */
    var anyGiven = false;
    for (i = 0; i < n; i++) {
      if (cells[i] && (cells[i].colored ||
          (cells[i].number !== null && cells[i].number !== undefined))) {
        anyGiven = true; break;
      }
    }
    if (!anyGiven) {
      /* every balanced adjacent-differing board is a solution — count >= 2 */
      return { count: 2, solution: null };
    }

    rec();
    var timeout = used > budget || (Date.now() - t0 > timeCap && solutions.length === 0 && used > 1000);
    if (timeout && solutions.length === 0) {
      /* ambiguous: budget exhausted with none found — treat as unknown */
      return { count: -1, solution: null };
    }
    if (solutions.length >= 2) return { count: 2, solution: solutions[0] };
    if (solutions.length === 1) return { count: 1, solution: solutions[0] };
    return { count: 0, solution: null };
  }

  /* drop redundant hints while the puzzle stays uniquely solvable.
     Returns new cells array (mutates a copy). */
  function reduce(cells, side, opts) {
    opts = opts || {};
    var out = [], i;
    for (i = 0; i < cells.length; i++) {
      out.push({ colored: cells[i].colored, solution: cells[i].solution,
                 number: cells[i].number });
    }
    var deadline = Date.now() + (opts.timeCap || 2500);
    var order = [];
    for (i = 0; i < out.length; i++) {
      if (out[i].colored || (out[i].number !== null && out[i].number !== undefined)) {
        order.push(i);
      }
    }
    /* try removing numbers first, then colours */
    order.sort(function (a, b) {
      var na = out[a].number !== null && out[a].number !== undefined ? 0 : 1;
      var nb = out[b].number !== null && out[b].number !== undefined ? 0 : 1;
      return na - nb;
    });
    for (i = 0; i < order.length; i++) {
      if (Date.now() > deadline) break;
      var idx = order[i];
      var snap = { colored: out[idx].colored, solution: out[idx].solution,
                   number: out[idx].number };
      if (snap.colored && snap.number !== null && snap.number !== undefined) {
        /* two-stage: first drop the number, then the colour */
        out[idx].number = null;
        var r1 = solve(out, side, { timeCap: Math.max(300, deadline - Date.now()) });
        if (r1.count !== 1) out[idx].number = snap.number;
        else {
          out[idx].colored = false;
          var r2 = solve(out, side, { timeCap: Math.max(300, deadline - Date.now()) });
          if (r2.count !== 1) { out[idx].colored = true; out[idx].number = snap.number; }
          else continue;
        }
      } else if (snap.colored) {
        out[idx].colored = false;
        var r3 = solve(out, side, { timeCap: Math.max(300, deadline - Date.now()) });
        if (r3.count !== 1) out[idx].colored = true;
      } else {
        out[idx].number = null;
        var r4 = solve(out, side, { timeCap: Math.max(300, deadline - Date.now()) });
        if (r4.count !== 1) out[idx].number = snap.number;
      }
    }
    return out;
  }

  /* random full solution board: balanced rows, adjacent rows differ */
  function randomBoard(side) {
    var patterns = getPatterns(side);
    var rows = [], r, k, p, tries;
    for (r = 0; r < side; r++) {
      tries = 0;
      do {
        k = Math.floor(Math.random() * patterns.length);
        p = patterns[k];
        tries++;
      } while (r > 0 && p === rows[r - 1] && tries < 50);
      if (r > 0 && p === rows[r - 1]) {
        /* pick a different one deterministically */
        for (k = 0; k < patterns.length; k++) {
          if (patterns[k] !== rows[r - 1]) { p = patterns[k]; break; }
        }
      }
      rows.push(p);
    }
    var cells = [], i, c;
    for (r = 0; r < side; r++) {
      for (c = 0; c < side; c++) {
        cells.push({ colored: false,
                     solution: bitOf(rows[r], c) ? 'X' : 'O',
                     number: null });
      }
    }
    return cells;
  }

  /* derive number hints from the solution (every cell that qualifies) */
  function withNumbers(cells, side) {
    var i, ns, k, cnt;
    for (i = 0; i < cells.length; i++) {
      ns = getNeigh(i, side);
      cnt = 0;
      for (k = 0; k < ns.length; k++) {
        if (cells[ns[k]].solution === cells[i].solution) cnt++;
      }
      cells[i].number = cnt;
    }
    return cells;
  }

  /* hide a fraction of colours (keep numbers) to make a playable puzzle */
  function hideColors(cells, side, keepFrac) {
    var i;
    for (i = 0; i < cells.length; i++) {
      if (Math.random() > keepFrac) cells[i].colored = false;
    }
    return cells;
  }

  /* --- setup string codec (same format as game.js / server) --- */
  var ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

  function decodeSetup(setup) {
    var out = [], i, ch, r, colored, sol, num;
    for (i = 0; i < setup.length; i++) {
      ch = setup.charAt(i);
      r = ALPHABET.indexOf(ch);
      if (r < 0) r = 0;
      colored = (r & 1) === 1;
      sol = ((r >> 1) & 1) === 1 ? 'X' : 'O';
      num = (r >> 2) - 1;
      if (num < 0) num = null;
      out.push({ colored: colored, solution: sol, number: num,
                 filled: false, value: null, mistaked: false });
    }
    return out;
  }

  function encodeSetup(cells) {
    var out = '', i, c, num;
    for (i = 0; i < cells.length; i++) {
      c = cells[i];
      num = (c.number === null || c.number === undefined) ? 0 : c.number + 1;
      out += ALPHABET.charAt((c.colored ? 1 : 0) |
                             (c.solution === 'X' ? 2 : 0) | (num << 2));
    }
    return out;
  }

  function sideOf(setup) {
    var n = setup.length, s = Math.floor(Math.sqrt(n));
    return s * s === n ? s : 0;
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function fmtTime(ms) {
    if (ms < 0) ms = 0;
    var s = Math.floor(ms / 1000);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var ss = s % 60;
    if (h > 0) return pad2(h) + ':' + pad2(m) + ':' + pad2(ss);
    return pad2(m) + ':' + pad2(ss);
  }

  /* paint a <td> for a cell (mirrors game.js paintCell) */
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

  return {
    solve: solve,
    reduce: reduce,
    randomBoard: randomBoard,
    withNumbers: withNumbers,
    hideColors: hideColors,
    neighbours: getNeigh,
    decodeSetup: decodeSetup,
    encodeSetup: encodeSetup,
    sideOf: sideOf,
    fmtTime: fmtTime,
    paintCell: paintCell
  };
})();
