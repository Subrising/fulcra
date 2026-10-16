import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
};

export async function startStaticWeb(directory) {
  const root = path.resolve(directory);
  await readFile(path.join(root, "index.html"));
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
      const file = path.resolve(root, `.${pathname}`);
      if (!file.startsWith(`${root}${path.sep}`) && file !== root) {
        response.writeHead(403).end();
        return;
      }
      let body;
      let extension = path.extname(file);
      try {
        body = await readFile(file);
      } catch {
        if (extension && extension !== ".html") {
          response.writeHead(404).end();
          return;
        }
        extension = ".html";
        body = await readFile(path.join(root, "index.html"));
      }
      response.writeHead(200, { "Content-Type": types[extension] ?? "application/octet-stream" });
      response.end(body);
    } catch {
      response.writeHead(500).end();
    }
  });
  await new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  return {
    port: server.address().port,
    close: () =>
      new Promise((done, reject) =>
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          done();
        }),
      ),
  };
}
