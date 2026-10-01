import type { ReactNode } from "react";
// Only inactive services surrounding the production row are replaced in this fixture.
export const useAppSettings = () => ({ settings: { workspaceTitleSource: "name" } });
export const useWorkspaceLabelDefinitions = () => [];
export const WorkspaceMetaRow = () => null;
export const WorkspaceHoverCard = ({ children }: { children?: ReactNode }) => children;
export const StatusRing = () => null;
