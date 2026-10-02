import type { ReturnOf } from "@lunora/client";

import type { api } from "../../lunora/_generated/api.js";
import { formatBytes } from "./format";

/**
 * Pure helpers for the Boxes tab (plan 458 W9): how a box's state reads, who may
 * act on it, and how a refusal from the enrol mutation is worded. Kept out of the
 * components so each decision is testable in node, without a DOM.
 */

export type BoxView = ReturnOf<typeof api.boxes.list>[number];
export type BoxStatus = BoxView["status"];
export type MemberRole = ReturnOf<typeof api.members.list>[number]["role"];

/** The status-chip tones `StatusBadge` knows. */
export type BoxTone = "danger" | "neutral" | "success" | "warning";

/** How each lifecycle state reads: the chip, and the sentence that explains it. */
export const BOX_STATUS: Readonly<Record<BoxStatus, { description: string; label: string; tone: BoxTone }>> = {
    offline: {
        description: "No session for over 90 seconds. Deploys to it fail at once until it reconnects; apps already on it keep serving if the machine is up.",
        label: "offline",
        tone: "danger",
    },
    online: { description: "Connected to Lunora Cloud and taking deploys.", label: "online", tone: "success" },
    pending: { description: "Enrolled, waiting for its agent to open its first session.", label: "pending", tone: "warning" },
    revoked: {
        description: "Revoked: its session is cut and its hostnames are gone. The machine can only come back by enrolling again as a new box.",
        label: "revoked",
        tone: "neutral",
    },
};

/** Why an outdated box matters — celld patches only its newest release, so this is a security finding, not cosmetics. */
export const OUTDATED_EXPLANATION =
    "This box runs an older celld than the newest stable lunora-hostd release. celld only ships fixes for its latest release, so an outdated box is missing security patches. It upgrades on its own when the release is rolled out to it; a box that stays outdated is usually offline.";

/** What `--single-trust` gave up, shown next to the badge. */
export const SINGLE_TRUST_EXPLANATION =
    "Enrolled with --single-trust: the box skipped the tenant isolation self-check, so every app on it must trust every other app on it.";

/** A box's own hostname: `{slug}.{domain}`. Its apps live one label below, at `{alias}.{slug}.{domain}`. */
export const boxHostname = (slug: string, domain: string): string => `${slug}.${domain}`;

/** The roles that may enrol, rename, revoke and place projects on boxes — what the mutations assert. */
const MANAGER_ROLES: ReadonlySet<MemberRole> = new Set<MemberRole>(["admin", "owner"]);

/** The caller's role in the org, from the member roster. `undefined` while the roster loads or for a non-member. */
export const roleOf = (members: ReadonlyArray<{ role: MemberRole; userId: string }> | undefined, userId: string): MemberRole | undefined =>
    members?.find((member) => member.userId === userId)?.role;

/** Whether a role may manage boxes and deploy targets. An unknown role may not: the controls stay disabled until it is known. */
export const canManage = (role: MemberRole | undefined): boolean => role !== undefined && MANAGER_ROLES.has(role);

/** The boxes a project may be placed on: every box of the org that is not revoked (`boxes.setProjectTarget` refuses the rest). */
export const assignableBoxes = (boxes: ReadonlyArray<BoxView> | undefined): BoxView[] => (boxes ?? []).filter((box) => box.status !== "revoked");

const QUOTA_REFUSAL = /\bboxes quota reached\b/u;

/**
 * How a failed `createEnrolment` reads. The plan-limit refusal is the one an
 * operator can act on themselves, so it is reworded to say where; anything else
 * is the server's own message.
 */
export const describeEnrolError = (message: string): { message: string; quota: boolean } =>
    QUOTA_REFUSAL.test(message)
        ? {
              message: "Your plan's box limit is reached (boxes still enrolling count too). Upgrade the plan, or revoke a box you no longer use.",
              quota: true,
          }
        : { message, quota: false };

/** Megabytes as the studio prints sizes (`3.9 GB`). */
export const formatMegabytes = (megabytes: number): string => formatBytes(megabytes * 1024 * 1024);

/** The deploy-target form's draft against what is saved. */
export interface TargetDraft {
    boxId: string;
    target: string;
}

/**
 * What the deploy-target form may do with its draft: whether it needs a box,
 * whether it differs from what is saved, and whether it is complete enough to
 * send (`boxes.setProjectTarget` refuses a `celld-vps` target without a box).
 */
export const assessTargetDraft = (draft: TargetDraft, saved: TargetDraft): { changed: boolean; complete: boolean; needsBox: boolean } => {
    const needsBox = draft.target === "celld-vps";

    return {
        changed: draft.target !== saved.target || (needsBox && draft.boxId !== saved.boxId),
        complete: (draft.target === "celld-vps" || draft.target === "cloudflare-wfp") && (!needsBox || draft.boxId !== ""),
        needsBox,
    };
};
