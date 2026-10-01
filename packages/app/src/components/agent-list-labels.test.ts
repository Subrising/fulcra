import { sessionAccount, sessionAccountText } from "@/sessions/session-account";
import { describe, expect, it } from "vitest";
import { historyRowLabels, UNNAMED_PROJECT } from "./agent-list-labels";

// J15: History showed "2b642082-5538-…" for the MacBook session "CC REPAIR (MacBook): visible re-pair
// path…", because a job folder named by an id led the row and squeezed the title out.
const ID = "2b642082-5538-4c69-ab90-17f1d45d801d";

describe("History row labels: names, never ids (MH4)", () => {
  it("a session in an id-named folder leads with its title; the folder id is not shown", () => {
    const labels = historyRowLabels({
      workspaceName: ID,
      projectName: ID,
      title: "CC REPAIR (MacBook): visible re-pair path",
      fallbackTitle: "New session",
    });
    expect(labels).toEqual({
      lead: null,
      title: "CC REPAIR (MacBook): visible re-pair path",
      project: UNNAMED_PROJECT,
    });
    expect(JSON.stringify(labels)).not.toContain("2b642082");
  });

  it("a real folder or project name still leads", () => {
    expect(
      historyRowLabels({
        workspaceName: "book-codex",
        projectName: "orca",
        title: "Orca MacBook independent Codex",
        fallbackTitle: "New session",
      }).lead,
    ).toEqual({ text: "book-codex", kind: "workspace" });
    expect(
      historyRowLabels({
        workspaceName: ID,
        projectName: "orca",
        title: "Review",
        fallbackTitle: "New session",
      }).lead,
    ).toEqual({ text: "orca", kind: "project" });
    expect(
      historyRowLabels({
        workspaceName: `/tmp/tasks/${ID}`,
        projectName: "",
        title: "Review",
        fallbackTitle: "New session",
      }).lead,
    ).toBeNull();
  });

  it("a missing or id-only title reads as the plain fallback", () => {
    for (const title of [null, "", "  ", ID]) {
      expect(
        historyRowLabels({
          workspaceName: ID,
          projectName: ID,
          title,
          fallbackTitle: "New session",
        }).title,
      ).toBe("New session");
    }
  });
});

describe("live account projection display", () => {
  it("uses runtime wire labels through A to B to A in the same session", () => {
    const labels = { "fulcra.account-name": "A", "saved-login": "Personal" };
    for (const name of ["A", "B", "A"]) {
      labels["fulcra.account-name"] = name;
      expect(sessionAccount({ provider: "codex", labels })).toEqual({
        providerLabel: "Codex",
        name,
      });
    }
  });
  it("keeps absent ownership unavailable instead of using a saved login", () => {
    const account = sessionAccount({ provider: "claude", labels: { "saved-login": "Personal" } });
    expect(account).toEqual({ providerLabel: "Claude", name: null });
    expect(sessionAccountText(account!)).toBe("Account unavailable");
  });
  it("a disabled or removed roster row does not change an attached runtime label", () => {
    expect(
      sessionAccount({ provider: "claude", labels: { "fulcra.account-name": "Work" } })?.name,
    ).toBe("Work");
    expect(
      sessionAccount({ provider: "pi", labels: { "fulcra.account-name": "Work" } }),
    ).toBeNull();
  });
});
