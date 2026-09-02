import { describe, expect, it } from "vitest";

import type { Logger } from "../../src/util/logger";
import reportPlatformDiagnostics from "../../src/util/platform-diagnostics";

interface Recording {
    lines: { level: string; message: string }[];
    logger: Logger;
}

const recordingLogger = (): Recording => {
    const lines: { level: string; message: string }[] = [];
    const push =
        (level: string) =>
        (message: string): void => {
            lines.push({ level, message });
        };

    return { lines, logger: { error: push("error"), info: push("info"), success: push("success"), warn: push("warn") } };
};

const diagnostic = (level: "error" | "warn", name: string) =>
    ({ level, message: `${name} happened`, name, remediation: "do the thing", target: "aws" }) as never;

describe("reportPlatformDiagnostics", () => {
    it("says nothing and fails nothing when there are none", () => {
        expect.assertions(2);

        const { lines, logger } = recordingLogger();

        expect(reportPlatformDiagnostics([], logger)).toStrictEqual({ errors: [], warnings: [] });
        // Silence on the default target is what keeps this out of every build log.
        expect(lines).toStrictEqual([]);
    });

    it("warns without failing when every diagnostic is warn-level", () => {
        expect.assertions(2);

        const { lines, logger } = recordingLogger();

        expect(reportPlatformDiagnostics([diagnostic("warn", "platform_note")], logger)).toStrictEqual({ errors: [], warnings: ["platform_note happened"] });
        expect(lines[0]?.level).toBe("warn");
    });

    it("fails the command on an error-level diagnostic", () => {
        expect.assertions(2);

        const { lines, logger } = recordingLogger();

        // Both diagnostic kinds are declared `level: "error"` because each drops
        // or misdirects an emitted surface. Printing that as a warning with a
        // zero exit is how an app ships built against a surface its target
        // cannot serve, with CI green the whole way.
        expect(reportPlatformDiagnostics([diagnostic("error", "platform_unknown_target")], logger)).toStrictEqual({
            errors: ["platform_unknown_target happened"],
            warnings: [],
        });
        expect(lines[0]?.level).toBe("error");
    });

    it("fails when errors are mixed in with warnings, and reports every one of both", () => {
        expect.assertions(1);

        const { logger } = recordingLogger();

        // Returning only the first error dropped the rest from
        // `lunora verify --format json`'s `errors` — the documented CI gate — so
        // a consumer saw one reason out of several for an app its target cannot run.
        expect(
            reportPlatformDiagnostics([diagnostic("warn", "a"), diagnostic("error", "b"), diagnostic("error", "c"), diagnostic("warn", "d")], logger),
        ).toStrictEqual({ errors: ["b happened", "c happened"], warnings: ["a happened", "d happened"] });
    });
});
