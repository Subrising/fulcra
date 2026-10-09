import AVFoundation
import Speech
import ExpoModulesCore

// All state is confined to the main queue. No recording or network request is
// started here: Fulcra supplies its existing mono PCM capture, retaining it in JS.
//
// Fulcra 0.2.8: the recognizer restarts its transcription during long audio, and a result then holds only the newest
// part. TranscriptAccumulator keeps every finished part, partials report the whole text, and a task that ends on its
// own mid-stream is replaced by a new one, so nothing said before the restart is lost.
final class OnDeviceSpeech {
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var epoch = UUID()
    private var transcript = TranscriptAccumulator()
    private var finished = false
    private var finishing = false
    private var failed = false
    private var restarts = RestartBudget(limit: OnDeviceSpeech.maxRestarts)
    private var pending: Promise?
    private var deadline: DispatchWorkItem?
    var onPartial: ((String) -> Void)?

    /// More restarts than this in one dictation means the recognizer is failing, not resetting.
    private static let maxRestarts = 40

    func start(locale: String, promise: Promise) {
        DispatchQueue.main.async {
            self.cancelCurrent()
            let captured = self.epoch
            let activate = {
                guard self.epoch == captured else { promise.resolve(false); return }
                guard SFSpeechRecognizer.authorizationStatus() == .authorized,
                      let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale)),
                      recognizer.isAvailable, recognizer.supportsOnDeviceRecognition else {
                    promise.resolve(false); return
                }
                self.recognizer = recognizer
                self.startTask(captured)
                promise.resolve(true)
            }
            if SFSpeechRecognizer.authorizationStatus() == .notDetermined {
                SFSpeechRecognizer.requestAuthorization { _ in DispatchQueue.main.async(execute: activate) }
            } else { activate() }
        }
    }

    private func startTask(_ captured: UUID) {
        guard let recognizer = recognizer else { return }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
        self.request = request
        self.task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self = self, self.epoch == captured, self.request === request else { return }
                if let result = result { self.receive(result) }
                if error != nil, !self.finished { self.taskStopped(captured) }
            }
        }
    }

    private func receive(_ result: SFSpeechRecognitionResult) {
        let segments = result.bestTranscription.segments
        let part = TranscriptAccumulator.Result(
            text: result.bestTranscription.formattedString,
            firstStart: segments.first?.timestamp ?? 0,
            lastEnd: segments.last.map { $0.timestamp + $0.duration } ?? 0
        )
        onPartial?(transcript.update(part, isFinal: result.isFinal, stopping: finishing))
        guard result.isFinal else { return }
        if finishing { complete() } else { replaceTask() }
    }

    /// The task ended with an error. Mid-stream, keep the text and listen again; while finishing, return what is kept.
    private func taskStopped(_ captured: UUID) {
        transcript.taskEnded()
        if finishing { complete(); return }
        replaceTask()
    }

    private func replaceTask() {
        // Past the cap the rest of the audio would be dropped; the dictation ends as truncated (see complete()).
        guard restarts.spend() else { failed = true; return }
        startTask(epoch)
    }

    private func complete() {
        guard !finished else { return }
        finished = true
        deadline?.cancel()
        deadline = nil
        let text = transcript.text
        if let pending = pending {
            self.pending = nil
            switch DictationOutcome.decide(text: text, failed: failed, truncated: restarts.exhausted) {
            case .text(let kept): pending.resolve(kept)
            case .reject(let code, let message): pending.reject(code, message)
            }
        }
    }

    func append(base64: String) {
        DispatchQueue.main.async {
            guard let request = self.request, !self.failed, !self.finishing,
                  let data = Data(base64Encoded: base64), data.count > 0,
                  data.count % 2 == 0, data.count <= 1024 * 1024,
                  let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false),
                  let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(data.count / 2)),
                  let samples = buffer.floatChannelData?[0] else { return }
            buffer.frameLength = AVAudioFrameCount(data.count / 2)
            data.withUnsafeBytes { (bytes: UnsafeRawBufferPointer) in
                for i in 0..<Int(buffer.frameLength) {
                    let value = UInt16(bytes[2 * i]) | UInt16(bytes[2 * i + 1]) << 8
                    samples[i] = Float(Int16(bitPattern: value)) / 32768.0
                }
            }
            request.append(buffer)
        }
    }

    func finish(promise: Promise) {
        DispatchQueue.main.async {
            guard self.recognizer != nil, self.pending == nil, !self.finished else {
                promise.reject("ON_DEVICE_SPEECH_UNAVAILABLE", "On-device transcription unavailable; recorded audio is retained"); return
            }
            self.pending = promise
            self.finishing = true
            guard let request = self.request, !self.failed else { self.complete(); return }
            request.endAudio()
            let captured = self.epoch
            // A timeout keeps the text heard so far; it is rejected only when there is none.
            let deadline = DispatchWorkItem { [weak self] in
                guard let self = self, self.epoch == captured else { return }
                self.failed = true
                self.task?.cancel()
                self.complete()
            }
            self.deadline = deadline
            DispatchQueue.main.asyncAfter(deadline: .now() + 20, execute: deadline)
        }
    }

    func cancel() { DispatchQueue.main.async { self.cancelCurrent() } }
    private func cancelCurrent() {
        epoch = UUID()
        deadline?.cancel()
        deadline = nil
        pending?.reject("ON_DEVICE_SPEECH_CANCELLED", "Dictation cancelled")
        pending = nil
        task?.cancel()
        task = nil
        request = nil
        recognizer = nil
        transcript = TranscriptAccumulator()
        finished = false
        finishing = false
        failed = false
        restarts = RestartBudget(limit: OnDeviceSpeech.maxRestarts)
    }
}
