#!/usr/bin/env bash
# Compile and run the Java SDK's conformance suite.
#
# Plain javac with no build tool and no classpath: the transport has no
# dependencies (Java SE ships no JSON, so `Json.java` is hand-rolled rather than
# pulling in Jackson), and the tests use assertions instead of JUnit. That keeps
# this runnable anywhere a JDK is, including CI, with nothing to resolve.
set -euo pipefail

cd "$(dirname "$0")"

OUT="${1:-out}"

rm -rf "$OUT"
mkdir -p "$OUT"

javac -Xlint:all -d "$OUT" $(find src test -name '*.java')

# -ea turns on the `assert` statements the suite is written with.
java -ea -cp "$OUT" dev.lunora.ConformanceTest
