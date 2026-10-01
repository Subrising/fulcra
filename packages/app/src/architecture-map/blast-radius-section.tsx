import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { ArchitectureChangeImpact } from "@getpaseo/protocol/messages";
import { plainSummary, type ReadyChange } from "./generated-change";

// The blast radius of a change drawn from its code: a few plain sentences, the headline numbers, the parts it
// edits, the parts that depend on it and every changed file with the tests that reach it.

const K = "panels.architectureMap.change.generated";
const FIRST_FILES = 12;
const FIRST_PARTS = 8;
const STATUS_KEY = {
  added: "fileAdded",
  modified: "fileModified",
  deleted: "fileDeleted",
} as const;

export function BlastRadiusSection(props: {
  change: ReadyChange;
  impact: ArchitectureChangeImpact;
  provenance: string;
}) {
  const { t } = useTranslation();
  const { change, impact } = props;
  const [allFiles, setAllFiles] = useState(false);
  const showAll = useCallback(() => setAllFiles(true), []);
  const sentences = useMemo(() => plainSummary(t, change, impact), [t, change, impact]);
  const files = allFiles ? impact.files : impact.files.slice(0, FIRST_FILES);
  const uncovered = impact.coverage.code - impact.coverage.covered;
  return (
    <View style={styles.root} testID="architecture-change-impact">
      <View style={styles.card}>
        <Text style={styles.cardTitle}>{t(`${K}.plainTitle`)}</Text>
        {sentences.map((line) => (
          <Text key={line} style={styles.body}>
            {line}
          </Text>
        ))}
        <Text style={styles.muted}>{props.provenance}</Text>
      </View>

      <Text style={styles.heading}>{t(`${K}.impactTitle`)}</Text>
      <View style={styles.stats}>
        <Stat label={t(`${K}.statFiles`)} value={String(impact.counts.files)} />
        <Stat label={t(`${K}.statParts`)} value={String(impact.parts.length)} />
        <Stat label={t(`${K}.statDirect`)} value={String(impact.dependents.direct ?? 0)} />
        <Stat label={t(`${K}.statReach`)} value={String(impact.dependents.files)} />
        <Stat
          label={t(`${K}.statTests`)}
          value={t(`${K}.statTestsValue`, {
            covered: impact.coverage.covered,
            code: impact.coverage.code,
          })}
          warn={uncovered > 0}
        />
      </View>

      <View style={styles.columns}>
        <View style={styles.column}>
          <Text style={styles.sectionTitle}>{t(`${K}.editedTitle`)}</Text>
          {impact.parts.map((part) => (
            <View key={part.id} style={styles.row}>
              <Text style={styles.rowLabel} numberOfLines={1}>
                {part.label}
              </Text>
              <Text style={styles.muted}>
                {t(`${K}.editedCounts`, {
                  added: part.added,
                  modified: part.modified,
                  deleted: part.deleted,
                })}
              </Text>
            </View>
          ))}
        </View>
        <View style={styles.column}>
          <Text style={styles.sectionTitle}>{t(`${K}.reachTitle`)}</Text>
          {impact.dependents.parts.slice(0, FIRST_PARTS).map((part) => (
            <View key={part.id} style={styles.row}>
              <Text style={styles.rowLabel} numberOfLines={1}>
                {part.label}
              </Text>
              <Text style={styles.muted}>{t(`${K}.reachFiles`, { count: part.files })}</Text>
            </View>
          ))}
        </View>
      </View>

      <View style={styles.section} testID="architecture-change-files">
        <Text style={styles.sectionTitle}>{t(`${K}.filesTitle`)}</Text>
        {files.map((file) => (
          <View key={file.path} style={styles.file}>
            <View style={styles.fileHead}>
              <Text style={[styles.badge, badgeStyle(file.status)]}>
                {t(`${K}.${STATUS_KEY[file.status]}`)}
              </Text>
              <Text style={styles.path} numberOfLines={2}>
                {file.path}
              </Text>
            </View>
            {file.kind === "code" && file.status !== "deleted" ? (
              <Text style={file.tests > 0 ? styles.muted : styles.warn}>
                {file.tests > 0
                  ? t(`${K}.fileTests`, {
                      count: file.tests,
                      nearest: file.nearestTests
                        .map((test) => test.slice(test.lastIndexOf("/") + 1))
                        .join(", "),
                    })
                  : t(`${K}.fileNoTests`)}
              </Text>
            ) : (
              <Text style={styles.muted}>
                {file.kind === "test" ? t(`${K}.kindTest`) : t(`${K}.kindOther`)}
              </Text>
            )}
          </View>
        ))}
        {!allFiles && impact.files.length > FIRST_FILES ? (
          <Pressable accessibilityRole="button" onPress={showAll} style={styles.more}>
            <Text style={styles.moreText}>
              {t(`${K}.showAllFiles`, { count: impact.files.length })}
            </Text>
          </Pressable>
        ) : null}
        {impact.filesTruncated ? (
          <Text style={styles.muted}>{t(`${K}.filesCut`, { count: impact.files.length })}</Text>
        ) : null}
      </View>
    </View>
  );
}

function Stat(props: { label: string; value: string; warn?: boolean }) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, props.warn ? styles.warnText : null]}>{props.value}</Text>
      <Text style={styles.statLabel}>{props.label}</Text>
    </View>
  );
}

function badgeStyle(status: "added" | "modified" | "deleted") {
  if (status === "added") return styles.badgeAdded;
  if (status === "deleted") return styles.badgeDeleted;
  return styles.badgeChanged;
}

const styles = StyleSheet.create((theme) => ({
  root: { gap: theme.spacing[3] },
  card: {
    gap: theme.spacing[1],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  cardTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  heading: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  body: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  warn: { color: theme.colors.statusWarning, fontSize: theme.fontSize.sm },
  warnText: { color: theme.colors.statusWarning },
  stats: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  stat: {
    minWidth: 120,
    flexGrow: 1,
    gap: theme.spacing[0.5],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
  },
  statValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
  },
  statLabel: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  columns: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[3] },
  column: { flexGrow: 1, flexBasis: 280, gap: theme.spacing[1] },
  section: { gap: theme.spacing[1] },
  sectionTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  rowLabel: { flexShrink: 1, color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  file: {
    gap: theme.spacing[0.5],
    paddingVertical: theme.spacing[1.5],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  fileHead: { flexDirection: "row", alignItems: "flex-start", gap: theme.spacing[2] },
  badge: {
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[1.5],
    borderRadius: theme.borderRadius.sm,
    overflow: "hidden",
    color: theme.colors.foreground,
  },
  badgeAdded: { backgroundColor: theme.colors.statusSuccess },
  badgeDeleted: { backgroundColor: theme.colors.statusDanger },
  badgeChanged: { backgroundColor: theme.colors.statusWarning },
  path: { flexShrink: 1, color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  more: {
    alignSelf: "flex-start",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  moreText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
}));
