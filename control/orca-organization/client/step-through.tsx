// J6 step-through: replay what one session did, turn by turn and step by step. A horizontal scrubber of turns
// (a vertical step list on a phone), the steps of the chosen turn, and a detail panel with what changed and why.
// Stepping: ← → keys on the web, a swipe on the detail panel, dragging along the scrubber, or tapping a step.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  PanResponder,
  Pressable,
  Text,
  TextInput,
  View,
  type LayoutChangeEvent,
} from "react-native";
import { useQuery } from "@tanstack/react-query";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useContract } from "./use-contract";
import { WorkButton } from "./work-button";
import { Details } from "./details";
import { trackersRpc } from "../shared/trackers";
import {
  NEWER_HOST_NEEDED,
  sessionFileHistoryRpc,
  sessionStepRpc,
  sessionTurnsRpc,
  type Step,
  type Turn,
} from "../shared/session-steps";
import { whatItDid } from "./what-it-did";
import { WhatItDidCard } from "./what-it-did-card";
import { FreshStartHistory } from "./fresh-start-view";

type Theme = PluginSurfaceProps["theme"];
export type StepThroughProps = Pick<PluginSurfaceProps, "theme" | "layout" | "host"> & {
  sessionId: string;
  taskId?: string | null;
  title?: string | null;
  taskTitle?: string | null;
  provider?: string | null;
  onClose?: () => void;
  /** Opens on the latest loaded turn and names the view "What it did" (the panel beside a chat). */
  startAtLatest?: boolean;
};
interface Position {
  turn: number;
  step: number;
}
// The plugin compiles without the DOM library; the keyboard listener needs only this much of `document`.
interface KeyEvent {
  key: string;
  target: unknown;
  preventDefault(): void;
}
interface KeySource {
  addEventListener(type: "keydown", listener: (event: KeyEvent) => void): void;
  removeEventListener(type: "keydown", listener: (event: KeyEvent) => void): void;
}
interface LinkedItems {
  items?: { key: string; ref: string; title: string }[];
  links?: { itemKey: string; subject?: { id: string } }[];
}

const providerName = (provider?: string | null) =>
  provider === "claude" ? "Claude" : provider === "codex" ? "Codex" : provider ? provider : "Agent";
const OUTSIDE = "a file outside the project";
const SWIPE = 40;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Moves one step, crossing into the next or previous turn at the ends. */
export function nextPosition(
  position: Position,
  delta: 1 | -1,
  stepCount: number,
  turnCount: number,
): Position | "load-next-turn" | "load-previous-turn" | null {
  const step = position.step + delta;
  if (step >= 0 && step < stepCount) return { turn: position.turn, step };
  if (delta > 0) return position.turn + 1 < turnCount ? "load-next-turn" : null;
  return position.turn > 0 ? "load-previous-turn" : null;
}

function DiffView({ diff, theme }: { diff: string; theme: Theme }) {
  const c = theme.colors;
  return (
    <View
      testID="sessions-diff"
      style={{
        borderWidth: 1,
        borderColor: c.border,
        borderRadius: 10,
        padding: 10,
        backgroundColor: c.surface0,
      }}
    >
      {diff
        .split("\n")
        .slice(0, 400)
        .map((line, i) => {
          const colour =
            line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")
              ? c.foregroundMuted
              : line.startsWith("+")
                ? c.statusSuccess
                : line.startsWith("-")
                  ? c.statusDanger
                  : c.foreground;
          return (
            <Text
              key={i}
              selectable
              style={{ color: colour, fontFamily: "monospace", fontSize: 13 }}
            >
              {line || " "}
            </Text>
          );
        })}
    </View>
  );
}

// U5-D08: when the step was recorded, in the reader's own time zone; nothing when the host did not record a valid time.
export function stepTime(at: string | null | undefined): string | null {
  const date = at ? new Date(at) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function StepDetail({
  step,
  theme,
  turnRef,
  fileRefs,
}: {
  step: Step;
  theme: Theme;
  turnRef: string | null;
  fileRefs: boolean;
}) {
  const c = theme.colors,
    text = { color: c.foreground },
    muted = { color: c.foregroundMuted };
  const outcome =
    step.outcome === "failed"
      ? "Did not succeed"
      : step.outcome === "running"
        ? "Still running when recorded"
        : "Done";
  return (
    <View testID="sessions-step-detail" style={{ gap: 12 }}>
      <Text style={{ ...text, fontSize: 18, fontWeight: "600" }}>{step.summary}</Text>
      {stepTime(step.at) && (
        <Text testID="sessions-step-time" style={muted}>
          Recorded {stepTime(step.at)}
        </Text>
      )}
      <Text style={{ color: step.outcome === "failed" ? c.statusDanger : c.foregroundMuted }}>
        {outcome}
      </Text>
      <View style={{ gap: 4 }}>
        <Text style={{ ...muted, fontSize: 12, fontWeight: "600", letterSpacing: 1 }}>WHY</Text>
        <Text style={text}>{step.why ?? "No reasoning was recorded just before this step."}</Text>
      </View>
      <View style={{ gap: 8 }}>
        <Text style={{ ...muted, fontSize: 12, fontWeight: "600", letterSpacing: 1 }}>
          WHAT CHANGED
        </Text>
        {step.command !== null && (
          <View style={{ gap: 6 }}>
            <Text selectable style={{ ...text, fontFamily: "monospace" }}>
              $ {step.command}
            </Text>
            {step.exitCode !== null && (
              <Text style={{ color: step.exitCode === 0 ? c.statusSuccess : c.statusDanger }}>
                {step.exitCode === 0
                  ? "Finished without errors (exit code 0)"
                  : `Finished with exit code ${step.exitCode}`}
              </Text>
            )}
            {step.output && (
              <Text selectable style={{ ...muted, fontFamily: "monospace", fontSize: 13 }}>
                {step.output}
              </Text>
            )}
          </View>
        )}
        {step.files.map((file, i) => (
          <View key={`${file.path ?? "outside"}-${i}`} style={{ gap: 6 }}>
            <Text style={text}>
              {file.change === "read"
                ? "Read"
                : file.change === "created"
                  ? "Created"
                  : file.change === "deleted"
                    ? "Deleted"
                    : file.change === "written"
                      ? "Wrote"
                      : "Edited"}{" "}
              {file.path ?? OUTSIDE}
            </Text>
            {file.diff ? (
              <DiffView diff={file.diff} theme={theme} />
            ) : (
              file.change !== "read" && (
                <Text style={muted}>
                  {file.path
                    ? "No preview of this change was recorded."
                    : "Changes outside the project are not shown."}
                </Text>
              )
            )}
          </View>
        ))}
        {step.command === null && !step.files.length && (
          <Text style={muted}>This step did not change any files.</Text>
        )}
      </View>
      {(turnRef || fileRefs) && (
        <Details theme={theme}>
          {turnRef && (
            <Text selectable style={muted}>
              Turn: {turnRef}
            </Text>
          )}
          {step.files
            .filter((f) => f.ref)
            .map((f) => (
              <Text key={f.ref!} selectable style={muted}>
                File: {f.ref}
              </Text>
            ))}
        </Details>
      )}
    </View>
  );
}

export function StepThrough(props: StepThroughProps) {
  const { sessionId, theme, layout, host } = props,
    c = theme.colors,
    text = { color: c.foreground },
    muted = { color: c.foregroundMuted };
  const readTurns = useContract(sessionTurnsRpc),
    readStep = useContract(sessionStepRpc),
    readFile = useContract(sessionFileHistoryRpc),
    readTrackers = useContract(trackersRpc);
  const [pages, setPages] = useState<number[]>([0]);
  const [position, setPosition] = useState<Position>({ turn: 0, step: 0 });
  const [pendingEdge, setPendingEdge] = useState<"first" | "last">("first");
  const [onlyChanges, setOnlyChanges] = useState(false);
  const [fileInput, setFileInput] = useState(""),
    [file, setFile] = useState<string | null>(null);

  const turnPages = useQuery({
    queryKey: ["orca-session-turns", host?.id, sessionId, pages],
    queryFn: async () => Promise.all(pages.map((cursor) => readTurns({ sessionId, cursor }))),
    retry: false,
  });
  const first = turnPages.data?.[0];
  const allTurns: Turn[] = useMemo(
    () => (turnPages.data ?? []).flatMap((page) => (page.status === "ok" ? page.turns : [])),
    [turnPages.data],
  );
  const lastPage = turnPages.data?.at(-1);
  const nextCursor = lastPage?.status === "ok" ? lastPage.nextCursor : null;

  const fileHistory = useQuery({
    queryKey: ["orca-session-file", host?.id, sessionId, file],
    queryFn: () => readFile({ sessionId, path: file! }),
    enabled: file !== null,
    retry: false,
  });
  const fileTouches = fileHistory.data?.status === "ok" ? fileHistory.data : null;
  const turns = useMemo(
    () =>
      allTurns.filter(
        (t) =>
          (!onlyChanges || t.changesFiles !== false) &&
          (!fileTouches || fileTouches.touches.some((touch) => touch.turnId === t.turnId)),
      ),
    [allTurns, onlyChanges, fileTouches],
  );
  const turn = turns[Math.min(position.turn, Math.max(turns.length - 1, 0))];
  const jumpedToLatest = useRef(false);
  useEffect(() => {
    if (!props.startAtLatest || jumpedToLatest.current || !turns.length) return;
    jumpedToLatest.current = true;
    setPosition({ turn: turns.length - 1, step: 0 });
  }, [props.startAtLatest, turns.length]);

  const stepQuery = useQuery({
    queryKey: ["orca-session-step", host?.id, sessionId, turn?.turnId],
    queryFn: () => readStep({ sessionId, turnId: turn!.turnId }),
    enabled: !!turn,
    retry: false,
  });
  const detail = stepQuery.data?.status === "ok" ? stepQuery.data : null;
  const steps: Step[] = useMemo(
    () =>
      (detail?.steps ?? []).filter(
        (s) =>
          // L38: in a turn whose changes came through commands, its commands are the file changes the filter can show.
          (!onlyChanges || s.changesFiles || (!!turn?.note && s.kind === "command")) &&
          (!fileTouches || s.files.some((f) => (f.path ?? OUTSIDE) === fileTouches.label)),
      ),
    [detail, onlyChanges, fileTouches, turn?.note],
  );
  const step = steps[Math.min(position.step, Math.max(steps.length - 1, 0))];

  // Crossing into the previous turn lands on its last step once that turn's steps have arrived.
  useEffect(() => {
    if (pendingEdge === "last" && detail && detail.turnId === turn?.turnId) {
      setPosition((p) => ({ ...p, step: Math.max(steps.length - 1, 0) }));
      setPendingEdge("first");
    }
  }, [pendingEdge, detail, turn?.turnId, steps.length]);

  const move = (delta: 1 | -1) => {
    const next = nextPosition(
      {
        turn: Math.min(position.turn, turns.length - 1),
        step: Math.min(position.step, Math.max(steps.length - 1, 0)),
      },
      delta,
      steps.length,
      turns.length,
    );
    if (next === null) return;
    if (next === "load-next-turn") {
      setPosition({ turn: position.turn + 1, step: 0 });
      return;
    }
    if (next === "load-previous-turn") {
      setPendingEdge("last");
      setPosition({ turn: position.turn - 1, step: 0 });
      return;
    }
    setPosition(next);
  };
  const moveRef = useRef(move);
  moveRef.current = move;
  const selectTurn = (index: number) => {
    setPendingEdge("first");
    setPosition({ turn: index, step: 0 });
  };

  // ← → on the web. Typing in the file filter keeps its arrow keys.
  useEffect(() => {
    const source = (globalThis as { document?: KeySource }).document;
    if (layout.platform !== "web" || !source) return;
    const onKey = (event: KeyEvent) => {
      const target = event.target as { tagName?: string } | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
      if (event.key === "ArrowRight") {
        event.preventDefault();
        moveRef.current(1);
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        moveRef.current(-1);
      }
    };
    source.addEventListener("keydown", onKey);
    return () => source.removeEventListener("keydown", onKey);
  }, [layout.platform]);

  // Dragging along the scrubber picks the turn under the finger or pointer.
  const trackWidth = useRef(0),
    turnCount = useRef(0);
  turnCount.current = turns.length;
  const selectRef = useRef(selectTurn);
  selectRef.current = selectTurn;
  const drag = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 8,
        onPanResponderMove: (e, _g) => {
          if (!trackWidth.current || !turnCount.current) return;
          const x = Math.max(0, Math.min(trackWidth.current - 1, e.nativeEvent.locationX));
          selectRef.current(Math.floor((x / trackWidth.current) * turnCount.current));
        },
      }),
    [],
  );
  const swipeStart = useRef<number | null>(null);

  const trackers = useQuery({
    queryKey: ["orca-trackers", host?.id, "session", sessionId, props.taskId],
    queryFn: () => readTrackers({ subjects: [sessionId, ...(props.taskId ? [props.taskId] : [])] }),
    retry: false,
  });
  const trackerView = trackers.data as LinkedItems | undefined;
  // Only items linked to this session or its task, whatever else the read returned.
  const subjects = new Set([sessionId, ...(props.taskId ? [props.taskId] : [])]);
  const linked = (trackerView?.items ?? []).filter((item) =>
    trackerView?.links?.some(
      (link) => link.itemKey === item.key && !!link.subject && subjects.has(link.subject.id),
    ),
  );

  const header = (
    <View testID="sessions-header" style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        {props.onClose && (
          <WorkButton theme={theme} label="Back to the session" onPress={props.onClose}>
            ← Session
          </WorkButton>
        )}
        <Text style={{ ...muted, fontSize: 12, fontWeight: "600", letterSpacing: 1 }}>
          {props.startAtLatest ? "WHAT IT DID" : "STEP THROUGH"} ·{" "}
          {providerName(detail?.provider ?? props.provider).toUpperCase()}
        </Text>
      </View>
      {props.taskTitle && (
        <Text style={{ ...text, fontSize: 22, fontWeight: "600" }}>{props.taskTitle}</Text>
      )}
      {props.title && <Text style={muted}>{props.title}</Text>}
      <Text style={muted}>
        {props.startAtLatest
          ? "What this session did in each turn, in plain words. Step through any turn for the detail."
          : "Replay what this session did, step by step."}
      </Text>
      <FreshStartHistory sessionId={sessionId} theme={theme} hostId={host?.id} />
    </View>
  );

  if (first && first.status !== "ok")
    return (
      <View style={{ gap: 12 }}>
        {header}
        <Text testID="sessions-unavailable" style={{ ...text, fontSize: 16 }}>
          {first.status === "unsupported" ? NEWER_HOST_NEEDED : first.message}
        </Text>
        {first.status === "unsupported" && (
          <Text style={muted}>Update Fulcra on this Mac to replay sessions step by step.</Text>
        )}
      </View>
    );
  if (!first)
    return (
      <View style={{ gap: 12 }}>
        {header}
        <Text style={muted}>
          {turnPages.isError
            ? "This session's history could not be read. Try again."
            : "Reading this session's turns…"}
        </Text>
      </View>
    );

  const compact = layout.compact;
  const turnButton = (t: Turn, index: number) => {
    const selected = t.turnId === turn?.turnId;
    return (
      <Pressable
        key={t.turnId}
        testID={`sessions-turn-${index}`}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        aria-selected={selected}
        accessibilityLabel={`Turn ${t.n + 1}: ${t.summary}`}
        onPress={() => selectTurn(index)}
        style={{
          flexGrow: compact ? 0 : 1,
          flexBasis: compact ? undefined : 0,
          minWidth: compact ? undefined : 32,
          minHeight: 44,
          paddingHorizontal: compact ? 10 : 4,
          paddingVertical: 8,
          justifyContent: "center",
          alignItems: compact ? undefined : "center",
          borderRadius: 10,
          borderWidth: selected ? 2 : 1,
          borderColor: selected ? c.accent : c.border,
          backgroundColor: t.changesFiles ? c.surface2 : c.surface1,
        }}
      >
        <Text
          numberOfLines={compact ? 2 : 1}
          style={{
            color: selected ? c.foreground : c.foregroundMuted,
            fontWeight: selected ? "700" : "500",
          }}
        >
          {/* U5-D08: the desktop track shows the number only (a squeezed "1 · summary" read as "1.."); the selected
            turn's summary and "Turn N of M" are shown in full below the track, and each button keeps it as its label. */}
          {compact ? `Turn ${t.n + 1} · ${t.summary}` : `${t.n + 1}`}
        </Text>
      </Pressable>
    );
  };
  const stepButton = (s: Step, index: number) => {
    const selected = s === step;
    return (
      <Pressable
        key={s.seq}
        testID={`sessions-step-${s.n}`}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        aria-selected={selected}
        accessibilityLabel={`Step ${s.n + 1}: ${s.summary}`}
        onPress={() => setPosition({ turn: position.turn, step: index })}
        style={{
          minHeight: 44,
          paddingHorizontal: 12,
          paddingVertical: 8,
          justifyContent: "center",
          borderRadius: 10,
          borderWidth: selected ? 2 : 1,
          borderColor: selected ? c.accent : s.outcome === "failed" ? c.statusDanger : c.border,
          backgroundColor: selected ? c.surface2 : c.surface1,
        }}
      >
        <Text style={{ color: selected ? c.foreground : c.foregroundMuted }}>{s.summary}</Text>
      </Pressable>
    );
  };

  const filters = (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <WorkButton
          theme={theme}
          label="Only file changes"
          selected={onlyChanges}
          onPress={() => {
            setOnlyChanges(!onlyChanges);
            selectTurn(0);
          }}
        >
          Only file changes
        </WorkButton>
        {file && (
          <WorkButton
            theme={theme}
            label="Show every step"
            onPress={() => {
              setFile(null);
              setFileInput("");
              selectTurn(0);
            }}
          >
            Show every step
          </WorkButton>
        )}
      </View>
      <TextInput
        testID="sessions-file-filter"
        accessibilityLabel="Every change to a file"
        placeholder="Every change to a file, for example src/app.ts"
        value={fileInput}
        onChangeText={setFileInput}
        onSubmitEditing={() => {
          const value = fileInput.trim();
          setFile(value || null);
          selectTurn(0);
        }}
        maxLength={512}
        style={{
          ...text,
          minHeight: 44,
          paddingHorizontal: 12,
          borderWidth: 1,
          borderColor: c.border,
          borderRadius: 12,
          backgroundColor: c.surface1,
        }}
      />
      {!file && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {[...new Set(allTurns.flatMap((t) => t.files))].slice(0, 8).map((path) => (
            <WorkButton
              key={path}
              theme={theme}
              label={`Every change to ${path}`}
              onPress={() => {
                setFileInput(path);
                setFile(path);
                selectTurn(0);
              }}
            >
              {path}
            </WorkButton>
          ))}
        </View>
      )}
      {file && fileTouches && (
        <Text style={muted}>
          {fileTouches.touches.length
            ? `Every change to ${fileTouches.label}: ${plural(fileTouches.touches.filter((t) => t.change !== "read").length, "change")}, ${plural(fileTouches.touches.filter((t) => t.change === "read").length, "read")}.`
            : `This session never touched ${fileTouches.label}.`}
        </Text>
      )}
      {file && fileHistory.data && fileHistory.data.status !== "ok" && (
        <Text style={text}>{fileHistory.data.message}</Text>
      )}
    </View>
  );

  const scrubber = (
    <View
      testID="sessions-scrubber"
      {...(compact ? {} : drag.panHandlers)}
      onLayout={(e: LayoutChangeEvent) => {
        trackWidth.current = e.nativeEvent.layout.width;
      }}
      accessibilityLabel={`${turns.length} turns`}
      style={{ flexDirection: compact ? "column" : "row", gap: 6 }}
    >
      {turns.map((t, i) =>
        compact && t.turnId === turn?.turnId ? (
          <View key={t.turnId} style={{ gap: 6 }}>
            {turnButton(t, i)}
            <View style={{ gap: 6, paddingLeft: 16 }}>{steps.map(stepButton)}</View>
          </View>
        ) : (
          turnButton(t, i)
        ),
      )}
    </View>
  );

  const counter = turn
    ? `Turn ${turn.n + 1} of ${first.status === "ok" ? first.totalTurns : turns.length}${steps.length ? ` · step ${Math.min(position.step, steps.length - 1) + 1} of ${steps.length}` : ""}`
    : "";
  const body = !turns.length ? (
    <Text style={text}>
      {file
        ? "No turn touched that file."
        : onlyChanges
          ? "No turn in this session changed a file."
          : "This session has no recorded turns yet."}
    </Text>
  ) : (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <WorkButton theme={theme} label="Previous step" onPress={() => move(-1)}>
          ← Previous
        </WorkButton>
        <WorkButton theme={theme} label="Next step" onPress={() => move(1)}>
          Next →
        </WorkButton>
        <Text accessibilityLiveRegion="polite" style={muted}>
          {counter}
        </Text>
      </View>
      {detail && (
        <View style={{ gap: 4 }}>
          <Text style={{ ...text, fontWeight: "600" }}>{detail.summary}</Text>
          {detail.asked && <Text style={muted}>Asked: {detail.asked}</Text>}
          {turn?.note && (
            <Text style={muted} testID="sessions-turn-note">
              {turn.note}
            </Text>
          )}
          {detail.truncated && (
            <Text style={muted}>
              This turn is long; the first {detail.steps.length} steps are shown.
            </Text>
          )}
        </View>
      )}
      {detail && turn && detail.turnId === turn.turnId && (
        <WhatItDidCard summary={whatItDid(turn, detail.steps)} theme={theme} />
      )}
      {!compact && steps.length > 0 && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {steps.map(stepButton)}
        </View>
      )}
      <View
        onTouchStart={(e) => {
          swipeStart.current = e.nativeEvent.pageX;
        }}
        onTouchEnd={(e) => {
          const start = swipeStart.current;
          swipeStart.current = null;
          if (start === null) return;
          const dx = e.nativeEvent.pageX - start;
          if (Math.abs(dx) > SWIPE) move(dx < 0 ? 1 : -1);
        }}
        style={{
          padding: 16,
          borderWidth: 1,
          borderColor: c.border,
          borderRadius: 16,
          backgroundColor: c.surface1,
        }}
      >
        {stepQuery.isPending ? (
          <Text style={muted}>Reading this turn…</Text>
        ) : stepQuery.data && stepQuery.data.status !== "ok" ? (
          <Text style={text}>{stepQuery.data.message}</Text>
        ) : step ? (
          <StepDetail
            step={step}
            theme={theme}
            turnRef={detail?.ref ?? null}
            fileRefs={step.files.some((f) => f.ref)}
          />
        ) : (
          <Text style={muted}>
            {detail?.steps.length
              ? "No step in this turn matches the filter."
              : "The agent answered without using any tools in this turn."}
          </Text>
        )}
      </View>
    </View>
  );

  return (
    <View style={{ gap: 16 }}>
      {header}
      {first.status === "ok" && first.retained && (
        <Text style={muted}>
          This session was deleted. Its history was kept, so you can still replay it.
        </Text>
      )}
      {linked.length > 0 && (
        <View style={{ gap: 4 }}>
          <Text style={{ ...muted, fontSize: 12, fontWeight: "600", letterSpacing: 1 }}>
            LINKED WORK ITEMS
          </Text>
          {linked.map((item) => (
            <Text key={item.key} style={text}>
              {item.ref} · {item.title}
            </Text>
          ))}
        </View>
      )}
      {filters}
      {scrubber}
      {nextCursor !== null && (
        <WorkButton
          theme={theme}
          label="Load more turns"
          onPress={() => setPages([...pages, nextCursor])}
        >
          Load more turns
        </WorkButton>
      )}
      {body}
    </View>
  );
}
