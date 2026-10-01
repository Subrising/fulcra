import { describe, expect, it } from "vitest";
import { isGeneratedSessionName, sessionDisplayName } from "./session-display-name";
const uuid = "00000000-0000-4000-8000-000000000001";
describe("session display names", () => {
  it.each([uuid, `/tasks/${uuid}/`, `C:\\tasks\\${uuid}`, uuid.toUpperCase()])(
    "recognises UUID folder names: %s",
    (name) => {
      expect(isGeneratedSessionName(name)).toBe(true);
      expect(sessionDisplayName(name, null, "Fixture research")).toBe("Fixture research");
      expect(sessionDisplayName(name)).toBe("Untitled session");
    },
  );
  it("keeps explicitly set titles, even UUID-shaped titles", () => {
    expect(sessionDisplayName(uuid, "My title", "Agent title")).toBe("My title");
    expect(sessionDisplayName(uuid, uuid, "Agent title")).toBe(uuid);
  });
  it.each(["product", "feature/search", "my-project-123"])(
    "keeps normal repo and branch names: %s",
    (name) => {
      expect(sessionDisplayName(name, null, "Agent title")).toBe(name);
    },
  );
});
