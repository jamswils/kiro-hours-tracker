import SwiftUI

struct SessionScreen: View {
    let session: SessionDetail

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                ForEach(session.history) { msg in
                    MessageBlock(message: msg)
                }
            }
            .padding(24)
            .frame(maxWidth: 860, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .top)
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(session.title.isEmpty ? "Untitled" : session.title)
                .font(.system(size: 18, weight: .medium))
                .foregroundStyle(Theme.textPrimary)

            // Chips wrap to a second row as needed.
            FlowLayout(spacing: 8) {
                chip(icon: "cpu", text: session.model)
                chip(icon: "bolt", text: session.autonomyMode)
                chip(icon: "square.stack.3d.up", text: session.sessionType)
                chip(icon: "gauge.with.dots.needle.bottom.50percent",
                     text: String(format: "%.1f%% context", session.contextUsage))
                chip(icon: nil, text: "\(session.messageCount) messages")
                if session.totalCost > 0 {
                    chip(icon: "dollarsign.circle",
                         text: String(format: "%.2f credits", session.totalCost))
                }
            }
        }
    }

    private func chip(icon: String?, text: String) -> some View {
        HStack(spacing: 4) {
            if let icon { Image(systemName: icon).font(.system(size: 10)) }
            Text(text).font(.system(size: 11))
        }
        .foregroundStyle(Theme.textSecondary)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(Capsule().fill(Theme.bgTertiary))
    }
}

// MARK: - Message block

private struct MessageBlock: View {
    let message: HistoryMessage

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: message.role == "user" ? "person.fill" : "sparkles")
                    .font(.system(size: 11))
                    .foregroundStyle(message.role == "user" ? Theme.blue : Theme.accent)
                Text(message.role.uppercased())
                    .font(.system(size: 10, weight: .medium))
                    .tracking(0.8)
                    .foregroundStyle(Theme.textSecondary)
                Spacer()
                if message.cost > 0 {
                    Text(String(format: "%.2f credits", message.cost))
                        .font(.system(size: 10))
                        .foregroundStyle(Theme.textSecondary)
                }
            }

            if !message.content.isEmpty {
                Text(message.content)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.textPrimary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            if !message.actions.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(message.actions) { action in
                        ActionBlock(action: action)
                    }
                }
                .padding(.top, 4)
            }

            if message.content.isEmpty && message.actions.isEmpty {
                Text("(empty)")
                    .italic()
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.textSecondary)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(message.role == "user" ? Theme.bgTertiary : Theme.bgSecondary)
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(Theme.border, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

// MARK: - Action block

private struct ActionBlock: View {
    let action: AgentAction
    @State private var expanded = false

    var body: some View {
        Group {
            switch action.actionType {
            case "say":
                sayBody
            case "reasoning":
                reasoningBody
            default:
                toolCallBody
            }
        }
    }

    private var sayBody: some View {
        let message = action.output?["message"]?.stringValue ?? ""
        return Text(message)
            .font(.system(size: 13))
            .foregroundStyle(Theme.textPrimary)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var reasoningBody: some View {
        let message = action.output?["message"]?.stringValue ?? ""
        return VStack(alignment: .leading, spacing: 4) {
            Button { expanded.toggle() } label: {
                HStack(spacing: 4) {
                    Image(systemName: expanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 10))
                    Image(systemName: "brain")
                        .font(.system(size: 10))
                    Text("Thinking")
                        .font(.system(size: 11))
                }
                .foregroundStyle(Theme.purple)
            }
            .buttonStyle(.plain)

            if expanded && !message.isEmpty {
                Text(message)
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textSecondary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.leading, 12)
        .overlay(alignment: .leading) {
            Rectangle()
                .fill(Theme.purple.opacity(0.4))
                .frame(width: 2)
        }
        .padding(.vertical, 2)
    }

    private var toolCallBody: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button { expanded.toggle() } label: {
                HStack(spacing: 6) {
                    Image(systemName: expanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 10))
                    Image(systemName: icon(for: action.actionType))
                        .font(.system(size: 10))
                        .foregroundStyle(iconColor(for: action.actionType))
                    Text(label(for: action))
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(Theme.textSecondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if let state = action.actionState, state != "Success" {
                        Text("(\(state))")
                            .font(.system(size: 11))
                            .foregroundStyle(Theme.yellow)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)

            if expanded {
                VStack(alignment: .leading, spacing: 4) {
                    if let input = action.input {
                        Text(input.prettyString())
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(Theme.textSecondary)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    if let output = action.output {
                        if action.input != nil {
                            Rectangle().fill(Theme.border).frame(height: 1).padding(.vertical, 2)
                        }
                        Text(output.prettyString())
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(Theme.textPrimary)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.bgTertiary)
                .clipShape(RoundedRectangle(cornerRadius: 4))
                .padding(.leading, 18)
            }
        }
        .padding(.vertical, 1)
    }

    private func icon(for type: String) -> String {
        switch type {
        case "runCommand": return "terminal"
        case "readFiles": return "doc.text"
        case "search": return "magnifyingglass"
        case "replace", "write", "create": return "square.and.pencil"
        case "getDiagnostics": return "exclamationmark.triangle"
        default: return "bolt"
        }
    }

    private func iconColor(for type: String) -> Color {
        switch type {
        case "runCommand": return Theme.green
        case "readFiles": return Theme.yellow
        case "search": return Theme.cyan
        case "replace", "write", "create": return Theme.orange
        default: return Theme.textSecondary
        }
    }

    private func label(for action: AgentAction) -> String {
        let input = action.input
        switch action.actionType {
        case "runCommand":
            return input?["command"]?.stringValue ?? "command"
        case "readFiles":
            if let files = input?["files"]?.arrayValue {
                let paths = files.compactMap { $0["path"]?.stringValue }
                return paths.isEmpty ? "read" : paths.joined(separator: ", ")
            }
            return "read"
        case "search":
            return input?["query"]?.stringValue ?? "search"
        case "replace", "write", "create":
            return input?["file"]?.stringValue ?? action.actionType
        case "getDiagnostics":
            if let paths = input?["paths"]?.arrayValue {
                return paths.compactMap { $0.stringValue }.joined(separator: ", ")
            }
            return "diagnostics"
        default:
            return action.actionType
        }
    }
}

// MARK: - Flow layout for wrapping chips

struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var rowWidth: CGFloat = 0
        var rowHeight: CGFloat = 0
        var totalHeight: CGFloat = 0
        var totalWidth: CGFloat = 0

        for (i, sub) in subviews.enumerated() {
            let size = sub.sizeThatFits(.unspecified)
            let gap = i == 0 ? 0 : spacing
            if rowWidth + gap + size.width > width && rowWidth > 0 {
                totalHeight += rowHeight + spacing
                totalWidth = max(totalWidth, rowWidth)
                rowWidth = size.width
                rowHeight = size.height
            } else {
                rowWidth += gap + size.width
                rowHeight = max(rowHeight, size.height)
            }
        }
        totalHeight += rowHeight
        totalWidth = max(totalWidth, rowWidth)
        return CGSize(width: min(totalWidth, width), height: totalHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x: CGFloat = bounds.minX
        var y: CGFloat = bounds.minY
        var rowHeight: CGFloat = 0

        for sub in subviews {
            let size = sub.sizeThatFits(.unspecified)
            if x + size.width > bounds.maxX && x > bounds.minX {
                x = bounds.minX
                y += rowHeight + spacing
                rowHeight = 0
            }
            sub.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}
