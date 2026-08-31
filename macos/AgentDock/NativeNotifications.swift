import AppKit
import UserNotifications

@MainActor
final class NativeNotificationController: NSObject, UNUserNotificationCenterDelegate {
    private enum Bucket: Equatable {
        case blocked
        case review
        case working
        case idle
        case stale
    }

    private struct Pending {
        let session: AgentSession
        let bucket: Bucket
    }

    private var previous: [String: Bucket] = [:]
    private var primed = false
    private var pending: [Pending] = []
    private var batchTask: Task<Void, Never>?
    private var reminderSessions: Set<String> = []
    private let center = UNUserNotificationCenter.current()
    var onOpenSession: ((String) -> Void)?

    override init() {
        super.init()
        center.delegate = self
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let session = response.notification.request.content.userInfo["session"] as? String
        Task { @MainActor [weak self] in
            if let session {
                self?.onOpenSession?(session)
                NSApp.activate(ignoringOtherApps: true)
            }
            completionHandler()
        }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    func update(
        sessions: [AgentSession],
        activeSession: String?,
        preferences: NativePreferences
    ) {
        let current = Dictionary(uniqueKeysWithValues: sessions.map { ($0.name, bucket($0)) })

        guard preferences.notificationsEnabled else {
            previous = current
            pending = []
            batchTask?.cancel()
            batchTask = nil
            center.removeAllPendingNotificationRequests()
            reminderSessions = []
            primed = true
            return
        }

        requestAuthorization()

        if !primed {
            previous = current
            primed = true
            synchronizeReminders(sessions: sessions, preferences: preferences)
            return
        }

        let quiet = preferences.notifyQuietEnabled && Self.isQuietHour(
            Calendar.current.component(.hour, from: Date()),
            start: preferences.notifyQuietStart,
            end: preferences.notifyQuietEnd
        )

        for session in sessions {
            let next = current[session.name] ?? .idle
            let old = previous[session.name]
            guard old != nil, old != next, !quiet else { continue }
            guard (next == .blocked && preferences.notifyBlocked)
                    || (next == .review && preferences.notifyReview)
            else { continue }

            let alreadyLooking = session.name == activeSession && NSApp.isActive
            guard !alreadyLooking else { continue }
            enqueue(Pending(session: session, bucket: next), batch: preferences.notifyBatchEnabled)
        }

        previous = current
        synchronizeReminders(sessions: sessions, preferences: preferences)
    }

    nonisolated static func isQuietHour(_ hour: Int, start: Int, end: Int) -> Bool {
        if start == end { return false }
        return start < end ? hour >= start && hour < end : hour >= start || hour < end
    }

    private func bucket(_ session: AgentSession) -> Bucket {
        if session.status == .stopped { return .stale }
        if session.statusLine?.type == "input" || session.statusLine?.type == "error" {
            return .blocked
        }
        if session.status == .working || session.status == .background { return .working }
        if session.statusLine?.type == "done" || session.status == .waiting { return .review }
        return .idle
    }

    private func requestAuthorization() {
        center.getNotificationSettings { [center] settings in
            guard settings.authorizationStatus == .notDetermined else { return }
            center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
        }
    }

    private func enqueue(_ item: Pending, batch: Bool) {
        guard batch else {
            deliver([item])
            return
        }
        pending.removeAll { $0.session.name == item.session.name }
        pending.append(item)
        guard batchTask == nil else { return }
        batchTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(30))
            guard !Task.isCancelled else { return }
            self?.flush()
        }
    }

    private func flush() {
        let items = pending
        pending = []
        batchTask = nil
        deliver(items)
    }

    private func deliver(_ items: [Pending]) {
        guard !items.isEmpty else { return }
        let content = UNMutableNotificationContent()
        if items.count == 1, let item = items.first {
            content.title = item.bucket == .blocked
                ? "\(item.session.displayName) is waiting on you"
                : "\(item.session.displayName) is ready to review"
            content.body = item.session.statusLine?.message
                ?? (item.bucket == .blocked
                    ? "It cannot continue without an answer."
                    : "It finished its turn.")
            content.userInfo = ["session": item.session.name]
        } else {
            let blocked = items.filter { $0.bucket == .blocked }.count
            let review = items.count - blocked
            content.title = "\(items.count) AgentDock sessions need attention"
            content.body = [
                blocked > 0 ? "\(blocked) waiting on you" : nil,
                review > 0 ? "\(review) ready to review" : nil,
            ].compactMap { $0 }.joined(separator: " · ")
            if let first = items.first {
                content.userInfo = ["session": first.session.name]
            }
        }
        content.sound = .default
        center.add(UNNotificationRequest(
            identifier: "agentdock-\(UUID().uuidString)",
            content: content,
            trigger: nil
        ))
    }

    private func synchronizeReminders(
        sessions: [AgentSession],
        preferences: NativePreferences
    ) {
        let prefix = "agentdock-reminder-"
        let blocked = Set(sessions.filter { bucket($0) == .blocked }.map(\.name))

        let quiet = preferences.notifyQuietEnabled && Self.isQuietHour(
            Calendar.current.component(.hour, from: Date()),
            start: preferences.notifyQuietStart,
            end: preferences.notifyQuietEnd
        )
        guard preferences.notifyRemindEnabled, !quiet else {
            center.removePendingNotificationRequests(
                withIdentifiers: reminderSessions.map { prefix + $0 }
            )
            reminderSessions = []
            return
        }

        let stale = reminderSessions.subtracting(blocked)
        center.removePendingNotificationRequests(withIdentifiers: stale.map { prefix + $0 })
        let missing = blocked.subtracting(reminderSessions)
        reminderSessions = blocked

        for session in sessions where missing.contains(session.name) {
            let content = UNMutableNotificationContent()
            content.title = "\(session.displayName) is still waiting"
            content.body = session.statusLine?.message ?? "It cannot continue without an answer."
            content.sound = .default
            content.userInfo = ["session": session.name]
            let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 15 * 60, repeats: true)
            center.add(UNNotificationRequest(
                identifier: prefix + session.name,
                content: content,
                trigger: trigger
            ))
        }
    }
}
