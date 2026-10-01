import { describe, expect, it } from "vitest";
import { CredentialRequestError, sendCredentialRequest } from "./credential-request.js";
import { PROVIDERS } from "./providers.js";

// A fake GitHub-shaped token. Every test asks the same question: can the plugin see it, or get it
// back by decoding what it received?
const TOKEN = "ghp_CANARYtoken0123456789/abcDEF";
const github = PROVIDERS.find((provider) => provider.id === "github")!;

function escapeAll(text: string): string {
  return [...text].map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
}

function escapeHalf(text: string): string {
  return [...text].map((char, index) => (index % 2 ? char : escapeAll(char))).join("");
}

// Everything a plugin could do to recover the token from the answer.
function recoverable(body: unknown): boolean {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const decoded = text
    .replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(/\\\//g, "/");
  let reparsed = "";
  try {
    reparsed = JSON.stringify(
      JSON.parse(typeof body === "string" ? body : text),
      (_key, value) => value,
    );
  } catch {
    reparsed = "";
  }
  return [text, decoded, reparsed].some((candidate) => candidate.includes(TOKEN));
}

function answer(
  rawBody: string,
  contentType: string,
  headers: Record<string, string> = {},
): typeof fetch {
  return (async () =>
    new Response(rawBody, {
      status: 200,
      headers: { "Content-Type": contentType, ...headers },
    })) as typeof fetch;
}

function send(fetchImpl: typeof fetch) {
  return sendCredentialRequest({
    provider: github,
    site: null,
    authorization: `Bearer ${TOKEN}`,
    secrets: [TOKEN, `Bearer ${TOKEN}`],
    request: { method: "GET", path: "/user" },
    fetch: fetchImpl,
  });
}

describe("host-mediated answers: decoded scrubbing (R-D-1)", () => {
  it("scrubs a token written entirely as \\u escapes in a JSON value", async () => {
    const result = await send(answer(`{"echo":"${escapeAll(TOKEN)}"}`, "application/json"));
    expect(result.body).toEqual({ echo: "[redacted]" });
    expect(recoverable(result.body)).toBe(false);
  });

  it("scrubs an escaped token used as an object key, and nested values in arrays and objects", async () => {
    const raw = `{"${escapeAll(TOKEN)}":{"list":[1,"${escapeHalf(TOKEN)}",{"deep":["x ${escapeAll(TOKEN)} y"]}]}}`;
    const result = await send(answer(raw, "application/json; charset=utf-8"));
    expect(result.body).toEqual({
      "[redacted]": { list: [1, "[redacted]", { deep: ["x [redacted] y"] }] },
    });
    expect(recoverable(result.body)).toBe(false);
  });

  it("scrubs mixed escapes: half \\u-escaped, escaped slash, and plain", async () => {
    const mixed = escapeHalf(TOKEN).replace("/", "\\/");
    const result = await send(
      answer(
        `{"a":"${mixed}","b":"${TOKEN.replace("/", "\\/")}","c":"${TOKEN}"}`,
        "application/json",
      ),
    );
    expect(result.body).toEqual({ a: "[redacted]", b: "[redacted]", c: "[redacted]" });
  });

  it("keeps a __proto__ key as ordinary data", async () => {
    const result = await send(answer(`{"__proto__":{"polluted":true},"ok":1}`, "application/json"));
    const body = result.body as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(body, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(body)).toBe(Object.prototype);
  });

  it("does not let JSON served as text, or escaped plain text, carry a recoverable token", async () => {
    const asText = await send(answer(`{"echo":"${escapeAll(TOKEN)}"}`, "text/plain"));
    expect(typeof asText.body).toBe("string");
    expect(recoverable(asText.body)).toBe(false);
    const prose = await send(answer(`token is ${escapeHalf(TOKEN)} (not JSON)`, "text/plain"));
    expect(prose.body).toBe("token is [redacted] (not JSON)");
    const ordinary = await send(answer(`literal \\u0041 stays as sent`, "text/plain"));
    expect(ordinary.body).toBe("literal \\u0041 stays as sent");
  });

  it("scrubs escaped tokens in returned header values", async () => {
    const result = await send(answer("{}", "application/json", { ETag: `"${escapeAll(TOKEN)}"` }));
    expect(result.headers.etag).toBe('"[redacted]"');
  });
});

describe("host-mediated errors are host-written, bounded and secret-free (R-D-1)", () => {
  it("turns a body stream failure that carries the token into a fixed message", async () => {
    const failing = (async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.error(new Error(`socket reset while sending ${TOKEN}`));
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;
    const error = await send(failing).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CredentialRequestError);
    expect((error as Error).message).toBe("The request to GitHub failed");
  });

  it("never lets a fetch failure message through", async () => {
    const failing = (async () => {
      throw new Error(`ECONNRESET ${TOKEN}`);
    }) as typeof fetch;
    await expect(send(failing)).rejects.toThrow("Couldn't reach GitHub");
    await expect(send(failing)).rejects.not.toThrow(TOKEN);
  });

  it("bounds error length", () => {
    expect(new CredentialRequestError("x".repeat(5000)).message.length).toBeLessThanOrEqual(301);
  });
});
