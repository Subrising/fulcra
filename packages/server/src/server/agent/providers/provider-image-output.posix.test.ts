import { createHash } from "node:crypto";
import {
  openSync,
  closeSync,
  fstatSync,
  constants,
  existsSync,
  rmSync,
  statSync,
  writeFileSync,
  unlinkSync,
  linkSync,
  readFileSync,
  mkdirSync,
  renameSync,
  symlinkSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { materializeProviderImage } from "./provider-image-output.js";

describe.skipIf(process.platform === "win32")("materializeProviderImage", () => {
  test("writes image attachments under a private temp directory", () => {
    const materialized = materializeProviderImage({
      data: "YWJjMTIz",
      mimeType: "image/png",
    });
    const attachmentDir = path.dirname(materialized.path);

    try {
      expect(path.basename(attachmentDir)).toMatch(/^paseo-attachments-/);
      expect(existsSync(materialized.path)).toBe(true);
      expect(statSync(attachmentDir).mode & 0o777).toBe(0o700);
      expect(statSync(materialized.path).mode & 0o777).toBe(0o600);
    } finally {
      unlinkSync(materialized.path);
    }
  });
});

test("confined materializer rejects hardlink replacement before touching outside bytes", () => {
  const first = materializeProviderImage({
    data: Buffer.from("hardlink-proof").toString("base64"),
    mimeType: "image/png",
  });
  const outside = `${path.dirname(first.path)}-outside-proof`;
  writeFileSync(outside, "outside-unchanged");
  unlinkSync(first.path);
  linkSync(outside, first.path);
  try {
    expect(() =>
      materializeProviderImage({
        data: Buffer.from("hardlink-proof").toString("base64"),
        mimeType: "image/png",
      }),
    ).toThrow();
    expect(readFileSync(outside, "utf8")).toBe("outside-unchanged");
  } finally {
    unlinkSync(first.path);
    unlinkSync(outside);
  }
});
test("confined materializer refuses symlink and directory root replacement", () => {
  for (const symlink of [true, false]) {
    const first = materializeProviderImage({
      data: Buffer.from(`root-proof-${symlink}`).toString("base64"),
      mimeType: "image/png",
    });
    const root = path.dirname(first.path),
      saved = `${root}-saved`,
      outside = `${root}-outside`;
    mkdirSync(outside);
    renameSync(root, saved);
    if (symlink) symlinkSync(outside, root);
    else mkdirSync(root, { mode: 0o700 });
    try {
      expect(() =>
        materializeProviderImage({
          data: Buffer.from("never-write").toString("base64"),
          mimeType: "image/png",
        }),
      ).toThrow();
      expect(readdirSync(outside)).toEqual([]);
      if (!symlink) expect(readdirSync(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      renameSync(saved, root);
      rmSync(outside, { recursive: true, force: true });
    }
  }
});
test("confined materializer bounds bytes before effects and reuses genuine inode read-only", () => {
  const input = { data: Buffer.from("reuse-proof").toString("base64"), mimeType: "image/png" };
  const first = materializeProviderImage(input),
    before = statSync(first.path);
  expect(materializeProviderImage(input).path).toBe(first.path);
  expect(statSync(first.path).ino).toBe(before.ino);
  const beforeFiles = readdirSync(path.dirname(first.path));
  expect(() =>
    materializeProviderImage({ data: "A".repeat(24 * 1024 * 1024), mimeType: "image/png" }),
  ).toThrow("byte limit");
  expect(readdirSync(path.dirname(first.path))).toEqual(beforeFiles);
});

test("confined materializer refuses unknown preexisting destination without truncation", () => {
  const first = materializeProviderImage({
    data: Buffer.from("root-anchor").toString("base64"),
    mimeType: "image/png",
  });
  const bytes = Buffer.from("unknown-destination"),
    target = path.join(
      path.dirname(first.path),
      `${createHash("sha256").update(bytes).digest("hex")}.png`,
    );
  writeFileSync(target, "untouched", { mode: 0o600 });
  try {
    expect(() =>
      materializeProviderImage({ data: bytes.toString("base64"), mimeType: "image/png" }),
    ).toThrow();
    expect(readFileSync(target, "utf8")).toBe("untouched");
  } finally {
    unlinkSync(target);
  }
});

test("absent old pathname after root rename refuses pool reset and preserves genuine reuse", () => {
  const input = { data: Buffer.from("moved-root-proof").toString("base64"), mimeType: "image/png" };
  const first = materializeProviderImage(input),
    root = path.dirname(first.path),
    moved = `${root}-moved`;
  renameSync(root, moved);
  try {
    expect(existsSync(root)).toBe(false);
    expect(() =>
      materializeProviderImage({
        data: Buffer.from("forbidden-fresh-pool").toString("base64"),
        mimeType: "image/png",
      }),
    ).toThrow("moved or deletion unproved");
    expect(existsSync(root)).toBe(false);
    expect(readFileSync(path.join(moved, path.basename(first.path)), "utf8")).toBe(
      "moved-root-proof",
    );
  } finally {
    renameSync(moved, root);
  }
  expect(materializeProviderImage(input).path).toBe(first.path);
});
test("genuine deleted root releases pool only with descriptor proof otherwise fails closed", () => {
  const first = materializeProviderImage({
      data: Buffer.from("deleted-root-proof").toString("base64"),
      mimeType: "image/png",
    }),
    root = path.dirname(first.path);
  const fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    rmSync(root, { recursive: true });
    expect(existsSync(root)).toBe(false);
    const nextInput = {
      data: Buffer.from("fresh-after-deletion").toString("base64"),
      mimeType: "image/png",
    };
    if (fstatSync(fd).nlink === 0) {
      const next = materializeProviderImage(nextInput);
      expect(path.dirname(next.path)).not.toBe(root);
      expect(readFileSync(next.path, "utf8")).toBe("fresh-after-deletion");
    } else {
      // Darwin/APFS retains a nonzero descriptor link count even after removal: no proof, no reset.
      expect(() => materializeProviderImage(nextInput)).toThrow("moved or deletion unproved");
      expect(existsSync(root)).toBe(false);
    }
  } finally {
    closeSync(fd);
  }
});
