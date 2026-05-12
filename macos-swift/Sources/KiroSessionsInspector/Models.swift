import Foundation

// MARK: - View models exposed to the UI

struct Workspace: Identifiable, Hashable {
    let id: String            // base64url directory name
    let path: String          // decoded absolute workspace path
    let name: String          // last path component
    var sessions: [SessionSummary]

    var sessionCount: Int { sessions.count }
}

struct SessionSummary: Identifiable, Hashable {
    let id: String            // sessionId
    let title: String
    let date: Double          // unix ms
}

struct SessionDetail: Identifiable {
    let id: String
    let title: String
    let model: String
    let autonomyMode: String
    let sessionType: String
    let contextUsage: Double
    let workspacePath: String
    let messageCount: Int
    let totalCost: Double
    let history: [HistoryMessage]
}

struct HistoryMessage: Identifiable {
    let id = UUID()
    let role: String
    let content: String
    let executionId: String?
    let actions: [AgentAction]
    let cost: Double
}

struct AgentAction: Identifiable {
    let id = UUID()
    let actionType: String
    let actionState: String?
    let input: JSONValue?
    let output: JSONValue?
}

// MARK: - Dashboard aggregate models

struct DashboardData {
    var totalCost: Double
    var totalSessions: Int
    var totalExecutions: Int
    var daily: [DailyStats]
    var modelSessions: [String: Int]
    var sessionTypes: [String: Int]
    var autonomyModes: [String: Int]
    var workspaces: [WorkspaceStats]
}

struct DailyStats: Identifiable {
    var id: String { date }
    let date: String          // yyyy-MM-dd
    var sessions: Int
    var cost: Double
    var executions: Int
}

struct WorkspaceStats: Identifiable {
    var id: String { name }
    let name: String
    let cost: Double
    let sessions: Int
    let executions: Int
}

// MARK: - JSONValue: loosely-typed JSON for heterogeneous payloads

indirect enum JSONValue: Codable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null; return }
        if let b = try? c.decode(Bool.self) { self = .bool(b); return }
        if let d = try? c.decode(Double.self) { self = .number(d); return }
        if let s = try? c.decode(String.self) { self = .string(s); return }
        if let arr = try? c.decode([JSONValue].self) { self = .array(arr); return }
        if let obj = try? c.decode([String: JSONValue].self) { self = .object(obj); return }
        self = .null
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .number(let n): try c.encode(n)
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }

    // MARK: - Accessors

    subscript(key: String) -> JSONValue? {
        if case .object(let o) = self { return o[key] }
        return nil
    }

    subscript(index: Int) -> JSONValue? {
        if case .array(let a) = self, a.indices.contains(index) { return a[index] }
        return nil
    }

    var stringValue: String? {
        if case .string(let s) = self { return s }
        return nil
    }

    var doubleValue: Double? {
        switch self {
        case .number(let n): return n
        case .string(let s): return Double(s)
        default: return nil
        }
    }

    var arrayValue: [JSONValue]? {
        if case .array(let a) = self { return a }
        return nil
    }

    var objectValue: [String: JSONValue]? {
        if case .object(let o) = self { return o }
        return nil
    }

    /// Pretty-printed JSON representation (stable key ordering).
    func prettyString() -> String {
        let data = try? JSONSerialization.data(
            withJSONObject: toAny(),
            options: [.prettyPrinted, .sortedKeys]
        )
        return data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
    }

    private func toAny() -> Any {
        switch self {
        case .null: return NSNull()
        case .bool(let b): return b
        case .number(let n): return n
        case .string(let s): return s
        case .array(let a): return a.map { $0.toAny() }
        case .object(let o): return o.mapValues { $0.toAny() }
        }
    }
}
