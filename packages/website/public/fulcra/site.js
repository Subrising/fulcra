import { acceptedFrames } from "./capture-policy.js";
let manifest = null;
try {
  const response = await fetch(new URL("./captures.json", import.meta.url), { cache: "no-store" });
  if (response.ok) manifest = await response.json();
} catch {
  // Keep the page and editorial workflow usable; never invent substitute product imagery.
}

const frames = acceptedFrames(manifest);
const pending = document.querySelector("[data-capture-pending]");
const figure = document.querySelector("[data-capture]");
const image = document.createElement("img");
image.loading = "eager";
const caption = document.querySelector("[data-capture-caption]");
const controls = document.querySelector("[data-capture-controls]");
const tabs = document.querySelector("[data-capture-tabs]");
const dialog = document.querySelector("[data-capture-dialog]");
let selectedFrame = null;

function selectFrame(frame) {
  selectedFrame = frame;
  image.src = `${frame.src}?v=${frame.sha256}`;
  image.alt = frame.alt;
  image.width = frame.width;
  image.height = frame.height;
  image.dataset.kind = frame.kind ?? "desktop-app";
  caption.textContent = frame.caption;
  for (const button of tabs.querySelectorAll("button"))
    button.setAttribute("aria-pressed", String(button.dataset.frameId === frame.id));
}
if (frames.length > 0) {
  pending.hidden = true;
  figure.prepend(image);
  figure.hidden = false;
  controls.hidden = false;
  for (const frame of frames) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.frameId = frame.id;
    button.textContent = frame.title;
    button.addEventListener("click", () => selectFrame(frame));
    tabs.append(button);
  }
  selectFrame(frames[0]);
}
document.querySelector("[data-enlarge]").addEventListener("click", () => {
  if (!selectedFrame) return;
  const fullImage = document.createElement("img");
  document.querySelector("[data-dialog-content]").replaceChildren(fullImage);
  fullImage.src = `${selectedFrame.src}?v=${selectedFrame.sha256}`;
  fullImage.alt = selectedFrame.alt;
  document.querySelector("[data-dialog-caption]").textContent = selectedFrame.caption;
  dialog.showModal();
});
document.querySelector("[data-close-dialog]").addEventListener("click", () => dialog.close());

image.addEventListener("error", () => {
  figure.hidden = true;
  controls.hidden = true;
  pending.hidden = false;
  pending.querySelector("p").textContent = "The real product capture could not be loaded.";
  pending.querySelector("span").hidden = false;
  pending.querySelector("span").textContent = "Please reload this page to retry.";
});

const chapters = {
  organise: {
    title: "Set the direction. Let primes coordinate.",
    copy: "Give your primes the outcomes and priorities. A prime coordinates its project leads, connects work across projects and brings the decisions that need you back up.",
    key: "You → primes → project orchestrators",
    detail:
      "One prime can lead several projects; several primes can have different remits. You keep the high-level direction instead of managing every working session.",
  },
  delegate: {
    title: "Each project has its own coordination.",
    copy: "The workspace or project orchestrator turns direction into local work: a project board, tasks, responsibilities and communication. It guides its sessions and keeps the project’s discussion attached to the work.",
    key: "Project lead → board + responsibilities + comms",
    detail:
      "The current source scopes task records and working sessions to configured projects. It does not turn every folder into an autonomous project leader or create its channels automatically.",
  },
  follow: {
    title: "Working sessions do the work.",
    copy: "The project lead briefs persistent sessions, follows their progress and gathers their outputs. Each session keeps its conversation and execution context, so the work can continue without a new chat for every revision.",
    key: "Project orchestrator → working sessions → outputs",
    detail:
      "Claude and Codex sessions remain connected to the project and host where the work runs. Project-level coordination stays with the lead.",
  },
  continue: {
    title: "Get the decisions, not all the chatter.",
    copy: "Project leads publish what is happening, what comes next, what needs you and where the risks are. Prime↔project messages carry coordination back and forth; primes bring the important decisions and updates to you.",
    key: "Sessions → project leads → primes → you",
    detail:
      "Project briefs and the decision inbox are implemented. Role communication uses explicitly configured routes; a daily summary is not a promise that every conversation is automatically coordinated.",
  },
};
const chapterButtons = [...document.querySelectorAll("[data-story]")];
function selectChapter(id, moveFocus = false) {
  const chapter = chapters[id];
  if (!chapter) return;
  document.querySelector("[data-story-title]").textContent = chapter.title;
  document.querySelector("[data-story-copy]").textContent = chapter.copy;
  document.querySelector("[data-story-key]").textContent = chapter.key;
  document.querySelector("[data-story-detail]").textContent = chapter.detail;
  document.querySelector("#story-panel").setAttribute("aria-labelledby", `tab-${id}`);
  for (const button of chapterButtons) {
    const selected = button.dataset.story === id;
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
    if (selected && moveFocus) button.focus();
  }
  const realFrame = frames.find((frame) => frame.chapter === id);
  if (realFrame) selectFrame(realFrame);
}
for (const [index, button] of chapterButtons.entries()) {
  button.addEventListener("click", () => selectChapter(button.dataset.story));
  button.addEventListener("keydown", (event) => {
    let next = index;
    if (event.key === "ArrowRight" || event.key === "ArrowDown")
      next = (index + 1) % chapterButtons.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp")
      next = (index + chapterButtons.length - 1) % chapterButtons.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = chapterButtons.length - 1;
    else return;
    event.preventDefault();
    selectChapter(chapterButtons[next].dataset.story, true);
  });
}
selectChapter("organise");
