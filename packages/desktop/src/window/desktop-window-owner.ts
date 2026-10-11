import { PendingOpenProjectStore } from "../pending-open-project-store.js";

export interface OwnedDesktopWindow<TAgentTarget> {
  webContentsId: number;
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  sendAgent(target: TAgentTarget): void;
}

interface DesktopWindowOwnerPort<TAgentTarget> {
  create(input: {
    initialRoute: string | null;
    restoreWindowState: boolean;
    onCreated(webContentsId: number): void;
    onClosed(webContentsId: number): void;
  }): Promise<OwnedDesktopWindow<TAgentTarget>>;
  windows(): OwnedDesktopWindow<TAgentTarget>[];
  focusedWindow(): OwnedDesktopWindow<TAgentTarget> | null;
  agentRoute(target: TAgentTarget): string;
  deliverAgent(webContentsId: number, target: TAgentTarget): TAgentTarget | null;
}

export interface DesktopWindowOwner<TAgentTarget> {
  openPrimary(input?: {
    initialRoute?: string | null;
    pendingProjectPath?: string | null;
  }): Promise<void>;
  openAdditional(input?: { pendingProjectPath?: string | null }): Promise<void>;
  openOrFocusAgent(target: TAgentTarget): Promise<void>;
  /** A second launch of the app: a project path opens a window for it, otherwise the app comes to the front. */
  openFromRelaunch(input: { pendingProjectPath: string | null }): Promise<void>;
  restoreWhenActivated(): Promise<void>;
  takePendingProject(webContentsId: number): string | null;
}

export function createDesktopWindowOwner<TAgentTarget>(
  port: DesktopWindowOwnerPort<TAgentTarget>,
): DesktopWindowOwner<TAgentTarget> {
  const pendingProjects = new PendingOpenProjectStore();
  let agentWindowCreation: Promise<void> | null = null;

  const open = async (input: {
    initialRoute: string | null;
    pendingProjectPath: string | null;
    restoreWindowState: boolean;
  }): Promise<void> => {
    await port.create({
      initialRoute: input.initialRoute,
      restoreWindowState: input.restoreWindowState,
      onCreated: (webContentsId) => pendingProjects.set(webContentsId, input.pendingProjectPath),
      onClosed: (webContentsId) => pendingProjects.delete(webContentsId),
    });
  };

  const frontWindow = (): OwnedDesktopWindow<TAgentTarget> | undefined => {
    const windows = port.windows().filter((candidate) => !candidate.isDestroyed());
    return port.focusedWindow() ?? windows.find((candidate) => candidate.isVisible()) ?? windows[0];
  };

  const bringToFront = (window: OwnedDesktopWindow<TAgentTarget>): void => {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };

  const owner: DesktopWindowOwner<TAgentTarget> = {
    openPrimary: (input = {}) =>
      open({
        initialRoute: input.initialRoute ?? null,
        pendingProjectPath: input.pendingProjectPath ?? null,
        restoreWindowState: true,
      }),
    openAdditional: (input = {}) =>
      open({
        initialRoute: null,
        pendingProjectPath: input.pendingProjectPath ?? null,
        restoreWindowState: false,
      }),
    async openOrFocusAgent(target) {
      const window = frontWindow();
      if (!window || window.isDestroyed()) {
        if (!agentWindowCreation) {
          agentWindowCreation = owner
            .openPrimary({ initialRoute: port.agentRoute(target) })
            .finally(() => {
              agentWindowCreation = null;
            });
          await agentWindowCreation;
          return;
        }
        await agentWindowCreation;
        await owner.openOrFocusAgent(target);
        return;
      }
      bringToFront(window);
      const deliverable = port.deliverAgent(window.webContentsId, target);
      if (deliverable) window.sendAgent(deliverable);
    },
    async openFromRelaunch({ pendingProjectPath }) {
      if (pendingProjectPath) {
        await owner.openAdditional({ pendingProjectPath });
        return;
      }
      const window = frontWindow();
      if (window && !window.isDestroyed()) {
        bringToFront(window);
        return;
      }
      await owner.openPrimary();
    },
    async restoreWhenActivated() {
      if (port.windows().length === 0) await owner.openPrimary();
    },
    takePendingProject: (webContentsId) => pendingProjects.take(webContentsId),
  };
  return owner;
}
