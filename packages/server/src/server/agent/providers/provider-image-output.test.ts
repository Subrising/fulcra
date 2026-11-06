<<<<<<< HEAD
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
=======
import { existsSync, rmSync, statSync, readFileSync } from "node:fs";
>>>>>>> refs/remotes/upstream/tags/v0.14.0
import path from "node:path";
import MarkdownIt from "markdown-it";
import { projectTimelineRows } from "../timeline-projection.js";
import { describe, expect, test } from "vitest";

import {
<<<<<<< HEAD
  isEvictedProviderImage,
=======
  MAX_PROVIDER_IMAGE_BYTES,
>>>>>>> refs/remotes/upstream/tags/v0.14.0
  isProviderImageMarkdown,
  MAX_PRIVATE_FILES,
  materializeProviderImage,
  renderProviderImageOutputAsAssistantMarkdown,
} from "./provider-image-output.js";

const HASH = "a".repeat(64);

async function renderImageMarkdown(imagePath: string): Promise<string> {
  const item = await renderProviderImageOutputAsAssistantMarkdown({ path: imagePath });
  if (!item || item.type !== "assistant_message") {
    throw new Error("Expected provider image output to render as assistant markdown.");
  }
  return item.text;
}

describe("isProviderImageMarkdown", () => {
  test("matches the markdown emitted for a materialized attachment", () => {
    expect(isProviderImageMarkdown(`![Image](/tmp/paseo-attachments/${HASH}.png)`)).toBe(true);
    expect(isProviderImageMarkdown(`![Image](/tmp/paseo-attachments-a1B2c3/${HASH}.png)`)).toBe(
      true,
    );
    expect(isProviderImageMarkdown(`![Image](/tmp/paseo-attachments/user-1000/${HASH}.png)`)).toBe(
      true,
    );
    expect(isProviderImageMarkdown(`![shot](/var/folders/x/paseo-attachments/${HASH}.webp)`)).toBe(
      true,
    );
    // Windows: backslash path separators are doubled by escapeMarkdownImageSource.
    expect(
      isProviderImageMarkdown(
        `![Image](C:\\\\Users\\\\me\\\\AppData\\\\Local\\\\Temp\\\\paseo-attachments\\\\${HASH}.png)`,
      ),
    ).toBe(true);
  });

  test("emits Windows file paths as file URIs", async () => {
    const markdown = await renderImageMarkdown(
      `C:\\Users\\me\\AppData\\Local\\Temp\\paseo-attachments\\${HASH}.png`,
    );

    expect(markdown).toBe(
      `\n\n![Image](file:///C:/Users/me/AppData/Local/Temp/paseo-attachments/${HASH}.png)\n\n`,
    );
    expect(isProviderImageMarkdown(markdown)).toBe(true);
  });

  test("emits POSIX file paths with spaces as valid file URI markdown", async () => {
    const markdown = await renderImageMarkdown(
      "/home/user/Projects/Project With Spaces/screenshot.png",
    );

    expect(markdown).toBe(
      "\n\n![Image](file:///home/user/Projects/Project%20With%20Spaces/screenshot.png)\n\n",
    );
  });

  test("encodes URI-significant characters in POSIX file paths", async () => {
    const markdown = await renderImageMarkdown("/tmp/screenshot#1?draft.png");

    expect(markdown).toBe("\n\n![Image](file:///tmp/screenshot%231%3Fdraft.png)\n\n");
  });

  test("preserves double-leading slashes in POSIX file paths", async () => {
    const markdown = await renderImageMarkdown("//tmp/screenshot#1.png");

    expect(markdown).toBe("\n\n![Image](file:////tmp/screenshot%231.png)\n\n");
  });

  test.each([
    ["UNC", "\\\\server\\share\\shot#1.png", "file://server/share/shot%231.png"],
    [
      "extended UNC",
      "\\\\?\\UNC\\server\\share\\shot?draft.png",
      "file://server/share/shot%3Fdraft.png",
    ],
  ])("encodes %s image paths as file URIs", async (_label, imagePath, expectedSource) => {
    expect(await renderImageMarkdown(imagePath)).toBe(`\n\n![Image](${expectedSource})\n\n`);
  });

  test("rejects user-authored markdown that is not a materialized attachment", () => {
    // No content hash — a hand-written path, not something the writer produced.
    expect(isProviderImageMarkdown("![diagram](./paseo-attachments/notes.png)")).toBe(false);
    expect(isProviderImageMarkdown("![logo](https://example.com/logo.png)")).toBe(false);
    // Image markdown that does not start the text.
    expect(isProviderImageMarkdown("see the chart: ![chart](x.png)")).toBe(false);
  });
});

<<<<<<< HEAD
// Descriptor confinement is unsupported on Windows; assert that refusal below.
describe.runIf(process.platform !== "win32")("materializeProviderImage", () => {
  test("recreates the private temp directory if the cached directory is removed", () => {
    const first = materializeProviderImage({
=======
describe("materializeProviderImage", () => {
  test("recreates the private temp directory if the cached directory is removed", async () => {
    const first = await materializeProviderImage({
>>>>>>> refs/remotes/upstream/tags/v0.14.0
      data: "YWJjMTIz",
      mimeType: "image/png",
    });
    const firstDir = path.dirname(first.path);
    expect(existsSync(first.path)).toBe(true);

    rmSync(firstDir, { recursive: true, force: true });

    const second = await materializeProviderImage({
      data: "ZGVmNDU2",
      mimeType: "image/png",
    });
    const secondDir = path.dirname(second.path);

    try {
      expect(existsSync(second.path)).toBe(true);
    } finally {
      rmSync(secondDir, { recursive: true, force: true });
    }
  });
});

<<<<<<< HEAD
test.runIf(process.platform === "win32")(
  "Windows provider image materialization refuses rather than creating unconfined output",
  () => {
    expect(() => materializeProviderImage({ data: "YWJjMTIz", mimeType: "image/png" })).toThrow(
      "Confined image materialization unavailable",
    );
  },
);

// FULCRA(image-retention): at the cap the oldest images make room; new screenshots keep rendering.
describe("provider image retention", () => {
  test("past the file cap the newest image still renders and only the oldest is evicted", () => {
    const image = (i: number) => ({
      data: Buffer.from(`retention-test-image-${i}`).toString("base64"),
      mimeType: "image/png",
    });
    const first = materializeProviderImage(image(0)).path;
    let newest = "";
    for (let i = 1; i <= MAX_PRIVATE_FILES; i++) {
      const item = renderProviderImageOutputAsAssistantMarkdown(image(i), {
        materialize: materializeProviderImage,
      });
      if (item?.type !== "assistant_message") throw new Error("Expected an image message");
      expect(item.text).not.toContain("Image output was omitted");
      if (i === MAX_PRIVATE_FILES) newest = item.text;
    }
    expect(isProviderImageMarkdown(newest)).toBe(true);
    // Same bytes reuse the retained file, so this is the path the newest message renders.
    const newestPath = materializeProviderImage(image(MAX_PRIVATE_FILES)).path;
    expect(existsSync(newestPath)).toBe(true);
    expect(isEvictedProviderImage(newestPath)).toBe(false);
    expect(existsSync(first)).toBe(false);
    expect(isEvictedProviderImage(first)).toBe(true);
    expect(isEvictedProviderImage(path.join(path.dirname(first), "unknown.png"))).toBe(false);
    rmSync(path.dirname(first), { recursive: true, force: true });
  });

  test("an image shown again moves to the newest end; a replaced oldest file is forgotten, not deleted", () => {
    const image = (i: number) => ({
      data: Buffer.from(`retention-order-image-${i}`).toString("base64"),
      mimeType: "image/png",
    });
    const paths: string[] = [];
    for (let i = 0; i < MAX_PRIVATE_FILES; i++) paths.push(materializeProviderImage(image(i)).path);
    const dir = path.dirname(paths[0]);
    try {
      // Reuse image 0: the next eviction takes image 1, not image 0.
      expect(materializeProviderImage(image(0)).path).toBe(paths[0]);
      materializeProviderImage(image(MAX_PRIVATE_FILES));
      expect(existsSync(paths[0])).toBe(true);
      expect(existsSync(paths[1])).toBe(false);
      // Replace the (now) oldest file with another inode: it is kept on disk, and new images still render.
      rmSync(paths[2]);
      writeFileSync(paths[2], "not ours", { mode: 0o600 });
      const next = materializeProviderImage(image(MAX_PRIVATE_FILES + 1)).path;
      expect(existsSync(next)).toBe(true);
      expect(readFileSync(paths[2], "utf8")).toBe("not ours");
      expect(isEvictedProviderImage(paths[2])).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
=======
describe("provider image paragraph boundaries", () => {
  test.each(["", "\n"])("keeps image outputs separate from prose ending in %j", async (ending) => {
    const image = await renderProviderImageOutputAsAssistantMarkdown({
      url: "https://example.com/chart.png",
    });
    if (!image) throw new Error("Expected image output");
    const projected = projectTimelineRows({
      mode: "projected",
      rows: [
        {
          seq: 1,
          timestamp: "2026-10-16T15:08:23Z",
          item: { type: "assistant_message", text: `Before${ending}`, messageId: "commentary" },
        },
        { seq: 2, timestamp: "2026-10-16T15:08:24Z", item: image },
        {
          seq: 3,
          timestamp: "2026-10-16T15:08:25Z",
          item: { type: "assistant_message", text: "After" },
        },
      ],
    });
    expect(projected).toHaveLength(1);
    const item = projected[0]!.item;
    if (item.type !== "assistant_message") throw new Error("Expected assistant message");
    const paragraphs = new MarkdownIt()
      .parse(item.text, {})
      .filter((token) => token.type === "inline");
    expect(paragraphs.map((token) => token.content)).toEqual([
      "Before",
      "![Image](https://example.com/chart.png)",
      "After",
    ]);
  });
});

test("materialized image output retains paragraph boundaries and attachment recognition", async () => {
  const item = await renderProviderImageOutputAsAssistantMarkdown(
    { data: "YWJjMTIz", mimeType: "image/png" },
    { materialize: async () => ({ path: `/tmp/paseo-attachments/${HASH}.png` }) },
  );
  expect(item).toEqual({
    type: "assistant_message",
    text: `\n\n![Image](file:///tmp/paseo-attachments/${HASH}.png)\n\n`,
  });
  if (!item || item.type !== "assistant_message") throw new Error("Expected image output");
  expect(isProviderImageMarkdown(item.text)).toBe(true);
});

test("repeated content is reused without rewriting the attachment", async () => {
  const image = {
    data: Buffer.from("dedupe regression").toString("base64"),
    mimeType: "image/png",
  };
  const first = await materializeProviderImage(image);
  const before = statSync(first.path, { bigint: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = await materializeProviderImage(image);
  expect(second.path).toBe(first.path);
  expect(statSync(second.path, { bigint: true }).mtimeNs).toBe(before.mtimeNs);
});

test("64 MiB materialization leaves the event loop responsive and preserves bytes", async () => {
  const bytes = Buffer.alloc(64 * 1024 * 1024, 37);
  const data = bytes.toString("base64");
  let previous = performance.now();
  let longest = 0;
  const probe = setInterval(() => {
    const now = performance.now();
    longest = Math.max(longest, now - previous);
    previous = now;
  }, 1);
  try {
    const result = await materializeProviderImage({ data, mimeType: "image/png" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    console.log(`64 MiB attachment longest loop gap: ${longest.toFixed(2)} ms`);
    expect(longest).toBeLessThan(50);
    expect(readFileSync(result.path).equals(bytes)).toBe(true);
    rmSync(result.path, { force: true });
  } finally {
    clearInterval(probe);
  }
});

test("preserves base64 decoding across whitespace and chunk boundaries", async () => {
  const bytes = Buffer.alloc(512 * 1024, 123);
  const base64 = bytes.toString("base64");
  const data = base64.match(/.{1,77}/g)!.join("\n");
  const result = await materializeProviderImage({ data, mimeType: "image/png" });
  expect(readFileSync(result.path).equals(bytes)).toBe(true);
});

test("rejects oversized materialization before work and leaves the queue usable", async () => {
  const data = "A".repeat(Math.ceil(MAX_PROVIDER_IMAGE_BYTES / 3) * 4 + 260);
  await expect(materializeProviderImage({ data, mimeType: "image/png" })).rejects.toThrow(
    "exceeds",
  );
  const omitted = await renderProviderImageOutputAsAssistantMarkdown(
    { data, mimeType: "image/png" },
    { materialize: materializeProviderImage },
  );
  expect(omitted).toEqual({
    type: "assistant_message",
    text: "Image output was omitted because it was not available as a file path or URL.",
  });
  const image = await materializeProviderImage({ data: "YWJjMTIz", mimeType: "image/png" });
  expect(readFileSync(image.path).toString()).toBe("abc123");
});

test("simultaneous requests for the same content share the published file", async () => {
  const image = {
    data: Buffer.from("concurrent dedupe fixture").toString("base64"),
    mimeType: "image/png",
  };
  const results = await Promise.all([
    materializeProviderImage(image),
    materializeProviderImage(image),
  ]);
  expect(results[0]).toEqual(results[1]);
  expect(readFileSync(results[0].path).toString()).toBe("concurrent dedupe fixture");
});
>>>>>>> refs/remotes/upstream/tags/v0.14.0
