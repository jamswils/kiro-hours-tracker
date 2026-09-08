# Kiro Sessions Inspector — macOS / Swift

A native macOS port of the React + Express version. SwiftUI app built with
Swift Package Manager, reads Kiro IDE session data directly from local
JSON files — no server required.

See [`../README.md`](../README.md) for the web version and a project
overview. This directory is self-contained for the Swift build.

## Requirements

- macOS 14 or later (`Package.swift` declares `platforms: [.macOS(.v14)]`)
- Swift 5.9+ (Xcode 15 or `swift` from the toolchain)

## Run

```bash
cd macos-swift
swift run
```

Or open `Package.swift` in Xcode and hit Run.

## Data sources

Reads directly from:

```
~/Library/Application Support/Kiro/User/globalStorage/kiro.kiroagent/
  workspace-sessions/         # Per-workspace session metadata
  <sha256[:32](workspace)>/   # Execution files with tool calls
```

The same storage layout described in `../KIRO_SESSION_FORMAT.md`.

## Architecture

- `App.swift` — app entry point, owns the `SessionsStore`
- `ContentView.swift` — sidebar + main area layout
- `SidebarView.swift` — workspace tree and tab switcher
- `DashboardScreen.swift` — aggregate stats, charts, breakdowns
- `SessionScreen.swift` — message thread with expandable tool calls
- `SessionsStore.swift` — async file readers, caches executions per workspace
- `Models.swift` — view models and a loose `JSONValue` for heterogeneous payloads
- `Theme.swift` — shared colors matching the React design

## Distribution

- [`HOMEBREW.md`](HOMEBREW.md) — installing via `brew` (builds from source)
- [`DISTRIBUTION.md`](DISTRIBUTION.md) — building `.dmg` / `.zip` artifacts
  and options for signed + notarized releases

Quick local builds:

```bash
make dmg          # .build/dist/KiroSessionsInspector-<version>-arm64.dmg
make zip          # .build/dist/KiroSessionsInspector-<version>-arm64.zip
make install      # copy .app to /Applications and link a CLI launcher
```
