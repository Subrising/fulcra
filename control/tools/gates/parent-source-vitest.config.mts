import path from "node:path";
import { defineConfig, mergeConfig } from "vitest/config";
import base from "../../../vitest.config";

// Exercise the current canonical schema without generating protocol dist.
export default mergeConfig(
  base,
  defineConfig({
    resolve: {
      alias: [
        {
          find: /^@getpaseo\/protocol\/trusted-input$/,
          replacement: path.resolve(__dirname, "../../../packages/protocol/src/trusted-input.ts"),
        },
      ],
    },
  }),
);
