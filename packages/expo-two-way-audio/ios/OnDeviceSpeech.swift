import AVFoundation
import Speech
import ExpoModulesCore

// All state is confined to the main queue. No recording or network request is
// started here: Fulcra supplies its existing mono PCM capture, retaining it in JS.
final class OnDeviceSpeech {
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var epoch = UUID()
    private var finalText: String?
    private var failed = false
    private var pending: Promise?
    private var deadline: DispatchWorkItem?
    var onPartial: ((String) -> Void)?

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
                let request = SFSpeechAudioBufferRecognitionRequest()
                request.requiresOnDeviceRecognition = true
                request.shouldReportPartialResults = true
                self.recognizer = recognizer
                self.request = request
                self.task = recognizer.recognitionTask(with: request) { [weak self] result, error in
                    DispatchQueue.main.async {
                        guard let self = self, self.epoch == captured else { return }
                        if let result = result {
                            let text = result.bestTranscription.formattedString
                            self.onPartial?(text)
                            if result.isFinal {
                                self.finalText = text
                                if let pending = self.pending {
                                    self.pending = nil
                                    self.deadline?.cancel()
                                    pending.resolve(text)
                                }
                            }
                        }
                        if error != nil && self.finalText == nil {
                            self.failed = true
                            self.deadline?.cancel()
                            self.pending?.reject("ON_DEVICE_SPEECH_UNAVAILABLE", "On-device transcription unavailable; recorded audio is retained")
                            self.pending = nil
                        }
                    }
                }
                promise.resolve(true)
            }
            if SFSpeechRecognizer.authorizationStatus() == .notDetermined {
                SFSpeechRecognizer.requestAuthorization { _ in DispatchQueue.main.async(execute: activate) }
            } else { activate() }
        }
    }

    func append(base64: String) {
        DispatchQueue.main.async {
            guard let request = self.request, !self.failed,
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
            if let text = self.finalText { promise.resolve(text); return }
            guard let request = self.request, !self.failed, self.pending == nil else {
                promise.reject("ON_DEVICE_SPEECH_UNAVAILABLE", "On-device transcription unavailable; recorded audio is retained"); return
            }
            self.pending = promise
            request.endAudio()
            let captured = self.epoch
            let deadline = DispatchWorkItem { [weak self] in
                guard let self = self, self.epoch == captured else { return }
                self.pending?.reject("ON_DEVICE_SPEECH_TIMEOUT", "On-device transcription timed out; recorded audio is retained")
                self.pending = nil
                self.task?.cancel()
                self.failed = true
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
        finalText = nil
        failed = false
    }
}
