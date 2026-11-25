/* Urjo Trainer — ES5 port of C1/X$/Z$/Q$/W$/G$/d1 from the live bundle.
 * One move per position: correct placement scores it, wrong one is a
 * mistake. Glicko-2 rating vs pool positions, 180s timer, end panel. */
(function () {
  'use strict';

  var T1_FN = 'f87eb1de4a1175820b36ded64b68bf02cfa1828694e30c24cb5bf57bbc0f312e';

  var $ = function (id) { return document.getElementById(id); };

  function now() {
    return (typeof performance !== 'undefined' && performance.now)
      ? performance.now() : Date.now();
  }

  /* ---- X$ configs (verbatim) ---- */
  var X$ = [
    { name: 'beginner', enabled: true, targetE: 0.65, sigmaE: 0.18,
      initialTimeMs: 180 * 1e3, mistakePenaltyFrac: 0.08,
      hardSolveBonusFrac: 0.12, bonusConfidenceZ: 1.5, startRd: 200 },
    { name: 'intermediate', enabled: true, targetE: 0.45, sigmaE: 0.14,
      initialTimeMs: 180 * 1e3, mistakePenaltyFrac: 0.12,
      hardSolveBonusFrac: 0.1, bonusConfidenceZ: 2, startRd: 350 },
    { name: 'expert', enabled: true, targetE: 0.25, sigmaE: 0.1,
      initialTimeMs: 180 * 1e3, mistakePenaltyFrac: 0.18,
      hardSolveBonusFrac: 0.08, bonusConfidenceZ: 1.5, startRd: 350 },
    { name: 'marathon', enabled: true, targetE: 0.5, sigmaE: 0.2,
      initialTimeMs: 180 * 1e3, mistakePenaltyFrac: 0.06,
      hardSolveBonusFrac: 0.06, bonusConfidenceZ: 2, startRd: 250 },
    { name: 'sudden-death', enabled: true, targetE: 0.35, sigmaE: 0.12,
      initialTimeMs: 180 * 1e3, mistakePenaltyFrac: 0.3,
      hardSolveBonusFrac: 0.15, bonusConfidenceZ: 1.5, startRd: 400 }
  ];

  /* ---- Glicko-2 scalars (verbatim) ---- */
  var J$ = 1200, Y$ = 0.06, B$ = 173.7178, V$ = 1, H$ = 500, U$ = 1e-6;

  function Z$(config) { return { r: J$, rd: config.startRd, sigma: Y$ }; }

  function W$(e, t) {
    var n = (e.r - 1500) / B$, r = (t.r - 1500) / B$,
        i = t.rd / B$, a = 1 / Math.sqrt(1 + 3 * i * i / (Math.PI * Math.PI));
    return 1 / (1 + Math.exp(-a * (n - r)));
  }

  function G$(e, t, n) {
    var r = (e.r - 1500) / B$, i = e.rd / B$, a = e.sigma,
        o = (t.r - 1500) / B$, s = t.rd / B$,
        c = 1 / Math.sqrt(1 + 3 * s * s / (Math.PI * Math.PI)),
        l = 1 / (1 + Math.exp(-c * (r - o))),
        u = 1 / (c * c * l * (1 - l)), d = u * c * (n - l),
        f = Math.log(a * a), m, h, g, _,
        p = function (x) {
          var t2 = Math.exp(x);
          return t2 * (d * d - i * i - u - t2) / (2 * Math.pow(i * i + u + t2, 2)) -
                 (x - f) / (V$ * V$);
        };
    if (d * d > i * i + u) h = Math.log(d * d - i * i - u);
    else {
      var e2 = 1;
      while (p(f - e2 * V$) < 0) e2 += 1;
      h = f - e2 * V$;
    }
    m = f; g = p(m); _ = p(h);
    while (Math.abs(h - m) > U$) {
      var e3 = m + (m - h) * g / (_ - g), t3 = p(e3);
      if (t3 * _ <= 0) { m = h; _ = _; m = m; g = _; } else { g /= 2; }
      /* secant/bisection (verbatim order): t*_<=0 ? (m=h,g=_) : g/=2; then h=e,_=t */
      h = e3; _ = t3;
      if (t3 * _ <= 0) { /* handled above */ }
    }
    var v = Math.exp(m / 2), y = Math.sqrt(i * i + v * v),
        b = 1 / Math.sqrt(1 / (y * y) + 1 / u);
    return { r: (r + b * b * c * (n - l)) * B$ + 1500,
             rd: Math.min(H$, b * B$), sigma: v };
  }

})();
