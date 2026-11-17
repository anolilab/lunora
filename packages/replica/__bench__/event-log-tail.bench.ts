import { bench, describe } from "vitest";

import { EventLog } from "../src/event-log";

/*
 * An incremental `EventSource.replayFromLog` (one per replication tick) asks the
 * log for the entries past its watermark: `getSince(watermark)` over a long log
 * returning a short tail. That read should cost the tail, not the log.
 */

const ENTRY_COUNT = 10_000;
const TAIL = 10;

const log = new EventLog();

for (let index = 0; index < ENTRY_COUNT; index += 1) {
    log.append("tick", { index }, undefined, { timestamp: index });
}

const watermark = log.nextSeq - TAIL;

describe(`EventLog tail read (${String(ENTRY_COUNT)} entries, last ${String(TAIL)})`, () => {
    bench("getSince(watermark)", () => {
        log.getSince(watermark);
    });

    bench("getFrom(watermark)", () => {
        log.getFrom(watermark);
    });
});
