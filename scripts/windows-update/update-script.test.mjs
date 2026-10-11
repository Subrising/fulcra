// FU-67 (0.2.15 review, finding 4): the Windows update script and its README. PowerShell does not run in this test;
// it reads the script text for the parts that broke: -Check tested C: and not the builds drive, and the app path
// went to explorer.exe without quotes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const script = readFileSync(new URL("./update.ps1", import.meta.url), "utf8");
const readme = readFileSync(new URL("./README.md", import.meta.url), "utf8");

function checkBlock() {
  const start = script.indexOf("if ($Check) {");
  assert.ok(start > 0, "-Check block found");
  return script.slice(start, script.indexOf("exit 0", start));
}

test("-Check tests the builds drive, not C:", () => {
  const block = checkBlock();
  assert.match(block, /Split-Path \$Builds -Qualifier/);
  assert.match(block, /Test-Path "\$drive\\"/);
  assert.match(block, /Get-PSDrive \(\$drive\.TrimEnd\(':'\)\)/);
  assert.doesNotMatch(block, /Get-PSDrive C\b/);
});

test("the app path to explorer.exe is quoted", () => {
  const start = script.slice(script.indexOf("function StartApp"));
  const line = start
    .split("\n")
    .find((text) => text.includes("Start-Process -FilePath explorer.exe"));
  assert.ok(line, "StartApp starts explorer.exe");
  assert.match(line, /'"' \+ \(Join-Path \$Current 'Fulcra\.exe'\) \+ '"'/);
});

test("the README names the builds drive default and claims no ownership check", () => {
  assert.doesNotMatch(readme, /USERPROFILE\\fulcra-builds/);
  assert.match(readme, /E:\\fulcra-builds/);
  assert.doesNotMatch(readme, /the ownership check refuses mount points/);
});
