import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

import {
  isEvictedProviderImage,
  isProviderImageMarkdown,
  MAX_PRIVATE_FILES,
  materializeProviderImage,
  renderProviderImageOutputAsAssistantMarkdown,
} from "./provider-image-output.js";

const HASH = "a".repeat(64);

function renderImageMarkdown(imagePath: string): string {
  const item = renderProviderImageOutputAsAssistantMarkdown({ path: imagePath });
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

  test("emits Windows file paths as file URIs", () => {
    const markdown = renderImageMarkdown(
      `C:\\Users\\me\\AppData\\Local\\Temp\\paseo-attachments\\${HASH}.png`,
    );

    expect(markdown).toBe(
      `![Image](file:///C:/Users/me/AppData/Local/Temp/paseo-attachments/${HASH}.png)`,
    );
    expect(isProviderImageMarkdown(markdown)).toBe(true);
  });

  test("emits POSIX file paths with spaces as valid file URI markdown", () => {
    const markdown = renderImageMarkdown("/home/user/Projects/Project With Spaces/screenshot.png");

    expect(markdown).toBe(
      "![Image](file:///home/user/Projects/Project%20With%20Spaces/screenshot.png)",
    );
  });

  test("encodes URI-significant characters in POSIX file paths", () => {
    const markdown = renderImageMarkdown("/tmp/screenshot#1?draft.png");

    expect(markdown).toBe("![Image](file:///tmp/screenshot%231%3Fdraft.png)");
  });

  test("preserves double-leading slashes in POSIX file paths", () => {
    const markdown = renderImageMarkdown("//tmp/screenshot#1.png");

    expect(markdown).toBe("![Image](file:////tmp/screenshot%231.png)");
  });

  test.each([
    ["UNC", "\\\\server\\share\\shot#1.png", "file://server/share/shot%231.png"],
    [
      "extended UNC",
      "\\\\?\\UNC\\server\\share\\shot?draft.png",
      "file://server/share/shot%3Fdraft.png",
    ],
  ])("encodes %s image paths as file URIs", (_label, imagePath, expectedSource) => {
    expect(renderImageMarkdown(imagePath)).toBe(`![Image](${expectedSource})`);
  });

  test("rejects user-authored markdown that is not a materialized attachment", () => {
    // No content hash — a hand-written path, not something the writer produced.
    expect(isProviderImageMarkdown("![diagram](./paseo-attachments/notes.png)")).toBe(false);
    expect(isProviderImageMarkdown("![logo](https://example.com/logo.png)")).toBe(false);
    // Image markdown that does not start the text.
    expect(isProviderImageMarkdown("see the chart: ![chart](x.png)")).toBe(false);
  });
});

// Descriptor confinement is unsupported on Windows; assert that refusal below.
describe.runIf(process.platform !== "win32")("materializeProviderImage", () => {
  test("recreates the private temp directory if the cached directory is removed", () => {
    const first = materializeProviderImage({
      data: "YWJjMTIz",
      mimeType: "image/png",
    });
    const firstDir = path.dirname(first.path);
    expect(existsSync(first.path)).toBe(true);

    rmSync(firstDir, { recursive: true, force: true });

    const second = materializeProviderImage({
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
