// Fulcra 0.2.8: the on-device recognizer restarts during long audio. These cases replay the results it gives and check
// that every word said is kept. Run: npm run test:swift --workspace=@getpaseo/expo-two-way-audio (macOS only).
import Foundation

var failures = 0
func check(_ name: String, _ actual: String, _ expected: String) {
    if actual == expected { print("ok - \(name)") } else {
        failures += 1
        print("not ok - \(name)\n  expected: \(expected)\n  actual:   \(actual)")
    }
}
typealias R = TranscriptAccumulator.Result
let numbers = (1...60).map { ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
    "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"][($0 - 1) % 20] }

// 1. A 60 s count. Partials grow word by word with timestamps; the recognizer restarts every 20 words (about 20 s),
//    and each new result holds only the words since the restart.
do {
    var t = TranscriptAccumulator()
    var last = ""
    for block in 0..<3 {
        for n in 1...20 {
            let words = numbers[(block * 20)..<(block * 20 + n)].joined(separator: " ")
            let start = Double(block * 20) + 0.2
            last = t.update(R(text: words, firstStart: start, lastEnd: start + Double(n)), isFinal: false)
        }
    }
    check("timed restarts every 20 s keep all 60 numbers", last, numbers.joined(separator: " "))
}

// 2. The same with untimed partials (timestamps 0), the way partial results often arrive.
do {
    var t = TranscriptAccumulator()
    var last = ""
    let phrases = ["one two three four five", "six seven eight nine ten", "eleven twelve thirteen"]
    for phrase in phrases {
        let w = phrase.split(separator: " ")
        for n in 1...w.count {
            last = t.update(R(text: w[0..<n].joined(separator: " "), firstStart: 0, lastEnd: 0), isFinal: false)
        }
    }
    check("untimed restarts after pauses keep every phrase", last, phrases.joined(separator: " "))
}

// 3. A revision of the same utterance replaces the partial, it is not appended.
do {
    var t = TranscriptAccumulator()
    _ = t.update(R(text: "Combinations and lie", firstStart: 0, lastEnd: 0), isFinal: false)
    let last = t.update(R(text: "Combinations and like the others", firstStart: 0, lastEnd: 0), isFinal: false)
    check("a revised partial replaces, never duplicates", last, "Combinations and like the others")
}

// 4. isFinal in the middle of the stream: the task ends, a new task continues, and the final text is kept.
do {
    var t = TranscriptAccumulator()
    _ = t.update(R(text: "first part of it", firstStart: 0.1, lastEnd: 2.0), isFinal: false)
    _ = t.update(R(text: "first part of it", firstStart: 0.1, lastEnd: 2.0), isFinal: true)
    _ = t.update(R(text: "second", firstStart: 0.2, lastEnd: 0.6), isFinal: false)
    let last = t.update(R(text: "second part", firstStart: 0.2, lastEnd: 1.1), isFinal: false)
    check("a final result mid-stream is kept and the next task appends", last, "first part of it second part")
}

// 5. The task stops with an error mid-stream: its last partial is kept.
do {
    var t = TranscriptAccumulator()
    _ = t.update(R(text: "before the error", firstStart: 0, lastEnd: 0), isFinal: false)
    t.taskEnded()
    let last = t.update(R(text: "after it", firstStart: 0, lastEnd: 0), isFinal: false)
    check("a task that ends on its own keeps its text", last, "before the error after it")
}

// 6. The clock goes back near 0 after a restart, with timed results.
do {
    var t = TranscriptAccumulator()
    _ = t.update(R(text: "one two three four", firstStart: 12.0, lastEnd: 16.0), isFinal: false)
    let last = t.update(R(text: "five six", firstStart: 0.3, lastEnd: 1.2), isFinal: false)
    check("a timestamp reset is a restart", last, "one two three four five six")
}

if failures > 0 { print("\(failures) failed"); exit(1) }
print("all passed")
