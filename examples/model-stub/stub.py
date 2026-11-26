"""The smallest server cohost's OpenAI-compatible provider accepts. Standard library only.

    mise run example:model-stub:py -- [port]      (default 8901, 0 = any free port)

A copy outside the checkout runs as `python3 stub.py [port]`.
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# region reply
REPLY = "[happy] Hello from the stub model server."
# endregion reply


class Handler(BaseHTTPRequestHandler):
    # region routes
    def do_GET(self):
        if self.path.split("?")[0] == "/v1/models":
            self.send_json(200, {"object": "list", "data": [{"id": "stub", "object": "model", "owned_by": "cohost"}]})
        else:
            self.send_json(404, {"error": "not found"})

    def do_POST(self):
        self.rfile.read(int(self.headers.get("content-length") or 0))  # the request is read and ignored
        if self.path.split("?")[0] == "/v1/chat/completions":
            self.send_json(200, {
                "id": "chatcmpl-stub",
                "object": "chat.completion",
                "created": 1700000000,  # a fixed time keeps the reply the same every run
                "model": "stub",
                "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": REPLY}}],
            })
        else:
            self.send_json(404, {"error": "not found"})
    # endregion routes

    def do_PUT(self):
        self.send_json(404, {"error": "not found"})

    do_DELETE = do_PATCH = do_PUT

    def send_json(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


def main():
    arg = sys.argv[1] if len(sys.argv) > 1 else "8901"
    if not arg.isdigit() or int(arg) > 65535:
        print("usage: python3 stub.py [port]", file=sys.stderr)
        sys.exit(1)
    server = ThreadingHTTPServer(("0.0.0.0", int(arg)), Handler)
    print(f"listening on {server.server_address[1]}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
