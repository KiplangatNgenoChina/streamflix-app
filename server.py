#!/usr/bin/env python3
"""Simple server that serves static files and proxies TMDB API requests to avoid CORS."""
import http.server
import urllib.request
import urllib.parse
import json
import os

# Load .env if present
_env_path = os.path.join(os.path.dirname(__file__), ".env")
if os.path.exists(_env_path):
    with open(_env_path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                v = v.strip().strip('"').strip("'")
                os.environ.setdefault(k.strip(), v)

API_KEY = os.environ.get("TMDB_API_KEY", "53197e900dd0dfceb105a636a0d1aa6a")
TMDB_BASE = "https://api.themoviedb.org/3"
PORT = int(os.environ.get("PORT", 3000))

# StremThru (ElfHosted) only: /torrentio/ is proxied here. Set in .env for local dev.
STREMTHRU_BASE = (os.environ.get("STREMTHRU_STREAM_BASE_URL") or "").rstrip("/")
STREMTHRU_TOKEN = os.environ.get("STREMTHRU_TOKEN") or ""


class ProxyHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/api/"):
            self.proxy_tmdb()
        elif self.path.startswith("/torrentio/"):
            self.proxy_torrentio()
        elif self.path.startswith("/subs/"):
            self.proxy_subs()
        else:
            self.serve_static()

    def proxy_tmdb(self):
        rest = self.path[4:]  # Remove /api
        path, _, query = rest.partition("?")
        sep = "&" if query else ""
        url = f"{TMDB_BASE}/{path}?{query}{sep}api_key={API_KEY}"
        try:
            req = urllib.request.Request(url, headers={"Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = resp.read()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(data)
        except Exception as e:
            self.send_error(502, str(e))

    def proxy_torrentio(self):
        path = self.path[10:].lstrip("/")  # Remove /torrentio/
        if not STREMTHRU_BASE:
            self.send_response(503)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({
                "error": "StremThru not configured. Set STREMTHRU_STREAM_BASE_URL in .env.",
                "streams": [],
            }).encode())
            return
        url = f"{STREMTHRU_BASE}/{path}"
        if STREMTHRU_TOKEN:
            url += "?" if "?" not in url else "&"
            url += "token=" + urllib.parse.quote(STREMTHRU_TOKEN, safe="")
        try:
            req = urllib.request.Request(url, headers={"Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = resp.read()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(data)
        except Exception as e:
            self.send_error(502, str(e))

    def proxy_subs(self):
        """Proxy Wyzie Subs API (https://sub.wyzie.ru) to avoid CORS."""
        path = self.path[5:].lstrip("/")  # Remove /subs/
        url = f"https://sub.wyzie.ru/{path}"
        try:
            req = urllib.request.Request(url, headers={"Accept": "application/json, text/plain"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = resp.read()
            self.send_response(200)
            ct = resp.headers.get("Content-Type") or "application/json"
            self.send_header("Content-Type", ct)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            self.send_error(502, str(e))

    def serve_static(self):
        path = self.path.split("?")[0] or "/index.html"
        if path == "/":
            path = "/index.html"
        filepath = os.path.join(os.path.dirname(__file__), path.lstrip("/"))
        if not os.path.exists(filepath) or not os.path.isfile(filepath):
            filepath = os.path.join(os.path.dirname(__file__), "index.html")
        try:
            with open(filepath, "rb") as f:
                content = f.read()
            self.send_response(200)
            ext = os.path.splitext(filepath)[1]
            types = {".html": "text/html", ".css": "text/css", ".js": "application/javascript"}
            self.send_header("Content-Type", types.get(ext, "application/octet-stream"))
            self.end_headers()
            self.wfile.write(content)
        except Exception:
            self.send_error(404)

    def log_message(self, format, *args):
        print(f"[{self.log_date_time_string()}] {format % args}")


if __name__ == "__main__":
    server = http.server.HTTPServer(("", PORT), ProxyHandler)
    print(f"Serving at http://localhost:{PORT} (with TMDB proxy)")
    server.serve_forever()
