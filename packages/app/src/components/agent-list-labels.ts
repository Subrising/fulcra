import { isGeneratedSessionName } from "@/utils/session-display-name";

/**
 * What a History row says, names never ids. Sessions started in a job folder named by an id (for
 * example "2b642082-5538-…") used to lead with that folder, which pushed the real title out of view.
 * A generated folder id is never the lead: the row leads with the folder name only when it is a real
 * name, and otherwise with the session title. A project known only by an id reads as a plain phrase.
 */
export interface HistoryRowLabels {
  /** Shown before the title (folder or project name), or null when the title should lead. */
  lead: { text: string; kind: "workspace" | "project" } | null;
  title: string;
  project: string;
}

export const UNNAMED_PROJECT = "Unnamed folder";

function isRealName(value: string | null | undefined): value is string {
  return Boolean(value?.trim()) && !isGeneratedSessionName(value!);
}

export function historyRowLabels(input: {
  workspaceName: string | null | undefined;
  projectName: string | null | undefined;
  title: string | null | undefined;
  fallbackTitle: string;
}): HistoryRowLabels {
  const title = isRealName(input.title) ? input.title.trim() : input.fallbackTitle;
  let lead: HistoryRowLabels["lead"] = null;
  if (isRealName(input.workspaceName)) lead = { text: input.workspaceName, kind: "workspace" };
  else if (isRealName(input.projectName)) lead = { text: input.projectName, kind: "project" };
  return {
    lead,
    title,
    project: isRealName(input.projectName) ? input.projectName : UNNAMED_PROJECT,
  };
}
