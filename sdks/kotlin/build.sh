#!/usr/bin/env bash
# Compile and run the Kotlin SDK's conformance suite.
#
# Plain kotlinc with no build tool and no classpath: the transport has no
# dependencies (the JVM ships no JSON, so `Json.kt` is hand-rolled rather than
# pulling in Jackson), and the tests use plain assertions instead of a
# framework. That keeps this runnable anywhere kotlinc is, with nothing to
# resolve.
set -euo pipefail

cd "$(dirname "$0")"

OUT="${1:-out}"

rm -rf "$OUT"
mkdir -p "$OUT"

kotlinc src test -include-runtime -d "$OUT/lunora.jar" -nowarn

java -cp "$OUT/lunora.jar" dev.lunora.ConformanceTestKt
