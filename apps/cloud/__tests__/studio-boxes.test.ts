import { describe, expect, it } from "vitest";

import type { BoxView } from "../src/client/boxes";
import {
    assignableBoxes,
    BOX_STATUS,
    boxHostname,
    canDiagnose,
    canManage,
    describeDiagnose,
    describeEnrolError,
    FLEET_STATE,
    formatDiagnoseOutput,
    formatMegabytes,
    roleOf,
} from "../src/client/boxes";
import { formatRelativeTime } from "../src/client/format";
import { assessTargetDraft, projectNamesByHost, retargetDraft } from "../src/client/target-capabilities";

/**
 * The Boxes tab's decisions (plan 458 W9), tested without a DOM: how each box
 * state reads, who sees the controls, which boxes a project may be placed on and
 * how the enrol refusal is worded. The components only render these.
 */
const box = (overrides: Partial<BoxView>): BoxView => {
    return {
        _id: "box_1" as BoxView["_id"],
        createdAt: 1,
        name: "fsn1",
        organizationId: "org_1" as BoxView["organizationId"],
        outdated: false,
        publicKey: "k",
        singleTrust: false,
        slug: "babc",
        status: "online",
        ...overrides,
    };
};

describe("box status chips", () => {
    it.each([
        ["pending", "warning"],
        ["online", "success"],
        ["offline", "danger"],
        ["revoked", "neutral"],
    ] as const)("renders %s with the %s tone and an explanation", (status, tone) => {
        expect(BOX_STATUS[status].tone).toBe(tone);
        expect(BOX_STATUS[status].label).toBe(status);
        expect(BOX_STATUS[status].description.length).toBeGreaterThan(0);
    });

    it("tells an operator a revoked box can only come back as a new one", () => {
        expect(BOX_STATUS.revoked.description).toMatch(/enrolling again as a new box/u);
    });
});

describe(boxHostname, () => {
    it("puts the slug under the configured apex", () => {
        expect(boxHostname("bslug", "boxes.example")).toBe("bslug.boxes.example");
    });
});

describe(canManage, () => {
    it("lets owners and admins manage, and nobody else", () => {
        expect(canManage("owner")).toBe(true);
        expect(canManage("admin")).toBe(true);
        expect(canManage("member")).toBe(false);
        expect(canManage("viewer")).toBe(false);
    });

    it("keeps the controls off while the role is still unknown", () => {
        expect(canManage(undefined)).toBe(false);
    });
});

describe(roleOf, () => {
    const members = [
        { role: "owner" as const, userId: "u1" },
        { role: "viewer" as const, userId: "u2" },
    ];

    it("finds the caller's role in the roster", () => {
        expect(roleOf(members, "u2")).toBe("viewer");
    });

    it("answers undefined while the roster loads, or for someone not on it", () => {
        expect(roleOf(undefined, "u1")).toBeUndefined();
        expect(roleOf(members, "u3")).toBeUndefined();
    });
});

describe(assignableBoxes, () => {
    it("offers every box that is not revoked, pending and offline included", () => {
        const boxes = [
            box({ _id: "a" as BoxView["_id"], status: "online" }),
            box({ _id: "b" as BoxView["_id"], status: "revoked" }),
            box({ _id: "c" as BoxView["_id"], status: "pending" }),
            box({ _id: "d" as BoxView["_id"], status: "offline" }),
        ];

        expect(assignableBoxes(boxes).map((entry) => entry._id)).toStrictEqual(["a", "c", "d"]);
        expect(assignableBoxes(undefined)).toStrictEqual([]);
    });
});

describe(describeEnrolError, () => {
    it("rewords the plan-limit refusal into something the operator can act on", () => {
        const described = describeEnrolError("FORBIDDEN: boxes quota reached for this plan (limit 0)");

        expect(described.quota).toBe(true);
        expect(described.message).toMatch(/plan's box limit/u);
    });

    it("passes any other refusal through as the server worded it", () => {
        expect(describeEnrolError("a box needs a name")).toStrictEqual({ message: "a box needs a name", quota: false });
    });
});

describe(formatMegabytes, () => {
    it("prints megabytes in the studio's size format", () => {
        expect(formatMegabytes(4096)).toBe("4.0 GB");
        expect(formatMegabytes(512)).toBe("512 MB");
    });
});

describe(formatRelativeTime, () => {
    const now = 1_000_000_000;

    it.each([
        [now - 5000, "5s ago"],
        [now - 3 * 60_000, "3m ago"],
        [now - 2 * 3_600_000, "2h ago"],
        [now - 3 * 86_400_000, "3d ago"],
        [now + 5000, "0s ago"],
    ])("formats %d as %s", (at, expected) => {
        expect(formatRelativeTime(at, now)).toBe(expected);
    });
});

describe(assessTargetDraft, () => {
    const saved = { placementRef: "", target: "cloudflare-wfp" };

    it("asks for the host the target's placedOn names, and is incomplete without one", () => {
        expect(assessTargetDraft({ ...saved, target: "celld-vps" }, saved)).toStrictEqual({ changed: true, complete: false, placedOn: "box" });
        expect(assessTargetDraft({ placementRef: "box_1", target: "celld-vps" }, saved)).toStrictEqual({ changed: true, complete: true, placedOn: "box" });
        expect(assessTargetDraft({ ...saved, target: "cloudflare-workers" }, saved)).toStrictEqual({ changed: true, complete: false, placedOn: "account" });
        expect(assessTargetDraft({ placementRef: "cfa_1", target: "cloudflare-workers" }, saved).complete).toBe(true);
    });

    it("treats the saved value as unchanged, and a different host as a change", () => {
        expect(assessTargetDraft(saved, saved).changed).toBe(false);

        const onBox = { placementRef: "box_1", target: "celld-vps" };

        expect(assessTargetDraft(onBox, onBox).changed).toBe(false);
        expect(assessTargetDraft({ ...onBox, placementRef: "box_2" }, onBox).changed).toBe(true);
    });

    it("ignores a stale host once the target is back on Lunora Cloud", () => {
        expect(assessTargetDraft({ placementRef: "box_1", target: "cloudflare-wfp" }, saved)).toStrictEqual({
            changed: false,
            complete: true,
            placedOn: "cell",
        });
    });

    it("never calls an unknown target complete", () => {
        expect(assessTargetDraft({ ...saved, target: "aws" }, saved)).toStrictEqual({ changed: true, complete: false, placedOn: undefined });
    });
});

describe(retargetDraft, () => {
    const onBox = { placementRef: "box_1", target: "celld-vps" };

    it("never carries a host into a target that names another kind", () => {
        expect(retargetDraft(onBox, "cloudflare-workers", onBox)).toStrictEqual({ placementRef: "", target: "cloudflare-workers" });
        expect(retargetDraft(onBox, "cloudflare-wfp", onBox)).toStrictEqual({ placementRef: "", target: "cloudflare-wfp" });
    });

    it("brings the saved host back when the saved kind is chosen again", () => {
        expect(retargetDraft({ placementRef: "", target: "cloudflare-wfp" }, "celld-vps", onBox)).toStrictEqual(onBox);
    });
});

describe(canDiagnose, () => {
    it("offers Diagnose to a manager on a connected box only", () => {
        expect(canDiagnose("owner", box({ status: "online" }))).toBe(true);
        expect(canDiagnose("admin", box({ status: "online" }))).toBe(true);
        expect(canDiagnose("member", box({ status: "online" }))).toBe(false);
        expect(canDiagnose(undefined, box({ status: "online" }))).toBe(false);
        expect(canDiagnose("owner", box({ status: "offline" }))).toBe(false);
        expect(canDiagnose("owner", box({ status: "pending" }))).toBe(false);
        expect(canDiagnose("owner", box({ status: "revoked" }))).toBe(false);
    });
});

describe("fleet state chips", () => {
    it.each([
        ["running", "success"],
        ["starting", "warning"],
        ["failed", "danger"],
        ["stopped", "neutral"],
    ] as const)("renders %s with the %s tone", (state, tone) => {
        expect(FLEET_STATE[state]).toStrictEqual({ label: state, tone });
    });
});

describe(formatDiagnoseOutput, () => {
    it("pretty-prints output that is one JSON document, however the box split it into lines", () => {
        expect(formatDiagnoseOutput(['{"fleets":[{"alias":"web"', ',"state":"running"}]}'])).toBe(
            JSON.stringify({ fleets: [{ alias: "web", state: "running" }] }, null, 2),
        );
    });

    it("shows anything else as it came", () => {
        expect(formatDiagnoseOutput(["celld: ok", "caddy: config rejected"])).toBe("celld: ok\ncaddy: config rejected");
        expect(formatDiagnoseOutput([])).toBe("");
    });
});

describe(describeDiagnose, () => {
    it("says a diagnose finished, and when its output was cut short", () => {
        expect(describeDiagnose({ ok: true, output: ["{}"], truncated: false })).toBe("The box finished diagnosing itself.");
        expect(describeDiagnose({ ok: true, output: ["{}"], truncated: true })).toMatch(/cut short at the size limit/u);
    });

    it("names why a diagnose did not finish, and points at what arrived before", () => {
        expect(describeDiagnose({ error: { code: "BOX_OFFLINE", message: "the box is not connected" }, ok: false, output: [], truncated: false })).toBe(
            "The diagnose did not finish: the box is not connected (BOX_OFFLINE).",
        );
        expect(describeDiagnose({ error: { code: "JOB_TIMEOUT", message: "too slow" }, ok: false, output: ["partial"], truncated: false })).toMatch(
            /What the box printed before that is below\./u,
        );
    });
});

describe(projectNamesByHost, () => {
    it("groups project names under the host each is placed on, and skips projects on none", () => {
        expect(
            projectNamesByHost([
                { name: "web", placementRef: "box_1" },
                { name: "cloud-only" },
                { name: "api", placementRef: "box_1" },
                { name: "byo", placementRef: "cfa_1" },
            ]),
        ).toStrictEqual(
            new Map([
                ["box_1", ["web", "api"]],
                ["cfa_1", ["byo"]],
            ]),
        );
        expect(projectNamesByHost(undefined)).toStrictEqual(new Map());
    });
});
