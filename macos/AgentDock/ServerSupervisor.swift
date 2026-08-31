import Foundation

@MainActor
final class ServerSupervisor {
    private(set) var process: Process?
    private let api: APIClient

    init(api: APIClient) {
        self.api = api
    }

    func ensureRunning() async throws {
        if await api.healthIsReachable() {
            return
        }

        let repository = try locateRepository()
        let bun = try locateBun()
        let process = Process()
        process.executableURL = bun
        process.arguments = ["run", "src/index.ts"]
        process.currentDirectoryURL = repository.appending(path: "server", directoryHint: .isDirectory)
        process.environment = shellEnvironment()
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        self.process = process

        for _ in 0 ..< 30 {
            if await api.healthIsReachable() {
                return
            }
            try await Task.sleep(for: .milliseconds(100))
        }

        throw ServerError.didNotBecomeReady
    }

    func stopOwnedServer() {
        guard let process, process.isRunning else { return }
        process.terminate()
        self.process = nil
    }

    private func locateRepository() throws -> URL {
        let environment = ProcessInfo.processInfo.environment
        var candidates: [URL] = []

        if let configured = environment["AGENTDOCK_ROOT"], !configured.isEmpty {
            candidates.append(URL(filePath: configured, directoryHint: .isDirectory))
        }

        candidates.append(URL(filePath: FileManager.default.currentDirectoryPath, directoryHint: .isDirectory))
        candidates.append(
            FileManager.default.homeDirectoryForCurrentUser
                .appending(path: "projects/agentdock", directoryHint: .isDirectory)
        )

        for candidate in candidates {
            let entrypoint = candidate.appending(path: "server/src/index.ts")
            if FileManager.default.fileExists(atPath: entrypoint.path) {
                return candidate
            }
        }

        throw ServerError.repositoryNotFound
    }

    private func locateBun() throws -> URL {
        let candidates = [
            "/opt/homebrew/bin/bun",
            "/usr/local/bin/bun",
            "\(FileManager.default.homeDirectoryForCurrentUser.path)/.bun/bin/bun",
        ]

        guard let path = candidates.first(where: FileManager.default.isExecutableFile(atPath:)) else {
            throw ServerError.bunNotFound
        }
        return URL(filePath: path)
    }

    private func shellEnvironment() -> [String: String] {
        var environment = ProcessInfo.processInfo.environment
        let homebrew = "/opt/homebrew/bin"
        let currentPath = environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
        if !currentPath.split(separator: ":").contains(Substring(homebrew)) {
            environment["PATH"] = "\(homebrew):\(currentPath)"
        }
        return environment
    }
}

enum ServerError: LocalizedError {
    case repositoryNotFound
    case bunNotFound
    case didNotBecomeReady

    var errorDescription: String? {
        switch self {
        case .repositoryNotFound:
            "Could not find the AgentDock repository. Set AGENTDOCK_ROOT."
        case .bunNotFound:
            "Could not find Bun. Install it before starting AgentDock."
        case .didNotBecomeReady:
            "The AgentDock server did not become ready on port 4800."
        }
    }
}
