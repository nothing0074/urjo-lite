# Urjo for Kindle Paperwhite 2

Static e-ink frontend for urjo.com, runnable in the PW2's old WebKit browser.
The Kindle cannot reach urjo.com directly (its TLS is too old), so a small
Python relay serves the static files and proxies game/API traffic to the real
site over modern TLS.

## Layout

```
site/
  relay.py        Python 3 stdlib only — HTTP server + HTTPS proxy to urjo.com
  static/
    index.html    game (default page)
    rules.html    rules + your replays
    stats.html    site stats
    top.html      leaderboard (world / country / region)
    profile.html  profile + login
    api.js        XHR helpers, seroval codec, serverFn calls (ES5)
    game.js       game logic (ES5 port of the KUAL app)
    style.css     e-ink stylesheet (no flex/grid/animation)
```

## Run the relay

```sh
python3 relay.py 8080
```

- No dependencies beyond Python 3 stdlib.
- Binds `0.0.0.0` by default, so a VPS with port 8080 open works as-is.
- Static files come from `static/` next to `relay.py`; the game is `/`
  (index.html).

## Kindle setup

1. Put `relay.py` + `static/` on any always-on machine reachable from the
   Kindle's network (VPS, Raspberry Pi, LAN server).
2. Start it: `python3 relay.py 8080`.
3. On the Kindle, open the browser and go to `http://<host>:8080/`.
4. Bookmark the five pages: `/`, `/rules.html`, `/stats.html`, `/top.html`,
   `/profile.html`.

The Kindle only ever speaks plain HTTP to the relay. All calls to urjo.com
(`/v1/`, `/api/`, `/ping/`, `/_serverFn/...`) are made by the relay over
HTTPS; cookies are passed through (Domain/Secure stripped so the browser
accepts them on plain HTTP).

## PW2 constraints honoured

- ES5 only (no let/const/arrow/fetch/modules).
- No flex/grid/animation/fixed-position; `display: table` layout.
- `querySelectorAll` with rows-walk fallback; XHR instead of fetch.
- 44px minimum touch targets; grayscale e-ink styling.
- Timer ticks every 500ms; saves debounced 1500ms with retries.

## Publish to GitHub Pages

The repo root is `site/` — deliberately, so `../urjo-kual/cookies.txt` and the
KUAL extension copies stay out of version control.

```sh
cd site
git init -b main
git add .
git commit -m "Static e-ink frontend"
```

Create an empty repo on GitHub (no README), then:

```sh
git remote add origin git@github.com:<you>/<repo>.git
git push -u origin main
```

Enable Pages: **Settings → Pages → Source: GitHub Actions**. The workflow in
`.github/workflows/pages.yml` runs `build.py --offline` on every push to
`main` and deploys `static/`.

Project sites are served from `https://<you>.github.io/<repo>/`, so all asset
paths must stay relative — `api.js`, `game.js` and `profile.html` use
`_serverFn/`, `v1/` and `api/` rather than root-absolute paths.

### What works without the relay

GitHub Pages is static: `relay.py` cannot run, so every `serverFn`/`apiPost`
call 404s and the frontend falls back to the baked-in snapshot.

| Works | Needs the relay |
| --- | --- |
| All 10 pages, nav, e-ink styling | Live refresh (snapshot note stays) |
| Puzzles from `pool.js` (10 000) | Login / logout |
| Tutorial, create, rules, stats | Saving or resuming progress |
| Snapshot views of top/home/live/profile | Replays after the snapshot date |

Refresh the snapshots locally before publishing if you want them current:

```sh
python3 build.py        # online: fetch from urjo.com, then inject
git add static && git commit -m "Refresh snapshots"
```

## Notes

- Game state lives on urjo.com; the relay is stateless.
- `?setup=<16-hex>` on `/` loads a specific puzzle locally.
- Rate limits: `/v1/` may return `success:false` with a wait time; the
  frontend shows it in the status line.
