import http.server
import os
import sys

web_dir = os.path.dirname(os.path.realpath(__file__))
os.chdir(web_dir)
PORT = 8080

class NoCacheHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        self.send_header('Access-Control-Allow-Origin', '*')
        super().end_headers()

if __name__ == '__main__':
    try:
        http.server.ThreadingHTTPServer.allow_reuse_address = True
        server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), NoCacheHTTPRequestHandler)
        print(f"Servidor KIKES ABA PWA iniciado en http://localhost:{PORT} (o http://127.0.0.1:{PORT})", flush=True)
        server.serve_forever()
    except Exception as e:
        print(f"Error en puerto {PORT}: {e}, probando en puerto 8088...", flush=True)
        try:
            PORT = 8088
            server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), NoCacheHTTPRequestHandler)
            print(f"Servidor KIKES ABA PWA iniciado en http://localhost:{PORT} (o http://127.0.0.1:{PORT})", flush=True)
            server.serve_forever()
        except Exception as e2:
            print(f"Error fatal al iniciar servidor: {e2}", flush=True)
