/* Shared helpers: plain-HTTP XHR, server-function (Seroval) codec, nav.
 * ES5 only: no let/const/arrow/fetch/promises. Works on PW2's old WebKit.
 */

/* ---- XHR ----------------------------------------------------------- */

/* POST JSON to a relay path. cb(err, parsedJsonOrText) */
function apiPost(path, body, cb) {
  var xhr = new XMLHttpRequest();
  xhr.open('POST', path, true);
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.onreadystatechange = function () {
    if (xhr.readyState !== 4) return;
    if (xhr.status >= 200 && xhr.status < 300) {
      var data = xhr.responseText;
      try { data = JSON.parse(xhr.responseText); } catch (e) {}
      cb(null, data);
    } else {
      cb(new Error('HTTP ' + xhr.status));
    }
  };
  xhr.send(body === undefined || body === null ? null : JSON.stringify(body));
}

/* GET text. cb(err, text) */
function apiGet(path, headers, cb) {
  var xhr = new XMLHttpRequest();
  xhr.open('GET', path, true);
  if (headers) {
    for (var k in headers) {
      if (headers.hasOwnProperty(k)) xhr.setRequestHeader(k, headers[k]);
    }
  }
  xhr.onreadystatechange = function () {
    if (xhr.readyState !== 4) return;
    if (xhr.status >= 200 && xhr.status < 300) cb(null, xhr.responseText);
    else cb(new Error('HTTP ' + xhr.status));
  };
  xhr.send(null);
}

/* ---- Seroval codec (seroval 1.8.x node format) ---------------------- */

var S_CONSTANT = [null, undefined, true, false, -0, Infinity, -Infinity, NaN];

/* value -> seroval node tree (numbers/strings/booleans/arrays/objects) */
function sEncode(v, st) {
  var i, keys, kvs, t = typeof v;
  if (st === undefined) st = { n: 0 };
  if (v === null) return { t: 2, s: 0 };
  if (t === 'undefined') return { t: 2, s: 1 };
  if (t === 'boolean') return { t: 2, s: v ? 2 : 3 };
  if (t === 'number') {
    if (v !== v) return { t: 2, s: 7 };
    if (v === Infinity) return { t: 2, s: 5 };
    if (v === -Infinity) return { t: 2, s: 6 };
    if (v === 0 && 1 / v === -Infinity) return { t: 2, s: 4 };
    return { t: 0, s: v };
  }
  if (t === 'string') return { t: 1, s: v };
  if (v instanceof Array) {
    var arr = { t: 9, i: st.n++, a: [], o: 0 };
    for (i = 0; i < v.length; i++) arr.a.push(sEncode(v[i], st));
    return arr;
  }
  if (t === 'object') {
    var obj = { t: 10, i: st.n++, p: { k: [], v: [] }, o: 0 };
    keys = [];
    for (k in v) {
      if (v.hasOwnProperty(k)) keys.push(k);
    }
    keys.sort();
    for (i = 0; i < keys.length; i++) {
      obj.p.k.push(keys[i]);
      obj.p.v.push(sEncode(v[keys[i]], st));
    }
    return obj;
  }
  return { t: 1, s: String(v) };
}

/* seroval node tree -> value. refs = id -> value table. */
function sParse(node, refs) {
  var i, out, key;
  if (!node || typeof node !== 'object') return node;
  switch (node.t) {
    case 0: return node.s;
    case 1: return node.s;
    case 2: return S_CONSTANT[node.s];
    case 3: return String(node.s);            /* bigint as string */
    case 4: return refs[node.i];              /* back-reference */
    case 5: return new Date(node.s);
    case 6: return new RegExp(node.c || '', node.m || '');
    case 7:                                 /* Set -> array */
      out = [];
      if (node.i >= 0) refs[node.i] = out;
      for (i = 0; node.a && i < node.a.length; i++) out.push(sParse(node.a[i], refs));
      return out;
    case 8:                                 /* Map -> array of [k,v] */
      out = [];
      if (node.i >= 0) refs[node.i] = out;
      for (i = 0; node.e && node.e.k && i < node.e.k.length; i++) {
        out.push([sParse(node.e.k[i], refs), sParse(node.e.v[i], refs)]);
      }
      return out;
    case 9:
      out = [];
      if (node.i >= 0) refs[node.i] = out;
      for (i = 0; node.a && i < node.a.length; i++) out.push(sParse(node.a[i], refs));
      return out;
    case 10:
    case 11:
      out = {};
      if (node.i >= 0) refs[node.i] = out;
      if (node.p) {
        for (i = 0; i < node.p.k.length; i++) {
          key = node.p.k[i];
          out[key] = sParse(node.p.v[i], refs);
        }
      }
      return out;
    case 13: return null;
    default: return null;
  }
}

/* Call a TanStack server function.
 * hex: 64-hex endpoint id. data: argument object (wrapped as {data: ...}),
 * or null for no-payload functions. cb(err, value) where value = {result,...}
 */
function serverFn(hex, data, cb) {
  var url = '_serverFn/' + hex;
  if (data !== null && data !== undefined) {
    var env = { t: sEncode({ data: data }), f: 127 };
    url += '?payload=' + encodeURIComponent(JSON.stringify(env));
  }
  apiGet(url, { 'x-tsr-serverFn': 'true' }, function (err, text) {
    if (err) return cb(err);
    var raw;
    try { raw = JSON.parse(text); } catch (e) { return cb(new Error('bad json')); }
    var val;
    try { val = sParse(raw, []); } catch (e2) { return cb(e2); }
    cb(null, val);
  });
}

/* ---- page chrome ---------------------------------------------------- */

var NAV = [
  ['home.html', 'Home'],
  ['index.html', 'Game'],
  ['rules.html', 'Rules'],
  ['stats.html', 'Stats'],
  ['top.html', 'Top'],
  ['tutorial.html', 'Tutorial'],
  ['create.html', 'Create'],
  ['live.html', 'Live'],
  ['profile.html', 'Profile'],
  ['https://urjo.miraheze.org/wiki/Main_Page', 'Wiki'],
  ['https://discord.gg/t6JATXqUQm', 'Discord']
];

function renderNav(active) {
  var el = document.getElementById('nav');
  if (!el) return;
  var html = '';
  for (var i = 0; i < NAV.length; i++) {
    var href = NAV[i][0];
    var ext = href.indexOf('http') === 0;
    html += '<a href="' + href + '"' +
            (ext ? ' target="_blank" rel="noopener noreferrer"' : '') +
            (href === active ? ' class="on"' : '') + '>' +
            NAV[i][1] + (ext ? ' \u2197' : '') + '</a>';
  }
  el.innerHTML = html;
}

function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* Snapshot age note + "refresh live" link.
 * el: element to fill. loadLive: function(live) called on click. */
function snapNote(el, loadLive) {
  if (!el) return;
  if (!window.SNAP_META || !SNAP_META.generated) { el.innerHTML = ''; return; }
  var t = String(SNAP_META.generated).replace('T', ' ').replace(/(\.\d+)?([Zz]|[+-]\d\d:?\d\d)$/, '') + ' UTC';
  el.innerHTML = 'Snapshot ' + esc(t) + ' \u2014 <a href="#">refresh live</a>';
  var a = el.getElementsByTagName('a')[0];
  if (a) a.onclick = function (e) {
    if (e && e.preventDefault) e.preventDefault();
    loadLive(true);
    return false;
  };
}
