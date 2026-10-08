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

    /// Takes the newest result and returns the whole transcript.
    mutating func update(_ result: Result, isFinal: Bool) -> String {
        if let previous = current, restarted(from: previous, to: result) { commit(previous.text) }
        current = result
        if isFinal {
            commit(result.text)
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
