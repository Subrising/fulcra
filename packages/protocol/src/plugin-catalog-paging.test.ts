import { expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import {
  PluginCatalogPageRequestSchema,
  PluginCatalogBundleGetRequestSchema,
  PluginCatalogBundleGetResponseSchema,
  PluginCatalogPageResponseSchema,
} from "./plugin-catalog-paging.js";

test("L17 schema refuses caller authority and invalid/oversized chunks", () => {
  expect(
    PluginCatalogPageRequestSchema.safeParse({
      type: "plugin.catalog.page.request",
      requestId: "read",
      principal: "owner",
    }).success,
  ).toBe(false);
  const input = {
    type: "plugin.catalog.bundle.get.request",
    requestId: "read",
    snapshotId: randomUUID(),
    reference: randomUUID(),
    offset: 0,
    length: 65536,
  };
  expect(PluginCatalogBundleGetRequestSchema.parse(input)).toEqual(input);
  for (const change of [
    { length: 65537 },
    { offset: -1 },
    { path: "/fixture/private" },
    { grant: true },
  ])
    expect(PluginCatalogBundleGetRequestSchema.safeParse({ ...input, ...change }).success).toBe(
      false,
    );
});

test("L17 separate script read has explicit correlated refusals and bounded encoded bytes", () => {
  expect(
    PluginCatalogPageResponseSchema.parse({
      type: "plugin.catalog.page.response",
      payload: { requestId: "read", status: "refused", error: "expired" },
    }).payload.status,
  ).toBe("refused");
  const payload = {
    requestId: "read",
    status: "ok",
    version: 1,
    snapshotId: randomUUID(),
    revision: randomUUID(),
    manifestHash: "a".repeat(64),
    expiresAt: Date.now() + 30000,
    reference: randomUUID(),
    sha256: "b".repeat(64),
    offset: 0,
    totalBytes: 65536,
    data: Buffer.alloc(65536).toString("base64"),
    eof: true,
  };
  expect(
    PluginCatalogBundleGetResponseSchema.safeParse({
      type: "plugin.catalog.bundle.get.response",
      payload,
    }).success,
  ).toBe(true);
  for (const data of ["not base64", Buffer.alloc(65537).toString("base64")])
    expect(
      PluginCatalogBundleGetResponseSchema.safeParse({
        type: "plugin.catalog.bundle.get.response",
        payload: { ...payload, data },
      }).success,
    ).toBe(false);
});
