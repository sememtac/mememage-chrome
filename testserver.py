#!/usr/bin/env python3
"""Test server for the extension machine test. Serves testpage/ normally, EXCEPT
`img/mismatch.png`, which it resizes by request: the browser's <img> load
(Sec-Fetch-Dest: image) gets the true 1024x1024 version, the extension SW's
fetch() (Sec-Fetch-Dest: empty) gets a 768x768 downscale (different resolution). This reproduces a responsive/CDN
resize where the SW decodes a different resolution than the page displays — the bug
that put the sticker off-image. no-store so neither response is cached (the SW's
force-cache would otherwise reuse the browser's copy).

    python3 packaging/extension/testserver.py 8017
"""
import http.server, os, socketserver, sys, time

DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "testpage")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=DIR, **k)

    def do_GET(self):
        # `/slow/...` sleeps past any sane timeout, then 404s. It stands in for an
        # unreachable mirror so the machine test can prove the per-source timeout
        # fires and the lookup falls through to the next source. The server is
        # threaded, so a slow request never blocks the mirror behind it.
        if self.path.split("?")[0].startswith("/slow/"):
            time.sleep(6)
            self.send_error(404)
            return
        if self.path.split("?")[0].endswith("/img/mismatch.png"):
            dest = self.headers.get("Sec-Fetch-Dest", "")
            name = "mismatch_disp.png" if dest == "image" else "mismatch_sw.png"
            path = os.path.join(DIR, "img", name)
            try:
                data = open(path, "rb").read()
            except OSError:
                self.send_error(404); return
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Vary", "Sec-Fetch-Dest")
            self.end_headers()
            self.wfile.write(data)
            return
        if self.path.split("?")[0].endswith("/img/swblocked.png"):
            # Regression for the same-origin re-encode fallback: the PAGE's <img> load
            # (Sec-Fetch-Dest: image) gets the barred PNG, but the extension SW's fetch
            # (empty dest) is refused with 403 — so detection must fall back to an in-page
            # canvas re-encode. Stands in for a self-signed-TLS / auth-gated image the SW
            # cannot fetch but the page already holds (the localhost:8443 dashboard case).
            if self.headers.get("Sec-Fetch-Dest") == "image":
                data = open(os.path.join(DIR, "img", "verified.png"), "rb").read()
                self.send_response(200)
                self.send_header("Content-Type", "image/png")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Vary", "Sec-Fetch-Dest")
                self.end_headers()
                self.wfile.write(data)
            else:
                self.send_error(403)
            return
        super().do_GET()

    def log_message(self, *a):
        pass


class ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8017
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
