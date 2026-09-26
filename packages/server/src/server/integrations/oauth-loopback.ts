import { createServer } from "node:http";
import type { LoopbackListener } from "./sign-in-flows.js";

// Desktop OAuth redirect target (RFC 8252 §7.3): an ephemeral port on the IPv4 loopback literal,
// bound for one sign-in. It accepts a GET on /oauth/<uuid> and hands the full URL to the flow, which
// checks the path and `state`. The page it serves never echoes anything from the request.
const CALLBACK_PATH = /^\/oauth\/[0-9a-f-]{36}$/;
const PAGE =
  "<!doctype html><meta charset=utf-8><title>Fulcra</title>" +
  "<p style='font-family:system-ui;margin:3rem'>Sign-in received. You can close this window and return to Fulcra.</p>";

export function openOAuthLoopback(onCallback: (url: string) => void): Promise<LoopbackListener> {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      // Only an origin-form target ("/oauth/<uuid>?…") is a callback. Anything else, including a
      // target that is not a parseable URL, gets 400 and never reaches or consumes a flow.
      const target = request.url ?? "";
      let url: URL | null = null;
      if (target.startsWith("/") && !target.startsWith("//")) {
        try {
          url = new URL(target, "http://127.0.0.1");
        } catch {
          url = null;
        }
      }
      if (!url) {
        response.writeHead(400, { "Content-Type": "text/plain" }).end("Bad request");
        return;
      }
      if (request.method !== "GET" || !CALLBACK_PATH.test(url.pathname)) {
        response.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
        return;
      }
      response
        .writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        })
        .end(PAGE);
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      onCallback(`http://127.0.0.1:${port}${url.pathname}${url.search}`);
    });
    // Malformed HTTP is answered by Node's parser; it must never become an uncaught error.
    server.on("clientError", (_error, socket) => {
      if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      else socket.destroy();
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address !== "object") {
        server.close();
        reject(new Error("Loopback listener has no address"));
        return;
      }
      // The flow closes the listener when it finishes or its expiry timer fires; unref keeps an
      // open listener from holding the daemon open at shutdown.
      server.unref();
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        close: () => {
          server.close();
          server.closeAllConnections();
        },
      });
    });
  });
}
