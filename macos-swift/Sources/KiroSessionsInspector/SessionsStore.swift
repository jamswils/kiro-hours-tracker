import Foundation
import CryptoKit

/// Reads Kiro IDE session data directly from `~/Library/Application Support/Kiro`.
/// Replaces the Express server used in the TypeScript version.
@MainActor
final class SessionsStore: ObservableObject {
    @Published var workspaces: [Workspace] = []
    @Published var dashboard: DashboardData?
    @Published var isLoadingWorkspaces = false
    @Published var isLoadingDashboard = false

    private let fm = FileManager.default

    private var globalStorage: URL {
        fm.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Kiro/User/globalStorage/kiro.kiroagent")
    }

    private var sessionsDir: URL {
        globalStorage.appendingPathComponent("workspace-sessions")
    }

    /// Per-workspace cache of executionId -> full execution JSON.
    private var executionCache: [String: [String: JSONValue]] = [:]

    // MARK: - Workspaces list

    func loadWorkspaces() async {
        isLoadingWorkspaces = true
        defer { isLoadingWorkspaces = false }

        let sessionsPath = sessionsDir
        let result = await Task.detached(priority: .userInitiated) { [sessionsPath] in
            SessionsStore.scanWorkspaces(at: sessionsPath)
        }.value

        self.workspaces = result
    }

    private static nonisolated func scanWorkspaces(at sessionsDir: URL) -> [Workspace] {
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(
            at: sessionsDir,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        ) else { return [] }

        var results: [Workspace] = []
        for url in entries {
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: url.path, isDirectory: &isDir), isDir.boolValue else { continue }

            let dirName = url.lastPathComponent
            let sessionsFile = url.appendingPathComponent("sessions.json")
            guard let data = try? Data(contentsOf: sessionsFile),
                  let sessions = try? JSONDecoder().decode([RawSessionSummary].self, from: data),
                  !sessions.isEmpty else {
                continue
            }

            let decodedPath = decodeBase64URL(dirName)
            let projectName = decodedPath
                .split(separator: "/")
                .last
                .map(String.init) ?? dirName

            let summaries = sessions.map {
                SessionSummary(
                    id: $0.sessionId,
                    title: $0.title ?? "Untitled",
                    date: Double($0.dateCreated) ?? 0
                )
            }

            results.append(Workspace(
                id: dirName,
                path: decodedPath,
                name: projectName,
                sessions: summaries
            ))
        }

        // Largest workspaces first, matching the React version.
        results.sort { $0.sessionCount > $1.sessionCount }
        return results
    }

    // MARK: - Session detail

    func loadSessionDetail(workspaceId: String, sessionId: String) async -> SessionDetail? {
        let sessionFile = sessionsDir
            .appendingPathComponent(workspaceId)
            .appendingPathComponent("\(sessionId).json")

        let storage = globalStorage
        let cached = executionCache

        struct Output { let detail: SessionDetail?; let cacheKey: String?; let execMap: [String: JSONValue]? }

        let result = await Task.detached(priority: .userInitiated) { [sessionFile, storage, cached] in
            guard let data = try? Data(contentsOf: sessionFile) else {
                return Output(detail: nil, cacheKey: nil, execMap: nil)
            }
            guard let json = try? JSONDecoder().decode(JSONValue.self, from: data) else {
                return Output(detail: nil, cacheKey: nil, execMap: nil)
            }

            let workspacePath = json["workspaceDirectory"]?.stringValue ?? ""
            let execMap: [String: JSONValue]
            let cacheKey: String?
            if let existing = cached[workspacePath] {
                execMap = existing
                cacheKey = nil
            } else {
                execMap = SessionsStore.loadExecutions(workspacePath: workspacePath, globalStorage: storage)
                cacheKey = workspacePath
            }

            let detail = SessionsStore.buildSessionDetail(json: json, execMap: execMap)
            return Output(detail: detail, cacheKey: cacheKey, execMap: execMap)
        }.value

        if let key = result.cacheKey, let map = result.execMap {
            executionCache[key] = map
        }
        return result.detail
    }

    private static nonisolated func buildSessionDetail(json: JSONValue, execMap: [String: JSONValue]) -> SessionDetail {
        let historyRaw = json["history"]?.arrayValue ?? []

        let messages: [HistoryMessage] = historyRaw.map { entry in
            let msg = entry["message"]
            let role = msg?["role"]?.stringValue ?? "unknown"

            var content = ""
            if let s = msg?["content"]?.stringValue {
                content = s
            } else if let arr = msg?["content"]?.arrayValue {
                content = arr.compactMap { part -> String? in
                    if part["type"]?.stringValue == "text" { return part["text"]?.stringValue }
                    return nil
                }.joined(separator: "\n")
            }

            let executionId = entry["executionId"]?.stringValue
            var actions: [AgentAction] = []
            var cost: Double = 0

            if let eid = executionId, let execData = execMap[eid] {
                actions = extractActions(from: execData)
                cost = extractCost(from: execData)
            }

            return HistoryMessage(
                role: role,
                content: content,
                executionId: executionId,
                actions: actions,
                cost: cost
            )
        }

        let totalCost = messages.reduce(0) { $0 + $1.cost }

        return SessionDetail(
            id: json["sessionId"]?.stringValue ?? "",
            title: json["title"]?.stringValue ?? "Untitled",
            model: json["selectedModel"]?.stringValue
                ?? json["defaultModelTitle"]?.stringValue
                ?? "unknown",
            autonomyMode: json["autonomyMode"]?.stringValue ?? "unknown",
            sessionType: json["sessionType"]?.stringValue ?? "unknown",
            contextUsage: json["contextUsagePercentage"]?.doubleValue ?? 0,
            workspacePath: json["workspaceDirectory"]?.stringValue ?? "",
            messageCount: messages.count,
            totalCost: totalCost,
            history: messages
        )
    }

    private static nonisolated func extractActions(from exec: JSONValue) -> [AgentAction] {
        guard let arr = exec["actions"]?.arrayValue else { return [] }
        return arr.compactMap { a -> AgentAction? in
            guard let type = a["actionType"]?.stringValue,
                  type != "intentClassification",
                  type != "model" else { return nil }
            return AgentAction(
                actionType: type,
                actionState: a["actionState"]?.stringValue,
                input: a["input"],
                output: a["output"]
            )
        }
    }

    private static nonisolated func extractCost(from exec: JSONValue) -> Double {
        guard let summary = exec["usageSummary"]?.arrayValue else { return 0 }
        return summary.reduce(0.0) { $0 + ($1["usage"]?.doubleValue ?? 0) }
    }

    // MARK: - Execution file loading

    private static nonisolated func loadExecutions(workspacePath: String, globalStorage: URL) -> [String: JSONValue] {
        guard !workspacePath.isEmpty else { return [:] }
        let hash = sha256Hex(workspacePath).prefix(32)
        let wsDir = globalStorage.appendingPathComponent(String(hash))
        let fm = FileManager.default
        guard fm.fileExists(atPath: wsDir.path) else { return [:] }

        var map: [String: JSONValue] = [:]
        guard let subEntries = try? fm.contentsOfDirectory(
            at: wsDir,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        ) else { return map }

        for sub in subEntries {
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: sub.path, isDirectory: &isDir), isDir.boolValue else { continue }
            guard let files = try? fm.contentsOfDirectory(
                at: sub,
                includingPropertiesForKeys: [.fileSizeKey],
                options: [.skipsHiddenFiles]
            ) else { continue }

            for file in files {
                guard let size = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize,
                      size >= 100,
                      let data = try? Data(contentsOf: file),
                      let json = try? JSONDecoder().decode(JSONValue.self, from: data),
                      let execId = json["executionId"]?.stringValue,
                      json["actions"]?.arrayValue != nil else {
                    continue
                }
                map[execId] = json
            }
        }
        return map
    }

    // MARK: - Dashboard aggregation

    func loadDashboard() async {
        isLoadingDashboard = true
        defer { isLoadingDashboard = false }

        let sessionsPath = sessionsDir
        let storage = globalStorage
        let result = await Task.detached(priority: .userInitiated) { [sessionsPath, storage] in
            SessionsStore.buildDashboard(sessionsDir: sessionsPath, globalStorage: storage)
        }.value

        self.dashboard = result
    }

    private static nonisolated func buildDashboard(sessionsDir: URL, globalStorage: URL) -> DashboardData {
        let fm = FileManager.default
        var totalCost: Double = 0
        var totalSessions = 0
        var totalExecutions = 0
        var daily: [String: DailyStats] = [:]
        var modelSessions: [String: Int] = [:]
        var sessionTypes: [String: Int] = [:]
        var autonomyModes: [String: Int] = [:]
        var workspaces: [String: WorkspaceStats] = [:]

        guard let wsEntries = try? fm.contentsOfDirectory(
            at: sessionsDir,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        ) else {
            return DashboardData(
                totalCost: 0, totalSessions: 0, totalExecutions: 0,
                daily: [], modelSessions: [:], sessionTypes: [:],
                autonomyModes: [:], workspaces: []
            )
        }

        let dayFormatter: (Double) -> String = { ms in
            let date = Date(timeIntervalSince1970: ms / 1000)
            let f = ISO8601DateFormatter()
            f.formatOptions = [.withFullDate]
            return f.string(from: date)
        }

        for wsUrl in wsEntries {
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: wsUrl.path, isDirectory: &isDir), isDir.boolValue else { continue }
            let dirName = wsUrl.lastPathComponent

            let sessionsFile = wsUrl.appendingPathComponent("sessions.json")
            guard let data = try? Data(contentsOf: sessionsFile),
                  let sessions = try? JSONDecoder().decode([RawSessionSummary].self, from: data),
                  !sessions.isEmpty else { continue }

            let decodedPath = decodeBase64URL(dirName)
            let projectName = decodedPath.split(separator: "/").last.map(String.init) ?? dirName
            totalSessions += sessions.count

            // Per-session model/type/mode
            for s in sessions {
                let file = wsUrl.appendingPathComponent("\(s.sessionId).json")
                guard let sData = try? Data(contentsOf: file),
                      let json = try? JSONDecoder().decode(JSONValue.self, from: sData) else { continue }
                let model = json["selectedModel"]?.stringValue
                    ?? json["defaultModelTitle"]?.stringValue
                    ?? "unknown"
                let sType = json["sessionType"]?.stringValue ?? "unknown"
                let aMode = json["autonomyMode"]?.stringValue ?? "unknown"
                modelSessions[model, default: 0] += 1
                sessionTypes[sType, default: 0] += 1
                autonomyModes[aMode, default: 0] += 1
            }

            // Sessions-by-date
            for s in sessions {
                let key = dayFormatter(Double(s.dateCreated) ?? 0)
                var stats = daily[key] ?? DailyStats(date: key, sessions: 0, cost: 0, executions: 0)
                stats.sessions += 1
                daily[key] = stats
            }

            // Executions for this workspace
            let hash = sha256Hex(decodedPath).prefix(32)
            let execDir = globalStorage.appendingPathComponent(String(hash))
            var wsCost: Double = 0
            var wsExecs = 0

            if fm.fileExists(atPath: execDir.path),
               let subEntries = try? fm.contentsOfDirectory(
                at: execDir,
                includingPropertiesForKeys: [.isDirectoryKey],
                options: [.skipsHiddenFiles]
               ) {
                for sub in subEntries {
                    var sIsDir: ObjCBool = false
                    guard fm.fileExists(atPath: sub.path, isDirectory: &sIsDir), sIsDir.boolValue else { continue }
                    guard let files = try? fm.contentsOfDirectory(
                        at: sub,
                        includingPropertiesForKeys: [.fileSizeKey],
                        options: [.skipsHiddenFiles]
                    ) else { continue }
                    for file in files {
                        guard let size = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize,
                              size >= 100,
                              let data = try? Data(contentsOf: file),
                              let json = try? JSONDecoder().decode(JSONValue.self, from: data),
                              json["executionId"]?.stringValue != nil,
                              json["actions"]?.arrayValue != nil else { continue }

                        wsExecs += 1
                        totalExecutions += 1
                        let cost = extractCost(from: json)
                        wsCost += cost
                        totalCost += cost

                        let startTime = json["startTime"]?.doubleValue ?? 0
                        let key = dayFormatter(startTime)
                        var stats = daily[key] ?? DailyStats(date: key, sessions: 0, cost: 0, executions: 0)
                        stats.cost += cost
                        stats.executions += 1
                        daily[key] = stats
                    }
                }
            }

            workspaces[projectName] = WorkspaceStats(
                name: projectName,
                cost: wsCost,
                sessions: sessions.count,
                executions: wsExecs
            )
        }

        let sortedDaily = daily.values.sorted { $0.date < $1.date }
        let sortedWorkspaces = workspaces.values.sorted { $0.cost > $1.cost }

        return DashboardData(
            totalCost: totalCost,
            totalSessions: totalSessions,
            totalExecutions: totalExecutions,
            daily: sortedDaily,
            modelSessions: modelSessions,
            sessionTypes: sessionTypes,
            autonomyModes: autonomyModes,
            workspaces: sortedWorkspaces
        )
    }
}

// MARK: - Raw codable helpers

private struct RawSessionSummary: Decodable {
    let sessionId: String
    let title: String?
    let dateCreated: String
}

// MARK: - Utility functions

private func sha256Hex(_ input: String) -> String {
    let digest = SHA256.hash(data: Data(input.utf8))
    return digest.map { String(format: "%02x", $0) }.joined()
}

/// Best-effort base64url decoder mirroring the TypeScript server's leniency.
/// The directory names sometimes include a trailing `?` that needs to be stripped.
private func decodeBase64URL(_ str: String) -> String {
    func tryDecode(_ s: String) -> String? {
        var b = s.replacingOccurrences(of: "-", with: "+")
                 .replacingOccurrences(of: "_", with: "/")
        let pad = (4 - b.count % 4) % 4
        b.append(String(repeating: "=", count: pad))
        guard let data = Data(base64Encoded: b) else { return nil }
        guard let decoded = String(data: data, encoding: .utf8) else { return nil }
        var clean = ""
        for scalar in decoded.unicodeScalars {
            let code = scalar.value
            if code >= 0x20 && code <= 0x7e && scalar != "?" {
                clean.append(Character(scalar))
            } else {
                break
            }
        }
        return clean
    }

    if let decoded = tryDecode(str) { return decoded }
    if str.count > 1, let decoded = tryDecode(String(str.dropLast())) { return decoded }
    return str
}
