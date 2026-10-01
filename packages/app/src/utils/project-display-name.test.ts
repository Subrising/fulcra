import { describe, expect, it } from "vitest";
import {
  projectDisplayName,
  projectDisplayNameFromProjectId,
  projectIconPlaceholderLabelFromDisplayName,
} from "./project-display-name";

describe("projectDisplayNameFromProjectId", () => {
  it("shows owner and repo for GitHub remote ids", () => {
    expect(projectDisplayNameFromProjectId("remote:github.com/getpaseo/paseo")).toBe(
      "getpaseo/paseo",
    );
  });

  it("shows the trailing directory name for local projects", () => {
    expect(projectDisplayNameFromProjectId("/Users/me/dev/paseo")).toBe("paseo");
  });
});

describe("projectIconPlaceholderLabelFromDisplayName", () => {
  it("uses repo name instead of owner for GitHub-style display names", () => {
    expect(projectIconPlaceholderLabelFromDisplayName("getpaseo/paseo")).toBe("paseo");
  });

  it("returns the original display name when it has no path separator", () => {
    expect(projectIconPlaceholderLabelFromDisplayName("paseo")).toBe("paseo");
  });
});

describe("project heading names", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  it.each([id, id.toUpperCase(), `/fixtures/${id}/`, `C:\\fixtures\\${id}`, "", "  "])(
    "hides generated or empty headings: %s",
    (name) => {
      expect(projectDisplayName(name, name)).toBe("Untitled project");
      expect(projectDisplayName(name, "Launch planning")).toBe("Launch planning");
    },
  );
  it("uses a real project name when the custom name is generated", () => {
    expect(projectDisplayName("Example shop", id)).toBe("Example shop");
    expect(projectDisplayName("owner/repo")).toBe("owner/repo");
  });
});
