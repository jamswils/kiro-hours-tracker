import SwiftUI

struct DashboardScreen: View {
    @EnvironmentObject private var store: SessionsStore

    var body: some View {
        ScrollView {
            content
                .padding(24)
                .frame(maxWidth: 960, alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .top)
        }
        .task {
            if store.dashboard == nil { await store.loadDashboard() }
        }
    }

    @ViewBuilder
    private var content: some View {
        if store.isLoadingDashboard {
            Text("Loading dashboard...")
                .foregroundStyle(Theme.textSecondary)
        } else if let data = store.dashboard {
            dashboard(data)
        } else {
            Text("Failed to load dashboard")
                .foregroundStyle(Theme.textSecondary)
        }
    }

    @ViewBuilder
    private func dashboard(_ data: DashboardData) -> some View {
        VStack(alignment: .leading, spacing: 24) {
            Text("Usage Dashboard")
                .font(.system(size: 18, weight: .medium))
                .foregroundStyle(Theme.textPrimary)

            // Summary cards
            HStack(spacing: 16) {
                StatCard(icon: "dollarsign.circle", label: "Total Credits",
                         value: String(format: "%.1f", data.totalCost))
                StatCard(icon: "square.stack.3d.up", label: "Sessions",
                         value: "\(data.totalSessions)")
                StatCard(icon: "bolt", label: "Executions",
                         value: "\(data.totalExecutions)")
                StatCard(icon: "chart.line.uptrend.xyaxis", label: "Avg/Session",
                         value: String(format: "%.2f", data.totalCost / Double(max(data.totalSessions, 1))))
            }

            // Daily activity (last 30 days)
            DailyActivityCard(data: last30Days(from: data))

            // Weekly spend
            WeeklySpendCard(weeks: weeks(from: data))

            // Breakdown row
            HStack(alignment: .top, spacing: 16) {
                BreakdownCard(
                    title: "Session Type",
                    items: sortedCounts(data.sessionTypes),
                    total: data.totalSessions
                ) { key in
                    key == "spec" ? Theme.blue : Theme.purple
                }

                BreakdownCard(
                    title: "Autonomy Mode",
                    items: sortedCounts(data.autonomyModes),
                    total: data.totalSessions
                ) { key in
                    key == "Autopilot" ? Theme.green : Theme.amber
                }

                BreakdownCard(
                    title: "Model Usage",
                    items: sortedCounts(data.modelSessions),
                    total: data.totalSessions
                ) { _ in Theme.accent }
            }

            // Top workspaces
            WorkspacesCard(workspaces: Array(data.workspaces.prefix(10)))
        }
    }

    // MARK: - Helpers

    private func sortedCounts(_ map: [String: Int]) -> [(key: String, value: Int)] {
        map.sorted { $0.value > $1.value }.map { ($0.key, $0.value) }
    }

    private func last30Days(from data: DashboardData) -> [DailyStats] {
        let cal = Calendar(identifier: .iso8601)
        let today = cal.startOfDay(for: Date())
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withFullDate]

        let existing = Dictionary(uniqueKeysWithValues: data.daily.map { ($0.date, $0) })
        var results: [DailyStats] = []
        for i in stride(from: 29, through: 0, by: -1) {
            guard let date = cal.date(byAdding: .day, value: -i, to: today) else { continue }
            let key = formatter.string(from: date)
            results.append(existing[key] ?? DailyStats(date: key, sessions: 0, cost: 0, executions: 0))
        }
        return results
    }

    private func weeks(from data: DashboardData) -> [(week: String, cost: Double, sessions: Int, executions: Int)] {
        let cal = Calendar(identifier: .iso8601)
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withFullDate]

        var map: [String: (cost: Double, sessions: Int, executions: Int)] = [:]
        for d in data.daily {
            guard let date = formatter.date(from: d.date) else { continue }
            let weekday = cal.component(.weekday, from: date) // 1 = Sunday
            let daysFromSunday = weekday - 1
            guard let weekStart = cal.date(byAdding: .day, value: -daysFromSunday, to: date) else { continue }
            let key = formatter.string(from: weekStart)
            var existing = map[key] ?? (0, 0, 0)
            existing.cost += d.cost
            existing.sessions += d.sessions
            existing.executions += d.executions
            map[key] = existing
        }
        return map.map { (week: $0.key, cost: $0.value.cost, sessions: $0.value.sessions, executions: $0.value.executions) }
            .sorted { $0.week < $1.week }
    }
}

// MARK: - Stat card

private struct StatCard: View {
    let icon: String
    let label: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: icon).font(.system(size: 11))
                Text(label).font(.system(size: 11))
            }
            .foregroundStyle(Theme.textSecondary)

            Text(value)
                .font(.system(size: 22, weight: .semibold))
                .foregroundStyle(Theme.textPrimary)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .themeCard()
    }
}

// MARK: - Daily activity card

private struct DailyActivityCard: View {
    let data: [DailyStats]

    var body: some View {
        let maxCost = max(data.map { $0.cost }.max() ?? 0, 0.01)

        VStack(alignment: .leading, spacing: 12) {
            Text("Daily Activity (Last 30 Days)")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Theme.textSecondary)

            GeometryReader { geo in
                HStack(alignment: .bottom, spacing: 1) {
                    ForEach(data) { day in
                        let h: CGFloat = day.cost > 0
                            ? max(4, (day.cost / maxCost) * 120)
                            : 0
                        Rectangle()
                            .fill(Theme.accent.opacity(0.7))
                            .frame(height: h)
                            .clipShape(RoundedCorner(radius: 2, corners: [.topLeft, .topRight]))
                            .help("\(day.date): \(String(format: "%.2f", day.cost)) credits, \(day.executions) execs")
                            .frame(maxWidth: .infinity)
                    }
                }
                .frame(height: geo.size.height, alignment: .bottom)
            }
            .frame(height: 128)

            if let first = data.first?.date, let last = data.last?.date {
                HStack {
                    Text(first)
                    Spacer()
                    Text(last)
                }
                .font(.system(size: 10))
                .foregroundStyle(Theme.textSecondary)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .themeCard()
    }
}

// MARK: - Weekly spend card

private struct WeeklySpendCard: View {
    let weeks: [(week: String, cost: Double, sessions: Int, executions: Int)]

    var body: some View {
        let recent = Array(weeks.suffix(8))
        let maxCost = max(recent.map { $0.cost }.max() ?? 0, 0.01)

        VStack(alignment: .leading, spacing: 8) {
            Text("Weekly Spend")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Theme.textSecondary)

            VStack(spacing: 4) {
                ForEach(recent, id: \.week) { w in
                    HStack(spacing: 8) {
                        Text(w.week)
                            .font(.system(size: 11))
                            .foregroundStyle(Theme.textSecondary)
                            .frame(width: 80, alignment: .leading)

                        GeometryReader { geo in
                            ZStack(alignment: .leading) {
                                Rectangle().fill(Theme.bgTertiary)
                                Rectangle()
                                    .fill(Theme.accent.opacity(0.7))
                                    .frame(width: geo.size.width * CGFloat(w.cost / maxCost))
                            }
                            .clipShape(RoundedRectangle(cornerRadius: 2))
                        }
                        .frame(height: 16)

                        Text(String(format: "%.1f cr", w.cost))
                            .font(.system(size: 11))
                            .foregroundStyle(Theme.textPrimary)
                            .frame(width: 80, alignment: .trailing)
                    }
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .themeCard()
    }
}

// MARK: - Breakdown card

private struct BreakdownCard: View {
    let title: String
    let items: [(key: String, value: Int)]
    let total: Int
    let color: (String) -> Color

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Theme.textSecondary)

            VStack(spacing: 8) {
                ForEach(items, id: \.key) { item in
                    let pct = total > 0 ? Double(item.value) / Double(total) * 100 : 0
                    VStack(spacing: 4) {
                        HStack {
                            Text(item.key)
                                .font(.system(size: 11))
                                .foregroundStyle(Theme.textPrimary)
                                .lineLimit(1)
                            Spacer()
                            Text("\(item.value) (\(Int(pct))%)")
                                .font(.system(size: 11))
                                .foregroundStyle(Theme.textSecondary)
                        }

                        GeometryReader { geo in
                            ZStack(alignment: .leading) {
                                Rectangle().fill(Theme.bgTertiary)
                                Rectangle()
                                    .fill(color(item.key))
                                    .frame(width: geo.size.width * CGFloat(pct / 100))
                            }
                            .clipShape(RoundedRectangle(cornerRadius: 2))
                        }
                        .frame(height: 8)
                    }
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .top)
        .themeCard()
    }
}

// MARK: - Workspaces card

private struct WorkspacesCard: View {
    let workspaces: [WorkspaceStats]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Top Workspaces by Spend")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Theme.textSecondary)

            VStack(spacing: 6) {
                ForEach(workspaces) { ws in
                    HStack(spacing: 12) {
                        Image(systemName: "folder")
                            .font(.system(size: 11))
                            .foregroundStyle(Theme.textSecondary)
                        Text(ws.name)
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.textPrimary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Text("\(ws.sessions) sessions")
                            .font(.system(size: 11))
                            .foregroundStyle(Theme.textSecondary)
                        Text("\(ws.executions) execs")
                            .font(.system(size: 11))
                            .foregroundStyle(Theme.textSecondary)
                        Text(String(format: "%.1f cr", ws.cost))
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(Theme.textPrimary)
                            .frame(width: 80, alignment: .trailing)
                    }
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .themeCard()
    }
}

// MARK: - Rounded corner helper

private struct RoundedCorner: Shape {
    var radius: CGFloat = .zero
    var corners: RectCorner = .allCorners

    func path(in rect: CGRect) -> Path {
        let radii: CGFloat = radius
        var path = Path()
        let topLeft = CGPoint(x: rect.minX, y: rect.minY)
        let topRight = CGPoint(x: rect.maxX, y: rect.minY)
        let bottomLeft = CGPoint(x: rect.minX, y: rect.maxY)
        let bottomRight = CGPoint(x: rect.maxX, y: rect.maxY)

        path.move(to: CGPoint(x: rect.minX + (corners.contains(.topLeft) ? radii : 0), y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX - (corners.contains(.topRight) ? radii : 0), y: rect.minY))
        if corners.contains(.topRight) {
            path.addArc(tangent1End: topRight, tangent2End: CGPoint(x: rect.maxX, y: rect.minY + radii), radius: radii)
        }
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - (corners.contains(.bottomRight) ? radii : 0)))
        if corners.contains(.bottomRight) {
            path.addArc(tangent1End: bottomRight, tangent2End: CGPoint(x: rect.maxX - radii, y: rect.maxY), radius: radii)
        }
        path.addLine(to: CGPoint(x: rect.minX + (corners.contains(.bottomLeft) ? radii : 0), y: rect.maxY))
        if corners.contains(.bottomLeft) {
            path.addArc(tangent1End: bottomLeft, tangent2End: CGPoint(x: rect.minX, y: rect.maxY - radii), radius: radii)
        }
        path.addLine(to: CGPoint(x: rect.minX, y: rect.minY + (corners.contains(.topLeft) ? radii : 0)))
        if corners.contains(.topLeft) {
            path.addArc(tangent1End: topLeft, tangent2End: CGPoint(x: rect.minX + radii, y: rect.minY), radius: radii)
        }
        path.closeSubpath()
        return path
    }
}

private struct RectCorner: OptionSet {
    let rawValue: Int
    static let topLeft     = RectCorner(rawValue: 1 << 0)
    static let topRight    = RectCorner(rawValue: 1 << 1)
    static let bottomLeft  = RectCorner(rawValue: 1 << 2)
    static let bottomRight = RectCorner(rawValue: 1 << 3)
    static let allCorners: RectCorner = [.topLeft, .topRight, .bottomLeft, .bottomRight]
}
