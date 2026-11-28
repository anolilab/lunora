/** What a start, `status` and the MCP status tool make of the `.lunora/dev.json` record another dev server left. */
import { setTimeout as sleep } from "node:timers/promises";

import type { DevServerState } from "@lunora/config";
import { clearDevServerState, devServerPhase, isRecordedProcessCurrent, readDevServerState } from "@lunora/config";

import { heapExhaustedAdvice } from "../../util/dev-heap";
import type { ReadinessProbe } from "../../util/dev-probe";
import { defaultProbe } from "../../util/dev-probe";
import { EXIT_CODE } from "../../util/exit-code";
import type { Logger } from "../../util/logger";
import { readLogTail, resolveLogPath } from "./log-file";

/** Log lines shown for a background server found dead by the next `status` or start. */
const EXITED_LOG_TAIL_LINES = 15;

/**
 * Read the live record, and return the record of a background server that has died.
 *
 * A background server can die after the launcher stopped waiting for it, as one
 * that runs out of V8 heap a few seconds past the ready timeout does. Nobody sees
 * that crash: the launcher has exited and the output went to the log. The next
 * `status` or start is the first command that notices, so it gets the dead record
 * back instead of it being cleared silently. A foreground server's record has no
 * log to show; it is cleared as before.
 */
const readLiveOrExited = (cwd: string): { exited?: DevServerState; live?: DevServerState } => {
    const recorded = readDevServerState(cwd);

    if (recorded === undefined) {
        return {};
    }

    if (isRecordedProcessCurrent(recorded)) {
        return { live: recorded };
    }

    clearDevServerState(cwd, recorded.pid);

    return recorded.background === true ? { exited: recorded } : {};
};

/** The last lines of a dead background server's log. */
const exitedLogTail = (cwd: string, exited: DevServerState): string[] => readLogTail(resolveLogPath(cwd, exited), EXITED_LOG_TAIL_LINES);

/** Tell the user a recorded background server is gone, with the end of its log. */
const reportExitedServer = (logger: Logger, cwd: string, exited: DevServerState): void => {
    const logTail = exitedLogTail(cwd, exited);

    // A placeholder names the launcher, or the detached child it was re-pointed at after the ready
    // timeout. Its pid being gone says the start ended before the server recorded itself, not that
    // the server died: an interrupted launcher leaves one while its child may still be compiling.
    logger.warn(
        exited.provisional === true
            ? `A background dev server start (pid ${String(exited.pid)}) ended before its server recorded itself; its record was cleared. Its log ended with:`
            : `The background dev server recorded at ${exited.url} (pid ${String(exited.pid)}) is no longer running; its record was cleared. Its log ended with:`,
    );

    for (const line of logTail) {
        logger.warn(`  ${line}`);
    }

    const advice = heapExhaustedAdvice(logTail);

    if (advice !== undefined) {
        logger.warn(`  ${advice}`);
    }
};

/** Read the live record for a start, reporting a dead background server first (see {@link readLiveOrExited}). */
const readLiveReportingExited = (cwd: string, logger: Logger): DevServerState | undefined => {
    const { exited, live } = readLiveOrExited(cwd);

    if (exited !== undefined) {
        reportExitedServer(logger, cwd, exited);
    }

    return live;
};

/** Print the `stop` / `status` / `logs` hint triple shown after every start-adjacent report. */
const printLifecycleHints = (logger: Logger): void => {
    logger.info("  Stop:   lunora dev stop");
    logger.info("  Status: lunora dev status");
    logger.info("  Logs:   lunora dev logs");
};

/**
 * Probe attempts for a server that has answered before, and the pause between
 * them. A serving worker can miss one while it rebuilds, and a reload closes its
 * port for a moment, so the attempts span about a second rather than the few
 * milliseconds three refused connections take.
 */
const SERVING_PROBE_ATTEMPTS = 3;
const SERVING_PROBE_GAP_MS = 500;

/** Waits between probe attempts; injectable so tests do not sleep. */
type Pause = (ms: number) => Promise<unknown>;

const answersWithin = async (probe: ReadinessProbe, url: string, attempts: number, pause: Pause): Promise<boolean> => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (attempt > 0) {
            // eslint-disable-next-line no-await-in-loop -- the gap between attempts is the point
            await pause(SERVING_PROBE_GAP_MS);
        }

        // eslint-disable-next-line no-await-in-loop -- attempts are sequential by design: each one waits for the previous to miss
        if (await probe(url)) {
            return true;
        }
    }

    return false;
};

/**
 * Answer a start that found another dev server's live record, and return its exit code.
 *
 * "Already running" (exit 0, the idempotent start) needs more than a live pid: the
 * record must be the server's own and its origin must answer. A launcher's
 * provisional record names a guessed URL, so an answer there could come from
 * anything and never counts. Every other case exits {@link EXIT_CODE.UNAVAILABLE}
 * with what the record shows, because a supervisor that read exit 0 as "serving"
 * went on to talk to a port nothing was listening on.
 */
const answerExistingServer = async (logger: Logger, existing: DevServerState, probe: ReadinessProbe = defaultProbe, pause: Pause = sleep): Promise<number> => {
    const phase = devServerPhase(existing);
    const at = `${existing.url} (pid ${String(existing.pid)})`;

    if (phase === "launching") {
        logger.warn(`Another dev server start is in progress (pid ${String(existing.pid)}); its server has not recorded itself yet.`);
    } else if (await answersWithin(probe, existing.url, phase === "ready" ? SERVING_PROBE_ATTEMPTS : 1, pause)) {
        logger.warn(`Dev server already running at ${at}`);
        printLifecycleHints(logger);

        return 0;
    } else if (phase === "starting") {
        logger.warn(`A dev server is recorded at ${at} but has not answered there yet: still starting, or stuck.`);
    } else {
        logger.warn(`A dev server is recorded at ${at} and answered at ${String(existing.readyAt)}, but does not answer now.`);
    }

    logger.info("  `lunora dev status` and `lunora dev logs` show what it is doing; `lunora dev stop` stops it so a new start can run.");

    return EXIT_CODE.UNAVAILABLE;
};

export { answerExistingServer, exitedLogTail, printLifecycleHints, readLiveOrExited, readLiveReportingExited, reportExitedServer };
