import { describe, expect, it } from "vitest";

import type { PresenceMemberLike } from "../../src/core/presence";
import { presenceRoster, presenceSummary } from "../../src/core/presence";

const NOW = Date.UTC(2026, 8, 12, 12, 0, 0);

const member = (overrides: Partial<PresenceMemberLike> & { sessionId: string }): PresenceMemberLike => {
    return {
        lastSeen: NOW,
        ...overrides,
    };
};

describe("presenceRoster", () => {
    it("collapses a person's tabs into one entry, keeping the freshest heartbeat", () => {
        const roster = presenceRoster(
            [
                member({ data: { name: "Ada" }, lastSeen: NOW - 5000, sessionId: "tab-1", userId: "u1" }),
                member({ data: { name: "Ada" }, lastSeen: NOW, sessionId: "tab-2", userId: "u1" }),
            ],
            undefined,
        );

        expect(roster.total).toBe(1);
        expect(roster.entries[0]).toMatchObject({ connections: 2, lastSeen: NOW, name: "Ada" });
    });

    it("keys anonymous viewers by tab — merging two strangers is worse than showing two", () => {
        expect(presenceRoster([member({ sessionId: "a" }), member({ sessionId: "b" })], undefined).total).toBe(2);
    });

    it("puts the viewer first, then the most recently active", () => {
        const roster = presenceRoster(
            [
                member({ data: { name: "Grace" }, lastSeen: NOW, sessionId: "t1", userId: "u2" }),
                member({ data: { name: "Ada" }, lastSeen: NOW - 60_000, sessionId: "t2", userId: "u1" }),
                member({ data: { name: "Alan" }, lastSeen: NOW - 1000, sessionId: "t3", userId: "u3" }),
            ],
            "u1",
        );

        expect(roster.entries.map((entry) => entry.name)).toStrictEqual(["Ada", "Grace", "Alan"]);
        expect(roster.entries[0]!.isSelf).toBe(true);
    });

    it("caps the avatar row and reports the overflow", () => {
        const many = Array.from({ length: 11 }, (_, index) => member({ sessionId: `t${index.toString()}`, userId: `u${index.toString()}` }));
        const roster = presenceRoster(many, undefined, 8);

        expect(roster.entries).toHaveLength(8);
        expect(roster.overflow).toBe(3);
        expect(roster.total).toBe(11);
    });

    it("falls back to the key when the awareness blob carries no usable name", () => {
        expect(presenceRoster([member({ data: { name: "   " }, sessionId: "t1", userId: "u1" })], undefined).entries[0]!.name).toBe("u1");
        expect(presenceRoster([member({ sessionId: "t1" })], undefined).entries[0]!.name).toBe("t1");
    });
});

describe("presenceSummary", () => {
    it("counts other people, not connections", () => {
        const roster = presenceRoster(
            [member({ sessionId: "t1", userId: "u1" }), member({ sessionId: "t2", userId: "u1" }), member({ sessionId: "t3", userId: "u2" })],
            "u1",
        );

        expect(presenceSummary(roster)).toBe("1 other person is here");
    });

    it("says something useful when you are alone, and when nobody is", () => {
        expect(presenceSummary(presenceRoster([member({ sessionId: "t1", userId: "u1" })], "u1"))).toBe("Only you are here");
        expect(presenceSummary(presenceRoster([], "u1"))).toBe("No one else is here");
    });
});
