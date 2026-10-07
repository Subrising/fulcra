// The "What it did" card: one turn in plain numbered lines, the test result as a badge, raw commands behind a
// toggle. Used in the step-through and, folded, under each turn in the chat (what-it-did-footer.tsx).
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginSurfaceProps, PluginTurnToolCall } from "@getpaseo/plugin/client";
import { WorkButton } from "./work-button";
import { stepsFromToolCalls, whatItDidFromSteps, type WhatItDid } from "./what-it-did";

type Theme = PluginSurfaceProps["theme"];

export function WhatItDidCard({ summary, theme }: { summary: WhatItDid; theme: Theme }) {
  const [raw, setRaw] = useState(false);
  const c = theme.colors,
    text = { color: c.foreground },
    muted = { color: c.foregroundMuted };
  const badge = (label: string, colour: string, testID?: string) => (
    <Text
      testID={testID}
      style={{
        color: colour,
        fontSize: 12,
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 10,
        backgroundColor: c.surface2,
        overflow: "hidden",
      }}
    >
      {label}
    </Text>
  );
  return (
    <View
      testID="sessions-what-it-did"
      style={{
        gap: 8,
        padding: 14,
        borderWidth: 1,
        borderColor: c.border,
        borderRadius: 14,
        backgroundColor: c.surface1,
      }}
    >
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <Text style={{ ...text, fontWeight: "700" }}>What it did</Text>
        {badge(summary.size, c.foregroundMuted)}
        {summary.tests &&
          badge(
            summary.tests === "passed" ? "Tests passed" : "Tests failed",
            summary.tests === "passed" ? c.statusSuccess : c.statusDanger,
            "sessions-what-it-did-tests",
          )}
      </View>
      {summary.lines.length ? (
        summary.lines.map((line, i) => (
          <Text
            key={i}
            testID="sessions-what-it-did-line"
            style={{ color: line.failed ? c.statusDanger : c.foreground }}
          >
            {`${i + 1}. ${line.text}`}
          </Text>
        ))
      ) : (
        <Text style={muted}>Answered without using any tools.</Text>
      )}
      {summary.commands.length > 0 && (
        <View style={{ flexDirection: "row" }}>
          <WorkButton
            theme={theme}
            label={raw ? "Hide raw commands" : "Show raw commands"}
            selected={raw}
            onPress={() => setRaw(!raw)}
          >
            {raw ? "Hide raw commands" : "Show raw commands"}
          </WorkButton>
        </View>
      )}
      {raw &&
        summary.commands.map((command, i) => (
          <Text
            key={i}
            selectable
            testID="sessions-what-it-did-command"
            style={{ ...muted, fontFamily: "monospace", fontSize: 13 }}
          >
            $ {command}
          </Text>
        ))}
    </View>
  );
}

/** Under a turn in the chat: one quiet line that opens into the card. Nothing for a turn without tools. */
export function WhatItDidFooterView({
  toolCalls,
  durationMs,
  cwd,
  theme,
}: {
  toolCalls: readonly PluginTurnToolCall[];
  durationMs: number | null;
  cwd: string | null;
  theme: Theme;
}) {
  const [open, setOpen] = useState(false);
  if (!toolCalls.length) return null;
  const summary = whatItDidFromSteps(
    stepsFromToolCalls(toolCalls, cwd),
    durationMs === null ? null : Math.round(durationMs / 1000),
    null,
  );
  const c = theme.colors;
  const tests =
    summary.tests === "passed"
      ? " · Tests passed"
      : summary.tests === "failed"
        ? " · Tests failed"
        : "";
  return (
    <View testID="chat-what-it-did" style={{ gap: 8, paddingBottom: 8 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={open ? "Hide what it did" : "Show what it did"}
        onPress={() => setOpen(!open)}
      >
        <Text
          style={{
            color: summary.tests === "failed" ? c.statusDanger : c.foregroundMuted,
            fontSize: 13,
          }}
        >
          {`${open ? "▾" : "▸"} What it did · ${summary.size}${tests}`}
        </Text>
      </Pressable>
      {open && <WhatItDidCard summary={summary} theme={theme} />}
    </View>
  );
}
