import { bench, describe } from "vitest";

/*
 * SchedulerDO arms its alarm to the earliest pending job on every `/schedule`.
 *
 * old — `rescheduleAlarm()` runs a `storage.list({ prefix: "t:", limit: 1 })`
 * on every schedule to find the earliest entry, even when the just-inserted
 * job is not the earliest (the common case for "schedule far in the future").
 * new — `armAlarmIfEarlier()` reads the already-set alarm via
 * `storage.getAlarm()` and only writes a new alarm when the inserted job is
 * sooner. No prefix scan when the new job is not the earliest.
 *
 * We model both against a Map-backed storage with the same byte-ordered `list`
 * the production fake uses (lexical order matches numeric order on the padded
 * time index). Pure Node — no workerd. The contrast is: with N existing future
 * jobs, the old path pays a sorted `list` scan over the `t:` keyspace each call;
 * the new path is a single Map read.
 */

const TIME_PAD = 15;
const padTime = (n: number): string => String(n).padStart(TIME_PAD, "0");
const indexKey = (scheduledFor: number, id: string): string => `t:${padTime(scheduledFor)}:${id}`;

interface Store {
    alarm: number | null;
    // Mirrors the fake-state byte-ordered prefix list used by rescheduleAlarm.
    listFirst: (prefix: string) => string | undefined;
    map: Map<string, unknown>;
}

const byteCompare = (left: string, right: string): number => {
    if (left < right) {
        return -1;
    }

    return left > right ? 1 : 0;
};

const makeStore = (): Store => {
    const map = new Map<string, unknown>();

    return {
        alarm: null,
        map,
        listFirst(prefix: string) {
            // Same shape as fake-state.list({ limit: 1, prefix }): collect the
            // matching keys, sort by code unit, take the first.
            let best: string | undefined;

            for (const key of map.keys()) {
                if (key.startsWith(prefix) && (best === undefined || byteCompare(key, best) < 0)) {
                    best = key;
                }
            }

            return best;
        },
    };
};

// --- old path: full prefix scan for the earliest, then setAlarm -----------
const rescheduleAlarmOld = (store: Store): void => {
    const first = store.listFirst("t:");

    if (first === undefined) {
        // eslint-disable-next-line no-param-reassign -- store is the mutable system under test; mutating it models setAlarm()
        store.alarm = null;

        return;
    }

    const dueAt = Number.parseInt(first.slice(2, first.indexOf(":", 2)), 10);

    if (Number.isFinite(dueAt)) {
        // eslint-disable-next-line no-param-reassign -- store is the mutable system under test; mutating it models setAlarm()
        store.alarm = dueAt;
    }
};

// --- new path: getAlarm comparison, no scan unless sooner -----------------
const armAlarmIfEarlier = (store: Store, scheduledFor: number): void => {
    if (store.alarm === null || scheduledFor < store.alarm) {
        // eslint-disable-next-line no-param-reassign -- store is the mutable system under test; mutating it models setAlarm()
        store.alarm = scheduledFor;
    }
};

// Seed N existing jobs all sooner than the ones we'll schedule in the bench,
// so the inserted job is never the earliest (the common, scan-wasteful case).
const SEED = 5000;
const base = Date.now();

const seed = (store: Store): void => {
    for (let index = 0; index < SEED; index += 1) {
        const when = base + index;

        store.map.set(indexKey(when, `seed${String(index)}`), `seed${String(index)}`);
    }

    // eslint-disable-next-line no-param-reassign -- store is the mutable system under test; seeding sets the baseline alarm
    store.alarm = base; // earliest seeded job
};

const oldStore = makeStore();
const newStore = makeStore();

seed(oldStore);
seed(newStore);

let oldCounter = 0;
let newCounter = 0;

describe("schedule alarm-arming — full rescan vs getAlarm fast path", () => {
    bench("old: rescheduleAlarm() full t: prefix scan", () => {
        oldCounter += 1;
        const when = base + SEED + oldCounter; // always later than every seed
        const id = `old${String(oldCounter)}`;

        oldStore.map.set(indexKey(when, id), id);
        rescheduleAlarmOld(oldStore);
    });

    bench("new: armAlarmIfEarlier() single getAlarm read", () => {
        newCounter += 1;
        const when = base + SEED + newCounter;
        const id = `new${String(newCounter)}`;

        newStore.map.set(indexKey(when, id), id);
        armAlarmIfEarlier(newStore, when);
    });
});
