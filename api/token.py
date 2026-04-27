from http.server import BaseHTTPRequestHandler
import json
import os
from urllib.parse import urlparse, parse_qs
from livekit.api import AccessToken, VideoGrants

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        room_name = params.get("room", ["friday-room"])[0]
        identity = params.get("identity", ["boss"])[0]

        api_key = os.getenv("LIVEKIT_API_KEY")
        api_secret = os.getenv("LIVEKIT_API_SECRET")

        if not api_key or not api_secret:
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "LIVEKIT_API_KEY or LIVEKIT_API_SECRET not set in environment"}).encode())
            return

        try:
            token = (
                AccessToken(api_key, api_secret)
                .with_identity(identity)
                .with_name(identity)
                .with_grants(VideoGrants(
                    room_join=True,
                    room=room_name,
                ))
            )
            jwt_token = token.to_jwt()

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"accessToken": jwt_token}).encode())
        except Exception as e:
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())
