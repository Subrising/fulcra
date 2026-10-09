import Foundation

// Fulcra 0.2.8: Apple's on-device recognizer restarts its transcription during long audio (after about 30 s, or after
// a pause). A result then holds only the newest part, and keeping only the latest result lost everything before it:
// a 45 s message arrived as its last 20 s. This keeps every finished part. Pure value logic, so it is tested without
// a device (swift-tests/transcript/main.swift).
struct TranscriptAccumulator {
    /// One recognizer result: its text and the time span of its first and last segments, in seconds from the start
    /// of the audio. Partial results often report 0 for both; the text then decides.
    struct Result {
        var text: String
        var firstStart: TimeInterval
        var lastEnd: TimeInterval
    }

    private(set) var committed = ""
    private var current: Result?

    /// Everything heard so far: the finished parts, then the part in progress.
    var text: String { join(committed, current?.text ?? "") }

    /// Takes the newest result and returns the whole transcript. `stopping`: the person tapped stop and this is the
    /// answer to the end of the audio.
    mutating func update(_ result: Result, isFinal: Bool, stopping: Bool = false) -> String {
        var shown = current
        if let previous = current, restarted(from: previous, to: result) {
            commit(previous.text)
            shown = nil
        }
        current = result
        if isFinal {
            // At the stop the final result can lose the last words the person saw in the partial: the audio ended in
            // the middle of them. When the final is the partial with its end cut off, keep the partial.
            if stopping, let shown = shown, endCut(final: result.text, partial: shown.text) {
                commit(shown.text)
            } else {
                commit(result.text)
            }
            current = nil
        }
        return text
    }

    /// The recognizer task ended on its own; keep its last text before a new task starts.
    mutating func taskEnded() {
        if let previous = current { commit(previous.text) }
        current = nil
    }

    private mutating func commit(_ part: String) {
        committed = join(committed, part)
    }

    private func restarted(from previous: Result, to next: Result) -> Bool {
        let before = words(previous.text), after = words(next.text)
        if before.isEmpty || after.isEmpty { return false }
        let timed = previous.lastEnd > 0 && next.firstStart > 0
        if timed {
            // A new utterance starts after the previous one ended, or the clock went back to the start.
            if next.firstStart >= previous.lastEnd - 0.05 { return true }
            if next.firstStart + 1.0 < previous.firstStart { return true }
            return false
        }
        // Untimed partials: a revision keeps the opening words. A restart begins with other words and is shorter.
        return before.count >= 3 && before[0] != after[0] && after.count < before.count
    }

    /// True when the final has fewer words than the partial and they are the partial's first words.
    private func endCut(final: String, partial: String) -> Bool {
        let kept = words(final), seen = words(partial)
        return !kept.isEmpty && kept.count < seen.count && Array(seen.prefix(kept.count)) == kept
    }

    private func words(_ text: String) -> [String] {
        text.lowercased().split(whereSeparator: { $0.isWhitespace || $0.isPunctuation }).map(String.init)
    }

    private func join(_ a: String, _ b: String) -> String {
        let left = a.trimmingCharacters(in: .whitespacesAndNewlines)
        let right = b.trimmingCharacters(in: .whitespacesAndNewlines)
        if left.isEmpty { return right }
        if right.isEmpty { return left }
        return "\(left) \(right)"
    }
}

/// How many times one dictation may restart the recognizer. Past the limit the rest of the audio is not transcribed,
/// so the dictation is marked truncated.
struct RestartBudget {
    let limit: Int
    private(set) var used = 0
    private(set) var exhausted = false

    /// Count one restart. False when the limit is passed: do not restart, the transcript is now short.
    mutating func spend() -> Bool {
        used += 1
        if used > limit { exhausted = true }
        return !exhausted
    }
}

/// How a dictation ends. A transcript that is empty after a failure, or that stopped before the audio did, is
/// rejected, so the app sends the recorded audio to the host instead of a short message.
enum DictationOutcome: Equatable {
    case text(String)
    case reject(code: String, message: String)

    static func decide(text: String, failed: Bool, truncated: Bool) -> DictationOutcome {
        if truncated {
            return .reject(code: "ON_DEVICE_SPEECH_TRUNCATED",
                           message: "On-device transcription stopped before the audio ended; recorded audio is retained")
        }
        if text.isEmpty && failed {
            return .reject(code: "ON_DEVICE_SPEECH_UNAVAILABLE",
                           message: "On-device transcription unavailable; recorded audio is retained")
        }
        return .text(text)
    }
}
