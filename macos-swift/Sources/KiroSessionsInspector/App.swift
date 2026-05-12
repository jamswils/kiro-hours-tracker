import SwiftUI

@main
struct KiroSessionsInspectorApp: App {
    @StateObject private var store = SessionsStore()

    var body: some Scene {
        WindowGroup("Kiro Sessions Inspector") {
            ContentView()
                .environmentObject(store)
                .frame(minWidth: 1000, minHeight: 700)
                .preferredColorScheme(.dark)
                .task { await store.loadWorkspaces() }
        }
        .windowStyle(.titleBar)
        .windowToolbarStyle(.unified)
    }
}
