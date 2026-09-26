import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import { openOAuthLoopback } from "./oauth-loopback.js";

function rawRequest(origin: string, requestText: string): Promise<string> {
  const { port } = new URL(origin);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), "127.0.0.1", () => socket.write(requestText));
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      data += chunk;
    });
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
  });
}

describe("OAuth loopback listener", () => {
  it("answers malformed and absolute-form targets with 400 and keeps serving the real callback", async () => {
    const callbacks: string[] = [];
    const listener = await openOAuthLoopback((url) => callbacks.push(url));
    try {
      const invalid = await rawRequest(
        listener.origin,
        "GET http://[invalid HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
      );
      expect(invalid).toMatch(/^HTTP\/1\.1 400/);
      const absolute = await rawRequest(
        listener.origin,
        "GET http://127.0.0.1/oauth/00000000-0000-4000-8000-000000000000?code=c HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
      );
      expect(absolute).toMatch(/^HTTP\/1\.1 400/);
      const garbage = await rawRequest(listener.origin, "\u0000\u0001not http\r\n\r\n");
      expect(garbage).toMatch(/^HTTP\/1\.1 400/);
      expect(callbacks).toEqual([]);

      const flowId = "00000000-0000-4000-8000-000000000001";
      const response = await fetch(`${listener.origin}/oauth/${flowId}?code=c&state=s`);
      expect(response.status).toBe(200);
      expect(await response.text()).not.toContain("code=c");
      expect(callbacks).toEqual([`${listener.origin}/oauth/${flowId}?code=c&state=s`]);
      expect((await fetch(`${listener.origin}/other`)).status).toBe(404);
    } finally {
      listener.close();
    }
    await expect(fetch(`${listener.origin}/oauth/x`)).rejects.toThrow();
  });
});
