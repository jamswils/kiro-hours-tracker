import SwiftUI

enum SidebarView: String, CaseIterable {
    case dashboard, sessions
}

struct SelectedSession: Hashable {
    let workspaceId: String
    let sessionId: String
}

struct ContentView: View {
    @EnvironmentObject private var store: SessionsStore
    @State private var view: SidebarView = .dashboard
    @State private var selectedSession: SelectedSession?
    @State private var sessionDetail: SessionDetail?
    @State private var isLoadingSession = false

    var body: some View {
        HStack(spacing: 0) {
            SidebarView_(
                view: $view,
                selectedSession: $selectedSession,
                onSelect: { ws, session in
                    selectedSession = SelectedSession(workspaceId: ws, sessionId: session)
                    view = .sessions
                }
            )
            .frame(width: 320)

            mainContent
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Theme.bgPrimary)
        }
        .background(Theme.bgPrimary)
        .onChange(of: selectedSession) { _, newValue in
            Task { await loadSelectedSession(newValue) }
        }
    }

    @ViewBuilder
    private var mainContent: some View {
        switch view {
        case .dashboard:
            DashboardScreen()
        case .sessions:
            if isLoadingSession {
                placeholder("Loading session...")
            } else if let detail = sessionDetail {
                SessionScreen(session: detail)
            } else {
                emptyState
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 6) {
            Text("Kiro Sessions Inspector")
                .font(.system(size: 24, weight: .light))
                .foregroundStyle(Theme.textSecondary)
            Text("Select a session from the sidebar to inspect")
                .font(.system(size: 13))
                .foregroundStyle(Theme.textSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func placeholder(_ text: String) -> some View {
        Text(text)
            .foregroundStyle(Theme.textSecondary)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func loadSelectedSession(_ sel: SelectedSession?) async {
        guard let sel else {
            sessionDetail = nil
            return
        }
        isLoadingSession = true
        defer { isLoadingSession = false }
        sessionDetail = await store.loadSessionDetail(
            workspaceId: sel.workspaceId,
            sessionId: sel.sessionId
        )
    }
}
