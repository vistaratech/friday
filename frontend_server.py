"""
Token server for the F.R.I.D.A.Y. frontend.
Serves the static frontend AND provides a /token endpoint
that generates LiveKit access tokens.

Run:  python frontend_server.py
"""

import os
import json
from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
from pathlib import Path

from dotenv import load_dotenv
from livekit.api import AccessToken, VideoGrants

load_dotenv()

LIVEKIT_API_KEY = os.getenv("LIVEKIT_API_KEY", "")
LIVEKIT_API_SECRET = os.getenv("LIVEKIT_API_SECRET", "")
FRONTEND_DIR = Path(__file__).parent / "frontend"
PORT = 8080


class FridayHandler(SimpleHTTPRequestHandler):
    """Serves static files from /frontend and handles /token requests."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(FRONTEND_DIR), **kwargs)

    def do_GET(self):
        parsed = urlparse(self.path)

        if parsed.path == "/token":
            self._handle_token(parsed)
        else:
            super().do_GET()

    def _handle_token(self, parsed):
        params = parse_qs(parsed.query)
        room_name = params.get("room", ["friday-room"])[0]
        identity = params.get("identity", ["boss"])[0]

        if not LIVEKIT_API_KEY or not LIVEKIT_API_SECRET:
            self._json_response(500, {"error": "LIVEKIT_API_KEY/SECRET not set in .env"})
            return

        token = (
            AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
            .with_identity(identity)
            .with_name(identity)
            .with_grants(VideoGrants(
                room_join=True,
                room=room_name,
            ))
        )

        jwt_token = token.to_jwt()

        self._json_response(200, {"accessToken": jwt_token})

    def _json_response(self, code, data):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        # Cleaner logging
        print(f"  [FRIDAY-UI]  {args[0]}")


def main():
    print(f"""
    ===================================================
      F.R.I.D.A.Y. -- Frontend Server
    ===================================================
      UI:     http://localhost:{PORT}
      Token:  http://localhost:{PORT}/token
    ===================================================
    """)
    server = HTTPServer(("0.0.0.0", PORT), FridayHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Shutting down...")
        server.server_close()


if __name__ == "__main__":
    main()
