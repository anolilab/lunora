import type { Id } from "../../lunora/_generated/dataModel.js";

/** Shared id aliases so the client components don't repeat the generic. */
export type OrgId = Id<"organizations">;
export type ProjectId = Id<"projects">;
export type CellId = Id<"cells">;
export type MemberId = Id<"members">;
export type DeployKeyId = Id<"deployKeys">;
export type InvitationId = Id<"invitations">;
export type SecretId = Id<"secrets">;
