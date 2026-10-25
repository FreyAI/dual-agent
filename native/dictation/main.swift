// Dual Agent Dictation: the chat box's mic.
// The extension opens this app (`open -n -g`) rather than running it, so macOS asks for the microphone
// and speech recognition for this app: the chat page may not use the mic, and VS Code declares no
// speech recognition. It records, recognises on this Mac when the language supports it, and streams
// JSON lines to the extension's local port. It finishes when you pause, after a minute, when the
// recognizer ends, or on "stop" (send) or "cancel" (don't) from the extension, then quits.
import AppKit
import AVFoundation
import Network
import Speech

/// How long a pause after words counts as "done", and the longest recording.
let pauseToSend: TimeInterval = 1.6
let maxSeconds: TimeInterval = 60

func arg(_ name: String) -> String? {
    let a = CommandLine.arguments
    guard let i = a.firstIndex(of: name), i + 1 < a.count else { return nil }
    return a[i + 1]
}

/// The extension's socket: JSON lines out, "stop" / "cancel" lines in. Everything runs on the main queue.
final class Link {
    private let conn: NWConnection
    private var buffer = Data()
    var onLine: (String) -> Void = { _ in }
    var onClose: () -> Void = {}

    init(port: UInt16) {
        conn = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!, using: .tcp)
    }

    func start(token: String) {
        conn.stateUpdateHandler = { [weak self] state in
            switch state {
            case .failed, .cancelled: self?.onClose()
            default: break
            }
        }
        conn.start(queue: .main)
        send(["type": "hello", "token": token])
        receive()
    }

    private func receive() {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 4096) { [weak self] data, _, done, error in
            guard let self else { return }
            if let data { self.buffer.append(data) }
            while let nl = self.buffer.firstIndex(of: 10) {
                let line = String(decoding: self.buffer[..<nl], as: UTF8.self)
                self.buffer.removeSubrange(...nl)
                self.onLine(line.trimmingCharacters(in: .whitespaces))
            }
            if done || error != nil { self.onClose() } else { self.receive() }
        }
    }

    func send(_ msg: [String: Any], then: (() -> Void)? = nil) {
        guard var data = try? JSONSerialization.data(withJSONObject: msg) else { return }
        data.append(10)
        conn.send(content: data, completion: .contentProcessed { _ in then?() })
    }
}

final class Dictation {
    private let link: Link
    private var engine = AVAudioEngine()
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    /// Every phrase the recognizer has already moved on from, and its current phrase.
    private var base = ""
    private var phrase: String?
    /// What was last sent as the words, and when they last changed.
    private var written: String?
    private var lastChange = Date()
    private let began = Date()
    /// The microphone, for "no sound from …", and the loudest it got (near 0: no sound arrived at all).
    private let device = AVCaptureDevice.default(for: .audio)?.localizedName ?? "the microphone"
    private var peak: Float = 0
    private var levelSent = Date.distantPast
    private var watcher: Timer?
    private var configObserver: NSObjectProtocol?
    private var ended = false

    init(link: Link) {
        self.link = link
        link.onLine = { [weak self] line in
            if line == "stop" { self?.finish(send: true, why: "clicked") }
            if line == "cancel" { self?.finish(send: false, why: "cancelled") }
        }
        // The chat went away: stop recording at once.
        link.onClose = { [weak self] in
            self?.stopAudio()
            exit(0)
        }
    }

    func start() {
        SFSpeechRecognizer.requestAuthorization { status in
            DispatchQueue.main.async {
                guard status == .authorized else {
                    return self.end(problem: "Speech recognition is off for Dual Agent Dictation (System Settings › Privacy & Security › Speech Recognition).")
                }
                AVCaptureDevice.requestAccess(for: .audio) { ok in
                    DispatchQueue.main.async {
                        ok ? self.record() : self.end(problem: "Microphone access is off for Dual Agent Dictation (System Settings › Privacy & Security › Microphone).")
                    }
                }
            }
        }
    }

    private func record() {
        guard !ended else { return }
        guard let recognizer = SFSpeechRecognizer(), recognizer.isAvailable else { return end(problem: "Dictation isn't available right now.") }
        self.recognizer = recognizer
        begin(recognizer)
        do {
            engine.prepare()
            try engine.start()
        } catch {
            engine.inputNode.removeTap(onBus: 0)
            return end(problem: "The microphone couldn't start: \(error.localizedDescription)")
        }
        // The input's format changed (Bluetooth earbuds switch to their call profile as the mic opens,
        // or another mic was picked): the engine has stopped, so connect again and carry on.
        configObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
            self?.reconnect()
        }
        link.send(["type": "listening", "device": device])
        watcher = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
            guard let self else { return }
            if self.written != nil, Date().timeIntervalSince(self.lastChange) >= pauseToSend { self.finish(send: true, why: "pause") }
            else if Date().timeIntervalSince(self.began) >= maxSeconds { self.finish(send: true, why: "one minute") }
        }
    }

    /// A new request and recognition task, with the mic tapped into it (one request must not mix formats).
    private func begin(_ recognizer: SFSpeechRecognizer) {
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
        self.request = request
        let input = engine.inputNode
        input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { [weak self] buffer, _ in
            request.append(buffer)
            let level = Dictation.level(of: buffer)
            DispatchQueue.main.async { self?.heard(level: level) }
        }
        // Results arrive on the main queue (the recognizer's default).
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            self?.handle(result, error, request: request)
        }
    }

    private func heard(level: Float) {
        peak = max(peak, level)
        // About ten a second is enough for the button's halo.
        if Date().timeIntervalSince(levelSent) >= 0.1 {
            levelSent = Date()
            link.send(["type": "level", "level": level])
        }
    }

    private func reconnect() {
        guard !ended, let recognizer else { return }
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        task?.cancel()
        if let phrase, !phrase.isEmpty { base += phrase + " " }
        phrase = nil
        begin(recognizer)
        do {
            engine.prepare()
            try engine.start()
        } catch {
            end(problem: "The microphone stopped (\(device)). Click the mic to try again.")
        }
    }

    private func handle(_ result: SFSpeechRecognitionResult?, _ error: Error?, request: SFSpeechAudioBufferRecognitionRequest) {
        // A recognition replaced on reconnect keeps calling back for a moment: ignore it.
        guard !ended, request === self.request else { return }
        if let result {
            let now = result.bestTranscription.formattedString
            // After a pause the recognizer can start a new phrase afresh: keep the earlier one.
            if let phrase, Dictation.startedAfresh(previous: phrase, now: now) { base += phrase + " " }
            phrase = now
            let words = base + now
            if words != written {
                written = words
                lastChange = Date()
                link.send(["type": "text", "text": words])
            }
        }
        if let error, written == nil {
            // The recognizer gave up before any words (a long silence): say so, don't just vanish.
            if error.localizedDescription.localizedCaseInsensitiveContains("disabled") {
                // macOS refuses speech recognition while Dictation is off; open the switch.
                if let url = URL(string: "x-apple.systempreferences:com.apple.Keyboard-Settings.extension") { NSWorkspace.shared.open(url) }
                return end(problem: "Dictation is off in macOS. Turn it on in Keyboard settings, then click the mic.")
            }
            return end(problem: "Didn't hear anything. Click the mic and speak.")
        }
        if error != nil || result?.isFinal == true { finish(send: true, why: "recognizer finished") }
    }

    /// Stops recording and, when it heard words, has the chat send them.
    private func finish(send: Bool, why: String) {
        guard !ended else { return }
        let heard = !(written ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        if heard || !send || recognizer == nil { return end(send: send && heard) }
        end(problem: peak < 0.05
            ? "No sound came from \(device). Check System Settings › Sound › Input, then click the mic."
            : "Didn't catch any words. Click the mic and speak.")
    }

    private func end(send: Bool = false, problem: String? = nil) {
        guard !ended else { return }
        ended = true
        stopAudio()
        var msg: [String: Any] = ["type": "done", "send": send]
        if let problem { msg["problem"] = problem }
        link.send(msg) { exit(0) }
    }

    private func stopAudio() {
        watcher?.invalidate()
        if let o = configObserver { NotificationCenter.default.removeObserver(o) }
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        // The words are already sent, so the final result isn't needed: cancel, don't finish.
        task?.cancel()
    }

    /// The recognizer's text began a new phrase rather than revising the last one: the old phrase had
    /// a few words, the new one is shorter and starts with a different word.
    static func startedAfresh(previous: String, now: String) -> Bool {
        let old = previous.lowercased().split(whereSeparator: \.isWhitespace)
        let new = now.lowercased().split(whereSeparator: \.isWhitespace)
        guard old.count >= 3, !new.isEmpty, new.count < old.count else { return false }
        return old.first != new.first
    }

    /// The buffer's loudness mapped to 0…1 (about -50 dB to -10 dB).
    static func level(of buffer: AVAudioPCMBuffer) -> Float {
        guard let samples = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return 0 }
        var sum: Float = 0
        for i in 0..<Int(buffer.frameLength) { sum += samples[i] * samples[i] }
        let db = 20 * log10(max((sum / Float(buffer.frameLength)).squareRoot(), 1e-7))
        return min(max((db + 50) / 40, 0), 1)
    }
}

guard let portText = arg("--port"), let port = UInt16(portText), let token = arg("--token") else {
    FileHandle.standardError.write(Data("Dual Agent Dictation is started by the Dual Agent extension.\n".utf8))
    exit(2)
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let link = Link(port: port)
let dictation = Dictation(link: link)
link.start(token: token)
dictation.start()
app.run()
