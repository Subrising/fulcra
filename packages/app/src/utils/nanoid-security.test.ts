import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";

test("navigation ID generators terminate on zero and negative lengths", () => {
  // Run malformed inputs in a bounded child: an old generator loops forever.
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { nanoid, customAlphabet } from 'nanoid/non-secure';
       for (const make of [nanoid, customAlphabet('abc')]) {
         if (make().length !== 21) throw Error('default navigation ID length');
         for (const size of [0, -1]) {
           try {
             if (make(size) !== '') throw Error('invalid size produced an ID');
           } catch (error) {
             if (!(error instanceof RangeError)) throw error;
           }
         }
       }
       console.log('bounded');`,
    ],
    { timeout: 3000, encoding: "utf8" },
  );
  expect(output.trim()).toBe("bounded");
});
