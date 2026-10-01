import { afterEach, describe, expect, it } from "vitest";
import createDOMPurify from "dompurify";
import mermaid from "mermaid";
import { mermaidRuntimeHtml } from "./html.gen";
import { parseMermaidRuntimeMessage, type MermaidRuntimeMessage } from "./messages";

const mountedFrames: HTMLIFrameElement[] = [];

function waitForRuntimeMessage(
  frame: HTMLIFrameElement,
  predicate: (message: MermaidRuntimeMessage) => boolean,
): Promise<MermaidRuntimeMessage> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener("message", receive);
      reject(new Error("Timed out waiting for Mermaid runtime"));
    }, 10_000);
    function receive(event: MessageEvent): void {
      if (event.source !== frame.contentWindow) {
        return;
      }
      const message = parseMermaidRuntimeMessage(event.data);
      if (!message || !predicate(message)) {
        return;
      }
      window.clearTimeout(timeout);
      window.removeEventListener("message", receive);
      resolve(message);
    }
    window.addEventListener("message", receive);
  });
}

async function mountRuntime(size?: { width: number; height: number }): Promise<HTMLIFrameElement> {
  const frame = document.createElement("iframe");
  frame.sandbox.add("allow-scripts");
  if (size) {
    frame.style.width = `${size.width}px`;
    frame.style.height = `${size.height}px`;
  }
  const ready = waitForRuntimeMessage(frame, (message) => message.type === "bridgeReady");
  frame.srcdoc = mermaidRuntimeHtml;
  document.body.append(frame);
  mountedFrames.push(frame);
  await ready;
  return frame;
}

function renderedSize(message: MermaidRuntimeMessage): { height: number; width: number } {
  if (message.type !== "rendered") {
    throw new Error(`Expected a rendered diagram, got ${message.type}`);
  }
  return { height: message.height, width: message.width };
}

function render(
  frame: HTMLIFrameElement,
  input: { revision: number; source: string; colorScheme?: "light" | "dark" },
): Promise<MermaidRuntimeMessage> {
  const response = waitForRuntimeMessage(
    frame,
    (message) =>
      message.type !== "bridgeReady" &&
      "revision" in message &&
      message.revision === input.revision,
  );
  frame.contentWindow?.postMessage(
    {
      type: "render",
      revision: input.revision,
      source: input.source,
      colorScheme: input.colorScheme ?? "dark",
      interactive: false,
    },
    "*",
  );
  return response;
}

afterEach(() => {
  for (const frame of mountedFrames.splice(0)) {
    frame.remove();
  }
});

describe("Mermaid sandbox runtime", () => {
  it("keeps YAML merge tags disabled and renders after rejected frontmatter", async () => {
    const frame = await mountRuntime();
    const ordinary = "---\ntitle: Orca delivery\n---\nflowchart LR\nPlan --> Review";
    const implicit =
      "---\ntitle: Literal merge key\nbase: &base {title: Replaced}\n<<: *base\n---\nflowchart LR\nPlan --> Review";
    const explicit =
      '---\nbase: &base {title: Replaced}\n!!merge "<<": *base\n---\nflowchart LR\nPlan --> Review';

    expect(await render(frame, { revision: 1, source: ordinary })).toMatchObject({
      type: "rendered",
      revision: 1,
      source: ordinary,
    });
    expect(await render(frame, { revision: 2, source: implicit })).toMatchObject({
      type: "rendered",
      revision: 2,
      source: implicit,
    });
    expect(await render(frame, { revision: 3, source: explicit })).toEqual({
      type: "renderError",
      revision: 3,
    });
    expect(await render(frame, { revision: 4, source: ordinary })).toMatchObject({
      type: "rendered",
      revision: 4,
      source: ordinary,
    });
  });

  it("de-arms detached descendants removed by sanitizer hooks", () => {
    for (const hook of ["beforeSanitizeElements", "uponSanitizeElement"] as const) {
      const purifier = createDOMPurify(window);
      const root = document.createElement("div");
      root.innerHTML = '<footer><img onload="void 0"></footer><div>safe</div>';
      const image = root.querySelector("img")!;
      const removeFooter = (node: Node) => {
        if (node.nodeName === "FOOTER") node.parentNode?.removeChild(node);
      };
      if (hook === "beforeSanitizeElements") purifier.addHook(hook, removeFooter);
      else purifier.addHook(hook, removeFooter);
      purifier.sanitize(root, { IN_PLACE: true, ALLOWED_TAGS: ["div", "footer", "#text"] });
      expect(root.innerHTML).toBe("<div>safe</div>");
      expect(image.getAttribute("onload")).toBeNull();
    }
  });

  it("does not let configuration merge mutate the object prototype", () => {
    const prototype = Object.prototype as Record<string, unknown>;
    try {
      mermaid.initialize(JSON.parse('{"__proto__":{"orcaDiagramPolluted":"yes"}}'));
      expect(prototype.orcaDiagramPolluted).toBeUndefined();
    } finally {
      delete prototype.orcaDiagramPolluted;
    }
  });

  it("renders the same diagram after light, dark and light changes", async () => {
    const frame = await mountRuntime();
    const source = "flowchart LR\nA[Plan] --> B[Review] --> C[Ship]";
    let revision = 1;
    for (const colorScheme of ["light", "dark", "light"] as const) {
      const result = await render(frame, { revision, source, colorScheme });
      expect(result).toMatchObject({ type: "rendered", revision, source, colorScheme });
      expect(renderedSize(result).width).toBeGreaterThan(0);
      expect(renderedSize(result).height).toBeGreaterThan(0);
      revision++;
    }
  });

  it("renders successive valid streaming prefixes and reports an invalid prefix", async () => {
    const frame = await mountRuntime();
    const firstSource = "flowchart TD\nA --> B";
    const secondSource = `${firstSource}\nB --> C`;

    const first = await render(frame, { revision: 1, source: firstSource });
    const invalid = await render(frame, { revision: 2, source: "not a mermaid diagram" });
    const second = await render(frame, { revision: 3, source: secondSource });

    expect(first).toMatchObject({ type: "rendered", revision: 1, source: firstSource });
    expect(invalid).toEqual({ type: "renderError", revision: 2 });
    expect(second).toMatchObject({ type: "rendered", revision: 3, source: secondSource });
  });

  /**
   * The host sizes this frame from the reported size, so a size that depends on the frame feeds
   * back: every re-render measures inside a frame the previous measurement already shrank by the
   * container's padding, and a streaming diagram ratchets down to a few pixels.
   */
  it("reports the same size whatever frame the host gives it", async () => {
    const source = "flowchart TD\nA[Start] --> B[Middle]\nB --> C[Ship]";
    const narrowFrame = await mountRuntime({ height: 60, width: 60 });
    const wideFrame = await mountRuntime({ height: 600, width: 900 });

    const narrow = await render(narrowFrame, { revision: 1, source });
    const wide = await render(wideFrame, { revision: 1, source });

    expect(renderedSize(narrow)).toEqual(renderedSize(wide));
  });

  it("coalesces queued input and never reports an obsolete result", async () => {
    const frame = await mountRuntime();
    const obsoleteSource = `flowchart TD\n${Array.from({ length: 250 }, (_, index) => `A${index} --> A${index + 1}`).join("\n")}`;
    const currentSource = "flowchart TD\nCurrent --> Result";
    const obsoleteResponses: MermaidRuntimeMessage[] = [];
    function collect(event: MessageEvent): void {
      if (event.source !== frame.contentWindow) {
        return;
      }
      const message = parseMermaidRuntimeMessage(event.data);
      if (message && message.type !== "bridgeReady" && message.revision === 10) {
        obsoleteResponses.push(message);
      }
    }
    window.addEventListener("message", collect);
    frame.contentWindow?.postMessage(
      {
        type: "render",
        revision: 10,
        source: obsoleteSource,
        colorScheme: "dark",
        interactive: false,
      },
      "*",
    );
    const current = await render(frame, { revision: 11, source: currentSource });
    window.removeEventListener("message", collect);

    expect(current).toMatchObject({ type: "rendered", revision: 11, source: currentSource });
    expect(obsoleteResponses).toEqual([]);
  });
});
