/**
 * The `diagnose` job (plan 458 W9): `hostd` runs `celld diagnose --json` and
 * friends on the box and streams what they print back as `progress` lines.
 *
 * Box output is untrusted (plan 458 §8). Each line is already held to the
 * protocol's line cap (8 KiB) by the decoder; the collector below also bounds the whole answer — at most
 * {@link MAX_DIAGNOSE_LINES} lines and {@link MAX_DIAGNOSE_BYTES} bytes, one
 * frame's worth — so a box that never stops printing cannot grow the response
 * the studio is handed.
 */
import { HOSTD_PROTOCOL_LIMITS } from "@lunora/hostd/protocol";

/** How long the control plane waits for a box to finish diagnosing itself. */
export const DIAGNOSE_TIMEOUT_MS = 60_000;

/** Most bytes of output one diagnose answers: the protocol's frame cap (256 KiB). */
export const MAX_DIAGNOSE_BYTES = HOSTD_PROTOCOL_LIMITS.maxFrameBytes;

/** Most lines of output one diagnose answers. */
export const MAX_DIAGNOSE_LINES = 4000;

/** What a diagnose answers the studio. */
export interface DiagnoseReport {
    /** Why the job failed, when it did; `output` still holds what arrived before. */
    error?: { code: string; message: string };
    ok: boolean;
    /** The box's output, one entry per `progress` line, in order. */
    output: string[];
    /** Lines were dropped past {@link MAX_DIAGNOSE_LINES} or {@link MAX_DIAGNOSE_BYTES}. */
    truncated: boolean;
}

/** Collects a diagnose's `progress` lines within the caps. */
export interface DiagnoseCollector {
    /** Take one line; a line past the caps is dropped and marks the output truncated. */
    add: (line: string) => void;
    /** The report for the job's outcome. */
    finish: (outcome: { error?: { code: string; message: string }; ok: boolean }) => DiagnoseReport;
}

/** The default caps of {@link createDiagnoseCollector}. */
const DIAGNOSE_LIMITS = { maxBytes: MAX_DIAGNOSE_BYTES, maxLines: MAX_DIAGNOSE_LINES } as const;

export const createDiagnoseCollector = (limits: { maxBytes: number; maxLines: number } = DIAGNOSE_LIMITS): DiagnoseCollector => {
    const encoder = new TextEncoder();
    const output: string[] = [];
    let bytes = 0;
    let truncated = false;

    return {
        add: (line) => {
            // +1 for the newline the lines are joined with.
            const size = encoder.encode(line).length + 1;

            if (truncated || output.length >= limits.maxLines || bytes + size > limits.maxBytes) {
                truncated = true;

                return;
            }

            output.push(line);
            bytes += size;
        },
        finish: ({ error, ok }) => {
            return { ok, output: [...output], truncated, ...(ok || error === undefined ? {} : { error }) };
        },
    };
};
