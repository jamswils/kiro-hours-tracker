// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "KiroSessionsInspector",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "KiroSessionsInspector", targets: ["KiroSessionsInspector"])
    ],
    targets: [
        .executableTarget(
            name: "KiroSessionsInspector",
            path: "Sources/KiroSessionsInspector"
        )
    ]
)
