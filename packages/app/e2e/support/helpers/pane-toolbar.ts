import { expect, type Locator, type Page } from "@playwright/test";

/**
 * The visible pane toolbar is at least 48 px tall and holds each control: no control leaves the bar, the
 * content below starts under it, and a tap just inside the middle of each control edge lands on that control.
 */
export async function expectToolbarContainsTouchControls(
  toolbar: Locator,
  controls: string[],
): Promise<void> {
  const report = await toolbar.evaluate((element, names) => {
    const header = element as HTMLElement;
    const bar = header.getBoundingClientRect();
    const next = header.nextElementSibling?.getBoundingClientRect() ?? null;
    const problems: string[] = [];
    const checkEdge = (control: HTMLElement, name: string, x: number, y: number) => {
      const box = control.getBoundingClientRect();
      const hit = document.elementFromPoint(x, y);
      if (!hit || !control.contains(hit)) {
        const owner = hit?.closest("[data-testid]")?.getAttribute("data-testid") ?? "-";
        const hitBox = hit?.getBoundingClientRect();
        const where = hitBox ? `${hitBox.left},${hitBox.top} ${hitBox.width}x${hitBox.height}` : "";
        problems.push(
          `${name} ${box.left},${box.top}: a tap at ${x},${y} lands on ${hit?.tagName ?? "nothing"} in ${owner} (${where})`,
        );
      }
    };
    for (const name of names) {
      const control =
        header.querySelector<HTMLElement>(`[data-testid="${name}"]`) ??
        header.querySelector<HTMLElement>(`[aria-label="${name}"]`);
      if (!control) {
        problems.push(`${name}: not in the toolbar`);
        continue;
      }
      const box = control.getBoundingClientRect();
      if (box.width < 48 || box.height < 48) problems.push(`${name}: smaller than 48 x 48`);
      if (
        box.left < bar.left - 0.5 ||
        box.right > bar.right + 0.5 ||
        box.top < bar.top - 0.5 ||
        box.bottom > bar.bottom + 0.5
      ) {
        problems.push(`${name}: ${box.top}-${box.bottom} outside the bar ${bar.top}-${bar.bottom}`);
      }
      // The middle of each edge, 1 px inside. Corners are rounded, so a corner tap is not a hit in any browser.
      const inset = 1;
      const midX = box.left + box.width / 2;
      const midY = box.top + box.height / 2;
      const edges: [number, number][] = [
        [box.left + inset, midY],
        [box.right - inset, midY],
        [midX, box.top + inset],
        [midX, box.bottom - inset],
      ];
      for (const [x, y] of edges) {
        checkEdge(control, name, x, y);
      }
    }
    return { barHeight: bar.height, barBottom: bar.bottom, nextTop: next?.top ?? null, problems };
  }, controls);
  expect(report.barHeight).toBeGreaterThanOrEqual(48);
  if (report.nextTop !== null)
    expect(report.nextTop).toBeGreaterThanOrEqual(report.barBottom - 0.5);
  expect(report.problems).toEqual([]);
}

/** Send touch events to each edge, and check the action after each tap. */
export async function tapControlEdges(page: Page, control: Locator, check: () => Promise<void>) {
  for (const edge of ["left", "right", "top", "bottom"] as const) {
    const box = await control.boundingBox();
    if (!box) throw new Error("The toolbar control has no bounds");
    const midX = box.x + box.width / 2;
    const midY = box.y + box.height / 2;
    const points = {
      left: [box.x + 1, midY],
      right: [box.x + box.width - 1, midY],
      top: [midX, box.y + 1],
      bottom: [midX, box.y + box.height - 1],
    } as const;
    const [x, y] = points[edge];
    await page.touchscreen.tap(x, y);
    await check();
  }
}
