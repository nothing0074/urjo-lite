#!/usr/bin/env python3
"""Urjo relay: static ES5 frontend + API proxy for Kindle Paperwhite 2.

The PW2 browser only speaks plain HTTP with an ancient TLS stack, so it cannot
reach urjo.com directly. This relay serves the static Kindle pages and proxies
the API paths to https://urjo.com, passing cookies through per client.

Python 3 stdlib only. Run:  python3 relay.py 8080
"""

import http.client
import http.cookies
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

UPSTREAM_HOST = "urjo.com"
UPSTREAM_PORT = 443
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
RELAY_PREFIX = "/relay"  # requests the Kindle frontends target
PROXIED = ("/v1", "/api", "/ping", "/_serverFn")


def is_proxied(path):
    for p in PROXIED:
        if path == p or path.startswith(p + "/"):
            return True
    return False
TIMEOUT = 30

MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
}

# hop-by-hop / framing headers not forwarded when proxying
DROP_REQ = ("host", "connection", "keep-alive", "proxy-authenticate",
            "proxy-authorization", "te", "trailer", "transfer-encoding",
            "upgrade", "content-length", "accept-encoding")
DROP_RESP = ("connection", "keep-alive", "transfer-encoding", "upgrade",
             "content-length", "content-encoding")


def rewrite_set_cookie(raw):
    """Make upstream cookies usable from a plain-HTTP page."""
    parts = [p.strip() for p in raw.split(";")]
    if not parts or "=" not in parts[0]:
        return raw
    out = [parts[0]]
    for p in parts[1:]:
        low = p.lower()
        if low.startswith("domain="):
            continue  # host-only for this relay origin
        if low == "secure":
            continue  # page is plain HTTP
        if low.startswith("samesite="):
            out.append("SameSite=Lax")
            continue
        out.append(p)
    return "; ".join(out)


def safe_path(urlpath):
    """Map a URL path to a static file path, or None if unsafe/absent."""
    path = urlsplit(urlpath).path
    if path.endswith("/"):
        path += "index.html"
    if ".." in path or "\x00" in path:
        return None
    full = os.path.normpath(os.path.join(STATIC_DIR, path.lstrip("/")))
    root = os.path.normpath(STATIC_DIR)
    if not (full == root or full.startswith(root + os.sep)):
        return None
    return full


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "UrjoRelay/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def local_response(self, code, body, ctype="text/plain; charset=utf-8"):
        data = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def send_static(self, full):
        if full is None or not os.path.isfile(full):
            return False
        ext = os.path.splitext(full)[1].lower()
        with open(full, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)
        return True

    # ---- proxy ---------------------------------------------------------
    def proxy(self, upstream_path):
        body = None
        n = int(self.headers.get("Content-Length") or 0)
        if n:
            body = self.rfile.read(n)

        conn = http.client.HTTPSConnection(
            UPSTREAM_HOST, UPSTREAM_PORT, timeout=TIMEOUT)
        headers = {}
        for k, v in self.headers.items():
            lk = k.lower()
            if lk in DROP_REQ:
                continue
            headers[k] = v
        headers["Host"] = UPSTREAM_HOST
        headers["Accept-Encoding"] = "identity"
        try:
            method = self.command
            if method in ("POST", "PUT") or body is not None:
                method = "POST"
            conn.request(method, upstream_path, body=body, headers=headers)
            resp = conn.getresponse()
            data = resp.read()
        except Exception as e:
            self.local_response(502, "relay upstream error: %s" % e)
            return
        finally:
            try:
                conn.close()
            except Exception:
                pass

        self.send_response(resp.status)
        set_cookies = []
        for k, v in resp.getheaders():
            lk = k.lower()
            if lk in DROP_RESP:
                continue
            if lk == "set-cookie":
                set_cookies.append(rewrite_set_cookie(v))
                continue
            self.send_header(k, v)
        for sc in set_cookies:
            self.send_header("Set-Cookie", sc)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    # ---- dispatch ------------------------------------------------------
    def handle_one(self):
        path = urlsplit(self.path).path
        if path.startswith(RELAY_PREFIX + "/"):
            self.proxy(self.path[len(RELAY_PREFIX):])
            return
        if is_proxied(path):
            self.proxy(self.path)
            return
        if path == "/":
            self.path = "/index.html"
        full = safe_path(self.path)
        if not self.send_static(full):
            self.local_response(404, "not found")

    def do_GET(self):
        self.handle_one()

    def do_HEAD(self):
        self.handle_one()

    def do_POST(self):
        self.handle_one()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    srv = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print("urjo relay on http://0.0.0.0:%d  (static: %s)" % (port, STATIC_DIR))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
