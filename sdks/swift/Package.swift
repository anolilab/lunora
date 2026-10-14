// swift-tools-version:5.9

import PackageDescription

// The Lunora Swift client.
//
// Deliberately dependency-free — Foundation only. The HTTP poster and the
// WebSocket frame sender are injected by the caller, so the conformance suite
// runs offline and a consumer picks its own networking stack rather than
// inheriting ours.
let package = Package(
    name: "Lunora",
    platforms: [.macOS(.v12), .iOS(.v15)],
    products: [
        .library(name: "Lunora", targets: ["Lunora"])
    ],
    targets: [
        .target(name: "Lunora"),
        .testTarget(name: "LunoraTests", dependencies: ["Lunora"]),
        // There is deliberately no target for generated output. Since the
        // generator vendors the transport, its output is its OWN SwiftPM package
        // with a copy of these sources inside it — so the only honest place to
        // build and call it is a scratch directory outside this repo, which is
        // what `sdks/generated-check.sh swift` does on every run.
    ]
)
