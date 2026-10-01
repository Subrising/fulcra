import { z } from "zod";
import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  ToolCallTimelineItem,
} from "../../agent-sdk-types.js";

const QuestionSchema = z.object({
  title: z.string().trim().min(1),
  options: z.array(z.string().min(1)).nullish(),
});
const ItemSchema = z.object({
  type: z.literal("agentMessage"),
  id: z.string().min(1),
  delivery: z.literal("async"),
  questions: z.array(QuestionSchema).min(1),
});
const RecordSchema = z.object({
  item: ItemSchema,
  resolution: z.union([z.literal("dismissed"), z.array(z.string())]).optional(),
});
type QuestionRecord = z.infer<typeof RecordSchema>;

function requestId(itemId: string): string {
  return `permission-${itemId}`;
}

function toPermission(record: QuestionRecord): AgentPermissionRequest {
  return {
    id: requestId(record.item.id),
    provider: "codex",
    name: "request_user_input_async",
    kind: "question",
    title: "Question",
    input: {
      questions: record.item.questions.map((question, index) => ({
        id: String(index),
        header: `Question ${index + 1}`,
        question: question.title,
        options: (question.options ?? []).map((label) => ({ label })),
        isOther: true,
      })),
    },
  };
}

function toTimeline(record: QuestionRecord): ToolCallTimelineItem {
  const answers = Array.isArray(record.resolution) ? record.resolution : undefined;
  return {
    type: "tool_call",
    callId: record.item.id,
    name: "request_user_input_async",
    status: "completed",
    error: null,
    detail: {
      type: "plain_text",
      icon: "brain",
      text:
        record.item.questions
          .map((question, index) =>
            [question.title, answers ? answers[index] : (question.options ?? []).join(", ")]
              .filter(Boolean)
              .join("\n"),
          )
          .join("\n\n") + (record.resolution === "dismissed" ? "\n\nDismissed" : ""),
    },
  };
}

export function codexAsyncQuestionToTimeline(item: unknown): ToolCallTimelineItem | null {
  const parsed = ItemSchema.safeParse(item);
  return parsed.success ? toTimeline({ item: parsed.data }) : null;
}

const MAX_ANSWER_LENGTH = 16384;

/**
 * L54: the answers callers really send, read strictly. The app's question form (and the Command Centre controller)
 * key answers by header ("Question 1"); an agent answering through respond_to_permission tends to key them by the
 * question text (as Claude's AskUserQuestion accepts) or send them in order. A multi-select answer may be a list of
 * labels. Every question needs a non-empty string answer; anything else is refused with a plain message, never a
 * schema error, and the question stays pending.
 */
function readAnswers(record: QuestionRecord, answers: unknown): string[] {
  const keyed =
    answers !== null && typeof answers === "object" && !Array.isArray(answers)
      ? (answers as Record<string, unknown>)
      : null;
  if (!keyed && !Array.isArray(answers)) throw new Error("Answer the question, or dismiss it");
  return record.item.questions.map((question, index) => {
    const raw = Array.isArray(answers)
      ? answers[index]
      : (keyed![`Question ${index + 1}`] ?? keyed![question.title] ?? keyed![String(index)]);
    const text = answerText(raw);
    if (!text) throw new Error(`Answer Question ${index + 1} before submitting`);
    if (text.length > MAX_ANSWER_LENGTH)
      throw new Error(`Answer Question ${index + 1} is too long`);
    return text;
  });
}

function answerText(raw: unknown): string | null {
  if (typeof raw === "string") return raw.trim() || null;
  const labels = z.array(z.string()).safeParse(raw);
  if (!labels.success) return null;
  return (
    labels.data
      .map((label) => label.trim())
      .filter(Boolean)
      .join(", ") || null
  );
}

/** Codex emits these as completed messages; the outstanding answer belongs to the session. */
export class CodexAsyncQuestions {
  private readonly records = new Map<string, QuestionRecord>();

  constructor(saved: unknown) {
    const parsed = z.array(RecordSchema).safeParse(saved);
    if (parsed.success) {
      for (const record of parsed.data) this.records.set(requestId(record.item.id), record);
    }
  }

  receive(item: unknown): AgentPermissionRequest | null {
    const parsed = ItemSchema.safeParse(item);
    if (!parsed.success || this.records.has(requestId(parsed.data.id))) return null;
    const record = { item: parsed.data };
    this.records.set(requestId(parsed.data.id), record);
    return toPermission(record);
  }

  pending(): AgentPermissionRequest[] {
    return Array.from(this.records.values())
      .filter((record) => record.resolution === undefined)
      .map(toPermission);
  }

  hasPending(id: string): boolean {
    const record = this.records.get(id);
    return record !== undefined && record.resolution === undefined;
  }

  prepareResponse(
    id: string,
    response: AgentPermissionResponse,
  ): { prompt?: string; complete: () => ToolCallTimelineItem } {
    const record = this.records.get(id);
    if (!record || record.resolution !== undefined)
      throw new Error("Question is no longer pending");
    let resolution: QuestionRecord["resolution"] = "dismissed";
    let prompt: string | undefined;
    if (response.behavior === "allow") {
      resolution = readAnswers(record, response.updatedInput?.answers);
      const values = resolution;
      prompt =
        "Answers to your questions:\n\n" +
        record.item.questions
          .map((question, index) => `${question.title}\n${values[index]}`)
          .join("\n\n");
    }
    return {
      prompt,
      complete: () => {
        record.resolution = resolution;
        return toTimeline(record);
      },
    };
  }

  timeline(itemId: string): ToolCallTimelineItem | null {
    const record = this.records.get(requestId(itemId));
    return record ? toTimeline(record) : null;
  }

  retain(itemIds: ReadonlySet<string>): string[] {
    const removedPendingIds: string[] = [];
    for (const [id, record] of this.records) {
      if (itemIds.has(record.item.id)) continue;
      this.records.delete(id);
      if (record.resolution === undefined) removedPendingIds.push(id);
    }
    return removedPendingIds;
  }

  serialize(): unknown {
    return Array.from(this.records.values());
  }
}
