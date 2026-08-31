import CryptoKit
import Foundation
import Security

/// Token store backed by the login keychain so the app stays signed in between launches.
enum AuthStore {
    private static let service = "dev.agentdock.mac"
    private static let account = "server-token"

    static var token: String? {
        if let environment = ProcessInfo.processInfo.environment["AD_AUTH_TOKEN"], !environment.isEmpty {
            return environment
        }
        return keychainToken
    }

    static func save(_ token: String) {
        var query = baseQuery
        query[kSecValueData as String] = Data(token.utf8)
        SecItemDelete(baseQuery as CFDictionary)
        SecItemAdd(query as CFDictionary, nil)
    }

    static func clear() {
        SecItemDelete(baseQuery as CFDictionary)
    }

    /// The server accepts sha256("ad:<password>") as a bearer token.
    static func token(for password: String) -> String {
        SHA256.hash(data: Data("ad:\(password)".utf8))
            .map { String(format: "%02x", $0) }
            .joined()
    }

    private static var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    private static var keychainToken: String? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
}

struct APIClient {
    var baseURL = URL(string: "http://127.0.0.1:4800")!
    var session: URLSession = .shared

    func fetchSessions() async throws -> [AgentSession] {
        try await get("api/sessions")
    }

    func fetchRepositories() async throws -> [RepositoryConfig] {
        try await get("api/repos")
    }

    func createSession(_ payload: CreateSessionPayload) async throws -> CreatedSessions {
        try await request(path: "api/sessions", method: "POST", body: payload)
    }

    func fetchTemplates() async throws -> [SessionTemplate] {
        try await get("api/templates")
    }

    func saveTemplate(_ template: NewSessionTemplate) async throws -> SessionTemplate {
        try await request(path: "api/templates", method: "POST", body: template)
    }

    func deleteTemplate(_ id: String) async throws {
        try await send(path: "api/templates/\(id)", method: "DELETE")
    }

    /// Derives the bearer token from the password and stores it once the server accepts it.
    func login(password: String) async throws {
        let token = AuthStore.token(for: password)
        var request = URLRequest(url: url(path: "api/sessions"))
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (_, response) = try await session.data(for: request)
        try validate(response)
        AuthStore.save(token)
    }

    func healthIsReachable() async -> Bool {
        do {
            let (_, response) = try await session.data(from: url(path: "api/auth/status"))
            return (response as? HTTPURLResponse)?.statusCode == 200
        } catch {
            return false
        }
    }

    // MARK: Sessions

    func deleteSession(_ name: String) async throws {
        try await send(path: "api/sessions/\(name)", method: "DELETE")
    }

    func restoreSession(_ name: String) async throws {
        try await send(path: "api/sessions/\(name)/restore", method: "POST")
    }

    func renameSession(_ name: String, to displayName: String) async throws -> AgentSessionName {
        try await request(
            path: "api/sessions/\(name)/rename",
            method: "POST",
            body: ["name": displayName]
        )
    }

    func openInITerm(_ name: String) async throws {
        try await send(path: "api/sessions/\(name)/open-iterm", method: "POST")
    }

    func switchAgent(_ name: String, to agent: String) async throws {
        struct SwitchEvent: Decodable {
            let step: String
            let error: Bool?
        }

        var request = authenticatedRequest(path: "api/sessions/\(name)/switch-agent")
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["agentType": agent])
        let (bytes, response) = try await session.bytes(for: request)
        try validate(response)

        for try await line in bytes.lines where line.hasPrefix("data: ") {
            let payload = Data(line.dropFirst(6).utf8)
            guard let event = try? JSONDecoder().decode(SwitchEvent.self, from: payload) else { continue }
            if event.error == true {
                throw APIError.server(event.step)
            }
        }
    }

    func sendInput(_ text: String, to name: String) async throws {
        try await send(
            path: "api/sessions/\(name)/input",
            method: "POST",
            body: ["text": text]
        )
    }

    // MARK: Preferences

    func fetchPreferences() async throws -> NativePreferences {
        try await get("api/settings/preferences")
    }

    func updatePreferences(_ values: [String: Any]) async throws {
        try await send(path: "api/settings/preferences", method: "PATCH", json: values)
    }

    // MARK: Settings

    func fetchSettingsRepositories() async throws -> [RepositoryConfig] {
        try await get("api/settings/repos")
    }

    func addSettingsRepository(_ repository: RepositoryConfig) async throws {
        try await send(path: "api/settings/repos", method: "POST", body: repository)
    }

    func deleteSettingsRepository(alias: String) async throws {
        let componentCharacters = CharacterSet.alphanumerics
            .union(CharacterSet(charactersIn: "-_.~"))
        let escaped = alias.addingPercentEncoding(withAllowedCharacters: componentCharacters) ?? alias
        var components = URLComponents(
            url: baseURL.appending(path: "api/settings/repos"),
            resolvingAgainstBaseURL: false
        )!
        components.percentEncodedPath += "/\(escaped)"
        var request = URLRequest(url: components.url!)
        request.httpMethod = "DELETE"
        if let token = AuthStore.token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let (data, response) = try await session.data(for: request)
        try validate(response, data: data)
    }

    func fetchBasePath() async throws -> String {
        struct Payload: Decodable { let path: String }
        let payload: Payload = try await get("api/settings/base-path")
        return payload.path
    }

    func updateBasePath(_ path: String) async throws {
        try await send(path: "api/settings/base-path", method: "PUT", body: ["path": path])
    }

    func fetchSettingsHealth() async throws -> SettingsHealth {
        try await get("api/settings/health")
    }

    func fetchHookState() async throws -> HookState {
        try await get("api/settings/hooks")
    }

    func installHooks() async throws -> HookState {
        try await request(path: "api/settings/hooks", method: "POST", body: [String: String]())
    }

    func fetchMetaPropertyPresets() async throws -> [MetaPropertyPreset] {
        try await get("api/settings/meta-properties")
    }

    func saveMetaPropertyPresets(_ presets: [MetaPropertyPreset]) async throws {
        try await send(path: "api/settings/meta-properties", method: "PUT", body: presets)
    }

    func fetchAuthStatus() async throws -> AuthStatus {
        let status: AuthStatus = try await get("api/auth/status")
        guard status.enabled, AuthStore.token != nil else { return status }
        do {
            let _: [AgentSession] = try await get("api/sessions")
            return AuthStatus(enabled: true, loggedIn: true)
        } catch APIError.unauthorized {
            return AuthStatus(enabled: true, loggedIn: false)
        }
    }

    func setPassword(_ password: String) async throws {
        try await send(path: "api/auth/password", method: "PUT", body: ["password": password])
        AuthStore.save(AuthStore.token(for: password))
    }

    func logout() async throws {
        try await send(path: "api/auth/logout", method: "POST")
        AuthStore.clear()
    }

    func fetchNgrokBasicAuthStatus() async throws -> Bool {
        struct Payload: Decodable { let configured: Bool }
        let payload: Payload = try await get("api/settings/ngrok-basic-auth")
        return payload.configured
    }

    func setNgrokBasicAuth(_ value: String) async throws {
        try await send(path: "api/settings/ngrok-basic-auth", method: "PUT", body: ["value": value])
    }

    func deleteNgrokBasicAuth() async throws {
        try await send(path: "api/settings/ngrok-basic-auth", method: "DELETE")
    }

    func fetchPhoneLink() async throws -> PhoneLink {
        try await get("api/network/phone")
    }

    // MARK: Files

    func listDirectory(_ path: String, roots: [String]) async throws -> [FileEntry] {
        struct Payload: Codable { let entries: [FileEntry] }
        let payload: Payload = try await get(
            "api/fs/list",
            query: ["path": path, "roots": roots.joined(separator: ",")]
        )
        return payload.entries
    }

    func readFile(_ path: String, roots: [String]) async throws -> OpenFileDocument {
        struct Payload: Codable {
            let content: String
            let language: String
            let size: Int
            let version: String
        }
        let payload: Payload = try await get(
            "api/fs/read",
            query: ["path": path, "roots": roots.joined(separator: ",")]
        )
        return OpenFileDocument(
            path: path,
            content: payload.content,
            language: payload.language,
            size: payload.size,
            version: payload.version,
            readOnly: false
        )
    }

    func openExternalFile(_ path: String) async throws -> OpenFileDocument {
        try await request(path: "api/fs/open", method: "POST", body: ["path": path])
    }

    func findFiles(
        _ query: String,
        roots: [String],
        kind: String = "both",
        limit: Int = 200
    ) async throws -> FileSearchPayload {
        try await get(
            "api/fs/find",
            query: [
                "q": query,
                "roots": roots.joined(separator: ","),
                "kind": kind,
                "limit": String(limit),
            ]
        )
    }

    func findDefinition(name: String, roots: [String], from: String?) async throws -> DefinitionLookup {
        var query = ["name": name, "roots": roots.joined(separator: ",")]
        if let from { query["from"] = from }
        return try await get("api/code/definition", query: query)
    }

    /// Asks the language server what is under the cursor. Falls back to the
    /// name-based index server-side when no server serves this file.
    func findDefinition(at position: CodePosition) async throws -> DefinitionLookup {
        try await request(path: "api/code/definition", method: "POST", body: position)
    }

    func findReferences(at position: CodePosition) async throws -> [CodeReference] {
        let payload: ReferencesPayload = try await request(
            path: "api/code/references",
            method: "POST",
            body: position
        )
        return payload.hits
    }

    func hover(at position: CodePosition) async throws -> String {
        let payload: HoverPayload = try await request(
            path: "api/code/hover",
            method: "POST",
            body: position
        )
        return payload.text
    }

    func fetchLanguageServers() async throws -> [LanguageServerStatus] {
        let payload: LanguageServerStatusPayload = try await get("api/code/lsp-status")
        return payload.servers
    }

    func documentSymbols(path: String, roots: [String]) async throws -> [DocSymbol] {
        let payload: DocumentSymbolsPayload = try await get(
            "api/code/symbols",
            query: ["path": path, "roots": roots.joined(separator: ",")]
        )
        return payload.symbols
    }

    func findUsages(_ name: String, roots: [String]) async throws -> [ContentSearchHit] {
        let payload: FileSearchPayload = try await get(
            "api/fs/find",
            query: [
                "q": name,
                "roots": roots.joined(separator: ","),
                "kind": "content",
                "word": "1",
                "limit": "80",
            ]
        )
        return payload.content
    }

    func writeFile(
        _ document: OpenFileDocument,
        roots: [String],
        content: String,
        force: Bool = false
    ) async throws -> WriteFileResult {
        var request = authenticatedRequest(path: "api/fs/write")
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "path": document.path,
            "roots": roots.joined(separator: ","),
            "content": content,
            "version": document.version,
            "force": force,
        ])
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode
        // A version mismatch is a successful protocol response: the model uses
        // its payload to offer Reload or Force instead of losing either edit.
        if status != 409 {
            try validate(response, data: data)
        }
        do {
            return try JSONDecoder().decode(WriteFileResult.self, from: data)
        } catch {
            throw APIError.decoding(error.localizedDescription)
        }
    }

    // MARK: Plans

    func fetchPlan(_ sessionName: String, since: String? = nil) async throws -> PlanPayload {
        try await get(
            "api/plan/\(sessionName)",
            query: since.map { ["since": $0] } ?? [:]
        )
    }

    func fetchPlanComments(_ sessionName: String) async throws -> [PlanComment] {
        let payload: PlanCommentsPayload = try await get("api/plan/\(sessionName)/comments")
        return payload.comments
    }

    func createPlanComment(
        sessionName: String,
        blockID: String,
        anchorText: String,
        body: String
    ) async throws -> PlanComment {
        let payload: PlanCommentPayload = try await request(
            path: "api/plan/\(sessionName)/comments",
            method: "POST",
            json: ["blockId": blockID, "anchorText": anchorText, "body": body]
        )
        return payload.comment
    }

    func patchPlanComment(
        sessionName: String,
        id: String,
        values: [String: Any]
    ) async throws -> PlanComment {
        let payload: PlanCommentPayload = try await request(
            path: "api/plan/\(sessionName)/comments/\(id)",
            method: "PATCH",
            json: values
        )
        return payload.comment
    }

    func deletePlanComment(sessionName: String, id: String) async throws {
        try await send(path: "api/plan/\(sessionName)/comments/\(id)", method: "DELETE")
    }

    // MARK: Git

    func fetchGitChanges(path: String) async throws -> GitChanges {
        try await get("api/git/changes", query: ["path": path])
    }

    func fetchPRDiff(path: String) async throws -> String {
        struct Payload: Codable { let diff: String }
        let payload: Payload = try await get("api/git/pr-diff", query: ["path": path])
        return payload.diff
    }

    func pushChanges(path: String) async throws -> GitPushResult {
        try await request(path: "api/git/push", method: "POST", body: ["path": path])
    }

    func createPullRequest(path: String, title: String, body: String) async throws -> GitPRResult {
        try await request(
            path: "api/git/create-pr",
            method: "POST",
            body: ["path": path, "title": title, "body": body]
        )
    }

    // MARK: Transport

    private func get<Response: Decodable>(
        _ path: String,
        query: [String: String] = [:]
    ) async throws -> Response {
        try await request(path: path, query: query)
    }

    private func request<Response: Decodable, Body: Encodable>(
        path: String,
        method: String,
        body: Body
    ) async throws -> Response {
        try await request(path: path, method: method, data: JSONEncoder().encode(body))
    }

    private func request<Response: Decodable>(
        path: String,
        method: String = "GET",
        query: [String: String] = [:],
        json: [String: Any]? = nil,
        data: Data? = nil
    ) async throws -> Response {
        var request = authenticatedRequest(path: path, query: query)
        request.httpMethod = method
        if let json {
            request.httpBody = try JSONSerialization.data(withJSONObject: json)
        } else {
            request.httpBody = data
        }
        if request.httpBody != nil {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (responseData, response) = try await session.data(for: request)
        try validate(response, data: responseData)
        do {
            return try JSONDecoder().decode(Response.self, from: responseData)
        } catch {
            throw APIError.decoding(error.localizedDescription)
        }
    }

    private func send<Body: Encodable>(path: String, method: String, body: Body) async throws {
        let data = try JSONEncoder().encode(body)
        try await send(path: path, method: method, data: data)
    }

    private func send(
        path: String,
        method: String,
        json: [String: Any]? = nil,
        data: Data? = nil
    ) async throws {
        var request = authenticatedRequest(path: path)
        request.httpMethod = method
        if let json {
            request.httpBody = try JSONSerialization.data(withJSONObject: json)
        } else {
            request.httpBody = data
        }
        if request.httpBody != nil {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (responseData, response) = try await session.data(for: request)
        try validate(response, data: responseData)
    }

    private func url(path: String, query: [String: String] = [:]) -> URL {
        var components = URLComponents(
            url: baseURL.appending(path: path),
            resolvingAgainstBaseURL: false
        )!
        components.queryItems = query
            .filter { !$0.value.isEmpty }
            .map { URLQueryItem(name: $0.key, value: $0.value) }
        return components.url!
    }

    private func validate(_ response: URLResponse, data: Data = Data()) throws {
        guard let response = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }
        if response.statusCode == 401 || response.statusCode == 403 {
            throw APIError.unauthorized
        }
        guard 200 ..< 300 ~= response.statusCode else {
            let message = (try? JSONDecoder().decode(APIErrorPayload.self, from: data).error)
            throw APIError.server(message ?? "Request failed (\(response.statusCode)).")
        }
    }

    private func authenticatedRequest(
        path: String,
        query: [String: String] = [:]
    ) -> URLRequest {
        var request = URLRequest(url: url(path: path, query: query))
        if let token = AuthStore.token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return request
    }
}

struct AgentSessionName: Codable {
    let name: String
    let displayName: String
}

private struct APIErrorPayload: Codable {
    let error: String
}

enum APIError: LocalizedError {
    case invalidResponse
    case unauthorized
    case server(String)
    case decoding(String)

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            "AgentDock server returned an invalid response."
        case .unauthorized:
            "Sign in to connect to AgentDock."
        case let .server(message):
            message
        case let .decoding(message):
            "Could not read the server response: \(message)"
        }
    }
}
