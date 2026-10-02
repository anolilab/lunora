/**
 * Box enrolment (plan 458 D4, G12): the one-time token an owner mints in the
 * studio and pastes into `lunora-hostd enrol`, and the identifiers a new box is
 * given when it consumes one.
 */
import { randomSecret } from "../deploy/keys";
import stripTrailingSlashes from "../lib/strip-trailing-slashes";

/** How long an enrolment token stays usable (D4). */
export const ENROLMENT_TTL_MS = 15 * 60 * 1000;

/** The prefix every enrolment token carries, so a leaked one is recognisable in logs and scanners. */
const TOKEN_PREFIX = "lbe_";

/** A fresh enrolment token: the prefix plus 256 random bits, hex. Shown once; only its SHA-256 is stored. */
export const mintEnrolmentToken = (): string => `${TOKEN_PREFIX}${randomSecret()}`;

const TOKEN_PATTERN = /^lbe_[\da-f]{64}$/u;

/** Whether `value` has the shape of an enrolment token — checked before hashing so junk never reaches the store. */
export const isEnrolmentTokenShape = (value: unknown): value is string => typeof value === "string" && TOKEN_PATTERN.test(value);

/** Characters after the leading `b`: 36^10 ≈ 3.7e15, so a collision on the unique index is a retry, not a design concern. */
const SLUG_RANDOM_LENGTH = 10;

/** The shape of every slug {@link mintBoxSlug} mints — what tells a box record in the zone from anything else there. */
export const BOX_SLUG_PATTERN = /^b[\da-z]{10}$/u;

/**
 * A new box's DNS label: `b` + ten random `[a-z0-9]`. Random rather than
 * derived from the box's name, because it becomes a public hostname
 * (`{alias}.{slug}.{LUNORA_BOX_DOMAIN}`) and the name is the customer's own.
 */
export const mintBoxSlug = (): string => {
    const bytes = new Uint8Array(SLUG_RANDOM_LENGTH);

    crypto.getRandomValues(bytes);

    // Base 36 is exactly [0-9a-z]. 256 % 36 = 4, so the first four digits are a
    // hair likelier — immaterial for a label.
    return `b${[...bytes].map((byte) => (byte % 36).toString(36)).join("")}`;
};

/**
 * The command the studio shows next to a fresh token. `lunora-hostd enrol`
 * requires `--control-plane`: the origin the box enrols with, dials its
 * session to, and alone fetches releases from (protocol README §5.2) — so it
 * is always this control plane's own public origin (`LUNORA_ORIGIN_URL`).
 */
export const installCommandFor = (token: string, controlPlaneOrigin: string): string =>
    `sudo lunora-hostd enrol --control-plane ${stripTrailingSlashes(controlPlaneOrigin)} --token ${token}`;
