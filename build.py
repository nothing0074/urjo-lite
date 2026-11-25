#!/usr/bin/env python3
"""Partial-static build for the e-ink Urjo clone.

Two jobs:
  1. Bake the nav from static/api.js into every static/*.html page
     (markers <!--nav:begin--> ... <!--nav:end-->), and drop runtime
     renderNav() calls so pages work without JS chrome.
  2. Snapshot serverFn data from urjo.com into static/data/*.json and
     inject it into data pages as window.SNAP / window.SNAP_META.
     Pages render the snapshot first and fall back to live serverFn.

Usage:
  python3 build.py            bake + fetch snapshots + inject
  python3 build.py --offline  bake + inject existing data/*.json only

Python 3 stdlib only. Cookies read from ../urjo-kual/cookies.txt if present.
"""

import json
import os
import re
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, 'static')
DATA = os.path.join(STATIC, 'data')
API_JS = os.path.join(STATIC, 'api.js')
COOKIES = os.path.join(HERE, '..', 'urjo-kual', 'cookies.txt')

BASE = 'https://urjo.com'
TIMEOUT = 20

# page file -> window.SNAP key
PAGE_SNAP = {
    'top.html': 'top',
    'stats.html': 'stats',
    'rules.html': 'replays',
    'profile.html': 'profile',
    'home.html': 'home',
    'live.html': 'live',
}

# snapshot name -> (serverFn hex, payload or None)
SNAPS = [
    ('top', 'b36b81a6ef94f87ffeede021e5fd01d42f323635e0d6ec43781a661583b77c6e',
     {}),
    ('stats', '8b3fd33af90fcae61bb866b5376aaafc75ecd95447d4971fc28b573dda94b898', None),
    ('home', 'acf7ee259b95fc50fdc85ccd72b3144e37a124fde0336961933f185929387cad', None),
    ('live', 'ca7376ece525af0f84e53ad4f76bb4465c0283a2d1871bca25fbfb129ac09d7d', None),
    ('replays', 'df2e098ed131321d16f70bf96890f2a171fc91a02bd626709973a8b8efe5cc30', None),
]
TOP_HEX = 'b36b81a6ef94f87ffeede021e5fd01d42f323635e0d6ec43781a661583b77c6e'
IDX_HEX = 'e77becf7744507eed8cdde837ea4d6a06d2b4d2a82bfb661bab3a14cc544f11c'
FLAG_HEX = 'cc8b50309740b795c553c724796c470ca268018d6020d64d0fbfe08f54a0b0e7'

# ---------------------------------------------------------------------------
# Seroval codec (mirrors api.js sEncode/sParse for JSON-safe values)
# ---------------------------------------------------------------------------

S_CONST = [None, None, True, False, 0.0, 'Infinity', '-Infinity', 'NaN']


def s_encode(v, st):
    if v is None:
        return {'t': 2, 's': 0}
    if isinstance(v, bool):
        return {'t': 2, 's': 2 if v else 3}
    if isinstance(v, int) or isinstance(v, float):
        if v != v:
            return {'t': 2, 's': 7}
        if v == float('inf'):
            return {'t': 2, 's': 5}
        if v == float('-inf'):
            return {'t': 2, 's': 6}
        if v == 0 and str(v)[0] == '-':
            return {'t': 2, 's': 4}
        return {'t': 0, 's': v}
    if isinstance(v, str):
        return {'t': 1, 's': v}
    if isinstance(v, list):
        arr = {'t': 9, 'i': st['n'], 'a': [], 'o': 0}
        st['n'] += 1
        for x in v:
            arr['a'].append(s_encode(x, st))
        return arr
    if isinstance(v, dict):
        obj = {'t': 10, 'i': st['n'], 'p': {'k': [], 'v': []}, 'o': 0}
        st['n'] += 1
        for k in sorted(v.keys()):
            obj['p']['k'].append(k)
            obj['p']['v'].append(s_encode(v[k], st))
        return obj
    return {'t': 1, 's': str(v)}


def s_parse(node, refs):
    if not isinstance(node, dict):
        return node
    t = node.get('t')
    if t in (0, 1):
        return node.get('s')
    if t == 2:
        s = node.get('s')
        if s == 7:
            return float('nan')
        if s == 5:
            return float('inf')
        if s == 6:
            return float('-inf')
        return S_CONST[s] if 0 <= (s or 0) < len(S_CONST) else None
    if t == 3:
        return str(node.get('s'))
    if t == 4:
        i = node.get('i')
        return refs[i] if i is not None and i < len(refs) else None
    if t == 5:
        # Date -> ISO string (JS pages wrap values in new Date())
        try:
            return datetime.utcfromtimestamp(node.get('s', 0) / 1000.0).isoformat() + 'Z'
        except Exception:
            return None
    if t in (7, 8, 9, 10, 11):
        i = node.get('i', -1)
        if t == 7:
            out = []
        elif t == 8:
            out = []
        elif t == 9:
            out = []
        else:
            out = {}
        if i is not None and i >= 0:
            while len(refs) <= i:
                refs.append(None)
            refs[i] = out
        if t in (7, 9):
            for x in node.get('a') or []:
                out.append(s_parse(x, refs))
        elif t == 8:
            ent = node.get('e') or {}
            ks, vs = ent.get('k') or [], ent.get('v') or []
            for k, v in zip(ks, vs):
                out.append([s_parse(k, refs), s_parse(v, refs)])
        else:
            p = node.get('p') or {}
            ks, vs = p.get('k') or [], p.get('v') or []
            for k, v in zip(ks, vs):
                out[k] = s_parse(v, refs)
        return out
    if t == 13:
        return None
    return None


# ---------------------------------------------------------------------------
# serverFn over HTTPS
# ---------------------------------------------------------------------------

def load_cookies():
    if not os.path.exists(COOKIES):
        return ''
    jar = []
    with open(COOKIES, 'r', encoding='utf-8', errors='replace') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            if line.startswith('#HttpOnly_'):
                line = line[len('#HttpOnly_'):]
            elif line.startswith('#'):
                continue
            parts = line.split('\t')
            if len(parts) >= 7 and 'urjo.com' in parts[0]:
                jar.append(parts[5] + '=' + parts[6])
    return '; '.join(jar)


def server_fn(hexid, data, cookie):
    url = BASE + '/_serverFn/' + hexid
    if data is not None:
        env = {'t': s_encode({'data': data}, {'n': 0}), 'f': 127}
        url += '?payload=' + urllib.parse.quote(
            json.dumps(env, separators=(',', ':')))
    req = urllib.request.Request(url, headers={
        'x-tsr-serverFn': 'true',
        'Accept': 'application/json',
        'User-Agent': 'urjo-eink-build/1.0',
    })
    if cookie:
        req.add_header('Cookie', cookie)
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        text = resp.read().decode('utf-8')
    raw = json.loads(text)
    val = s_parse(raw, [])
    if isinstance(val, dict):
        return val.get('result')
    return None


# ---------------------------------------------------------------------------
# nav baking
# ---------------------------------------------------------------------------

def parse_nav():
    with open(API_JS, 'r', encoding='utf-8') as f:
        src = f.read()
    m = re.search(r'var NAV\s*=\s*\[(.*?)\];', src, re.S)
    if not m:
        raise SystemExit('NAV not found in api.js')
    return re.findall(r"\[\s*'([^']*)'\s*,\s*'([^']*)'\s*\]", m.group(1))


def nav_html(active):
    out = []
    for href, label in parse_nav():
        ext = href.startswith('http')
        cls = ' class="on"' if href == active else ''
        a = '<a href="%s"%s' % (href, cls)
        if ext:
            a += ' target="_blank" rel="noopener noreferrer"'
        a += '>%s%s</a>' % (label, ' \u2197' if ext else '')
        out.append(a)
    return '<!--nav:begin-->' + ''.join(out) + '<!--nav:end-->'


def bake_nav(path, active):
    with open(path, 'r', encoding='utf-8') as f:
        html = f.read()
    block = nav_html(active)
    m = re.search(r'<!--nav:begin-->.*?<!--nav:end-->', html, re.S)
    if m:
        html = html[:m.start()] + block + html[m.end():]
    else:
        for pat in (r'<nav class="nav" id="nav"></nav>',
                    r'<div id="nav"></div>'):
            new, n = re.subn(pat,
                             '<nav class="nav" id="nav">' + block + '</nav>',
                             html, count=1)
            if n:
                html = new
                break
        else:
            print('  ! no nav slot in %s' % os.path.basename(path))
            return
    # drop runtime renderNav calls (baked nav carries the active class)
    html = re.sub(r'^[ \t]*renderNav\([^)]*\);[ \t]*\r?\n', '', html, flags=re.M)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(html)


# ---------------------------------------------------------------------------
# snapshot fetch + inject
# ---------------------------------------------------------------------------

def fetch_snapshots(cookie):
    os.makedirs(DATA, exist_ok=True)
    results = {}
    for name, hexid, payload in SNAPS:
        path = os.path.join(DATA, name + '.json')
        try:
            res = server_fn(hexid, payload, cookie)
            if res is None:
                raise RuntimeError('empty result')
            results[name] = res
            with open(path, 'w', encoding='utf-8') as f:
                json.dump({'generated': datetime.now(timezone.utc).isoformat(),
                           'result': res}, f)
            print('  fetched %s (%d bytes)' % (name, os.path.getsize(path)))
        except Exception as e:
            print('  ! %s fetch failed: %s' % (name, e))
            if os.path.exists(path):
                with open(path, 'r', encoding='utf-8') as f:
                    old = json.load(f)
                results[name] = old.get('result')
                print('    kept previous snapshot')
    # profile chain: idx -> top me -> flag stats
    path = os.path.join(DATA, 'profile.json')
    try:
        idx = server_fn(IDX_HEX, None, cookie)
        if idx is None:
            raise RuntimeError('empty idx')
        bundle = {'idx': idx, 'topMe': None, 'flagName': None, 'flag': None}
        if idx.get('email'):
            topme = server_fn(TOP_HEX, {'view': 'me', 'country': '', 'region': ''},
                              cookie)
            bundle['topMe'] = topme
            flag_name = None
            for row in (topme or {}).get('out') or []:
                if row.get('you') and (row.get('avatarFlag') or row.get('avatarName')):
                    flag_name = (row.get('avatarFlag') or '') + (row.get('avatarName') or '')
                    break
            if flag_name:
                bundle['flagName'] = flag_name
                bundle['flag'] = server_fn(FLAG_HEX, {'flagName': flag_name}, cookie)
        results['profile'] = bundle
        with open(path, 'w', encoding='utf-8') as f:
            json.dump({'generated': datetime.now(timezone.utc).isoformat(),
                       'result': bundle}, f)
        print('  fetched profile (%d bytes)' % os.path.getsize(path))
    except Exception as e:
        print('  ! profile fetch failed: %s' % e)
        if os.path.exists(path):
            with open(path, 'r', encoding='utf-8') as f:
                results['profile'] = json.load(f).get('result')
            print('    kept previous snapshot')
    return results


def load_existing():
    out = {}
    if not os.path.isdir(DATA):
        return out
    for fn in os.listdir(DATA):
        if fn.endswith('.json') and fn != 'meta.json':
            try:
                with open(os.path.join(DATA, fn), 'r', encoding='utf-8') as f:
                    doc = json.load(f)
                out[fn[:-5]] = doc.get('result')
            except Exception:
                pass
    return out


def js_json(v):
    """JSON safe to embed inside a <script> tag."""
    return json.dumps(v, separators=(',', ':')).replace('</', '<\\/')


def inject_snaps(results):
    for page, key in PAGE_SNAP.items():
        path = os.path.join(STATIC, page)
        if not os.path.exists(path):
            continue
        with open(path, 'r', encoding='utf-8') as f:
            html = f.read()
        if key not in results or results[key] is None:
            # no data: strip any old snap script so the page goes live
            html2 = re.sub(r'\s*<script id="snap">.*?</script>', '', html, flags=re.S)
            if html2 != html:
                with open(path, 'w', encoding='utf-8') as f:
                    f.write(html2)
                print('  %s: no snapshot, live fallback' % page)
            continue
        gen = None
        meta_path = os.path.join(DATA, key + '.json')
        if os.path.exists(meta_path):
            try:
                with open(meta_path, 'r', encoding='utf-8') as f:
                    gen = json.load(f).get('generated')
            except Exception:
                pass
        script = ('<script id="snap">window.SNAP = {%s: %s}; '
                  'window.SNAP_META = %s;</script>'
                  % (json.dumps(key), js_json(results[key]),
                     js_json({'generated': gen, 'key': key})))
        m = re.search(r'<script id="snap">.*?</script>', html, re.S)
        if m:
            html = html[:m.start()] + script + html[m.end():]
        else:
            m = re.search(r'(<script src="api\.js"></script>)', html)
            if not m:
                print('  ! %s: no api.js tag to anchor snapshot' % page)
                continue
            html = html[:m.end()] + '\n' + script + html[m.end():]
        with open(path, 'w', encoding='utf-8') as f:
            f.write(html)
        print('  %s: injected %s snapshot' % (page, key))


def main():
    offline = '--offline' in sys.argv
    print('bake nav...')
    pages = sorted(fn for fn in os.listdir(STATIC) if fn.endswith('.html'))
    for fn in pages:
        bake_nav(os.path.join(STATIC, fn), fn)
        print('  %s' % fn)
    if offline:
        print('offline: using existing data/*.json')
        results = load_existing()
    else:
        print('fetch snapshots...')
        results = fetch_snapshots(load_cookies())
    print('inject snapshots...')
    inject_snaps(results)
    # meta index
    os.makedirs(DATA, exist_ok=True)
    with open(os.path.join(DATA, 'meta.json'), 'w', encoding='utf-8') as f:
        json.dump({'generated': datetime.now(timezone.utc).isoformat(),
                   'keys': sorted(results.keys()), 'offline': offline}, f, indent=1)
    print('done.')


if __name__ == '__main__':
    main()
