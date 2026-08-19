/**
 * The inference primitives every Lunora AI assistant surface shares.
 *
 * Split out of `sql-assistant.ts` when that file crossed a thousand lines: the two
 * halves it had grown — the one-shot SQL tasks served by the shard DO, and the
 * conversational turn served at the Worker — import disjoint sets of it, and this
 * is what both need.
 *
 * ONE inference primitive (`runPrompt`, and therefore ONE deadline), ONE retry
 * policy (`attempt`), ONE untrusted boundary, and one set of caps. A second copy
 * of any of them is how two surfaces end up with two different answers to "how
 * long may a model take" — which is the question the deadline exists to settle.
 *
 * Dependency-free by construction: `shared/` is inlined into each consumer's
 * bundle rather than being a package, so anything imported here would be inlined
 * into all of them.
 */

/**
 * The Workers AI text model used when the caller does not override it. The same
 * fp8-fast instruct build the Issue explainer defaults to: this is a short,
 * heavily-grounded generation, not a reasoning task, so latency beats size.
 * Pinned rather than "latest" because a retired model-id makes `binding.run`
 * throw, which would silently degrade every request.
 */
const DEFAULT_SQL_ASSISTANT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** Cap the operator's natural-language prompt so it cannot blow the token budget. */
const PROMPT_CAP = 500;

/** Cap the statement fed back for repair, and the error accompanying it. */
const STATEMENT_CAP = 2000;

/** Cap any single caller-supplied identifier (a column or type name) inside a grounding block. */
const COLUMN_NAME_CAP = 64;

/** Cap a caller-supplied model-id override; no real Workers AI model id approaches this. */
const MODEL_CAP = 120;

/** Most tables named in the grounding block, so a huge schema cannot crowd out the request. */
const MAX_GROUNDED_TABLES = 40;

/** Most columns listed per table. */
const MAX_GROUNDED_COLUMNS = 25;

/**
 * Delimiters fencing every caller-supplied field inside the prompt, named in the
 * system prompt as the untrusted-data boundary.
 *
 * **Asymmetric on purpose.** A single marker used for both ends is escapable: an
 * ODD number of markers injected into the region flips the pairing, so the real
 * closing marker reads as an opening one and everything after it falls outside
 * the fence. Distinct BEGIN/END strings mean an injected marker cannot re-pair
 * the boundary.
 *
 * That alone is not enough — an injected END would still close early — so
 * {@link capped} neutralises BOTH markers in every caller-supplied field. This
 * used to lean on length caps instead, which was never true: a field capped at
 * 2,000 characters has ample room for a 33-character marker.
 */
const UNTRUSTED_BEGIN = "-----BEGIN UNTRUSTED DATA-----";

/** Closing delimiter. See {@link UNTRUSTED_BEGIN}. */
const UNTRUSTED_END = "-----END UNTRUSTED DATA-----";

/**
 * Deadline for one inference. `binding.run` is awaited on a single-threaded DO's
 * admin dispatch, so a hung model would hold that dispatch open indefinitely;
 * racing a timer degrades instead.
 */
const SQL_ASSISTANT_TIMEOUT_MS = 15_000;

/** How many times a gate-failing or unparseable response is retried before giving up. */
const MAX_ATTEMPTS = 2;

/**
 * Structural projection of the Workers `AI` binding's `run`, declared locally so
 * `@lunora/do` needs no dependency edge on `@lunora/ai` to reach `env.AI`.
 */
export interface AiRunBinding {
    run: (model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>) => Promise<unknown>;
}

/** One table's grounding facts. */
export interface SchemaFact {
    columns: string[];
    table: string;
}

/** Why the assistant produced nothing. A closed union so a typo'd sentinel is a compile error. */
export type GenerateSqlDegradedReason = "ai-disabled" | "ai-error" | "empty-response" | "no-ai-binding" | "unsafe-response";

/** The arm returned when no usable statement was produced. */
export interface GenerateSqlDegraded {
    degraded: true;
    reason: GenerateSqlDegradedReason;
}

/**
 * Strip a Markdown fence (and an optional `tag` language marker on its opening
 * line) from a model response.
 *
 * Fence extraction is `indexOf`, NOT a regex. The obvious pattern
 * (`` /```(?:sql)?\s*([\s\S]*?)```/ ``) backtracks super-linearly, and this
 * input is a model response — the one string in the flow that is neither
 * length-capped by us nor produced by us. A scan cannot be made to blow up.
 * An unterminated fence means the model was cut off mid-answer; take
 * everything after the opener rather than discarding a usable answer.
 */
const stripFence = (raw: string, tag: string): string => {
    const open = raw.indexOf("```");

    if (open === -1) {
        return raw;
    }

    const close = raw.indexOf("```", open + 3);
    const inner = close === -1 ? raw.slice(open + 3) : raw.slice(open + 3, close);
    const newline = inner.indexOf("\n");

    return newline !== -1 && inner.slice(0, newline).trim().toLowerCase() === tag ? inner.slice(newline + 1) : inner;
};

/** Parse a fenced-or-bare JSON response, or `undefined` when it is not JSON. */
const extractJson = (raw: string): unknown => {
    const body = stripFence(raw, "json");

    // Take the outermost bracketed span, so lead-in prose does not break the parse.
    const start = Math.min(...[body.indexOf("["), body.indexOf("{")].filter((at) => at !== -1), body.length);
    const end = Math.max(body.lastIndexOf("]"), body.lastIndexOf("}"));

    if (start >= body.length || end <= start) {
        return undefined;
    }

    try {
        return JSON.parse(body.slice(start, end + 1));
    } catch {
        return undefined;
    }
};

/** Build the degraded arm. */
const degraded = (reason: GenerateSqlDegradedReason): GenerateSqlDegraded => {
    return { degraded: true, reason };
};

/** What an injected fence marker is replaced with — visible, so nothing vanishes silently. */
const NEUTRALISED = "[redacted marker]";

/**
 * Trim, neutralise, and cap a caller-supplied string.
 *
 * THE choke point for untrusted text entering a prompt: every field routes
 * through here, so stripping the fence markers here covers the request, each
 * transcript turn, every tool result, and the schema facts at once — rather than
 * at four call sites, one of which would eventually be forgotten.
 *
 * Replaced rather than deleted so an injection attempt is legible in the prompt
 * instead of silently disappearing.
 */
const capped = (value: unknown, cap: number): string =>
    typeof value === "string" ? value.trim().replaceAll(UNTRUSTED_BEGIN, NEUTRALISED).replaceAll(UNTRUSTED_END, NEUTRALISED).slice(0, cap) : "";

/** Render the schema facts the prompt is grounded in. */
const groundingBlock = (schema: ReadonlyArray<SchemaFact>): string => {
    const lines = schema.slice(0, MAX_GROUNDED_TABLES).map((fact) => `${fact.table}(${fact.columns.slice(0, MAX_GROUNDED_COLUMNS).join(", ")})`);

    return lines.length === 0 ? "No schema information is available." : `Tables and columns in this database:\n${lines.join("\n")}`;
};

/**
 * Run one inference against a deadline, returning the raw text or `undefined`.
 *
 * THE one place `binding.run` is called and the one place the timeout lives.
 * Every task routes through here — a second copy of this race is a second place
 * for the deadline to go missing, and the deadline is what keeps a hung model
 * from pinning the DO's single-threaded admin dispatch.
 */
const runPrompt = async (binding: AiRunBinding, model: string, system: string, user: string): Promise<string | undefined> => {
    let deadline: ReturnType<typeof setTimeout> | undefined;

    const result = await Promise.race([
        binding.run(model, {
            max_tokens: 300,
            messages: [
                { content: system, role: "system" },
                { content: user, role: "user" },
            ],
        }),
        new Promise<never>((_resolve, reject) => {
            deadline = setTimeout(() => {
                reject(new Error("sql-assistant: inference timed out"));
            }, SQL_ASSISTANT_TIMEOUT_MS);
        }),
    ]).finally(() => {
        clearTimeout(deadline);
    });

    if (typeof result === "object" && result !== null && typeof (result as { response?: unknown }).response === "string") {
        return (result as { response: string }).response;
    }

    return undefined;
};

/**
 * THE one retry loop: run, validate, retry once, then degrade.
 *
 * Generic over what a task considers valid, so the attempt policy, the
 * empty-response handling, and the two degrade arms exist exactly once. A model
 * that answered but never cleared validation is a different failure from one
 * that said nothing, and the editor words them differently — that distinction
 * lives here rather than in each task.
 */
const attempt = async <T>(
    run: () => Promise<string | undefined>,
    validate: (raw: string) => T | undefined,
): Promise<GenerateSqlDegraded | { degraded: false; value: T }> => {
    let sawResponse = false;

    for (let index = 0; index < MAX_ATTEMPTS; index += 1) {
        let raw: string | undefined;

        try {
            // eslint-disable-next-line no-await-in-loop -- inherently sequential: attempt two only happens because attempt one failed validation
            raw = await run();
        } catch {
            return degraded("ai-error");
        }

        if (raw === undefined || raw.trim() === "") {
            continue;
        }

        sawResponse = true;

        const value = validate(raw);

        if (value !== undefined) {
            return { degraded: false, value };
        }
    }

    return degraded(sawResponse ? "unsafe-response" : "empty-response");
};

/** True when `binding` structurally looks like a Workers AI binding. */
const isAiBinding = (binding: unknown): binding is AiRunBinding =>
    typeof binding === "object" && binding !== null && typeof (binding as { run?: unknown }).run === "function";

/** Resolve the model id, applying the cap and the pinned default. */
const modelFor = (raw: unknown): string => capped(raw, MODEL_CAP) || DEFAULT_SQL_ASSISTANT_MODEL;

export {
    attempt,
    capped,
    COLUMN_NAME_CAP,
    DEFAULT_SQL_ASSISTANT_MODEL,
    degraded,
    extractJson,
    groundingBlock,
    isAiBinding,
    MAX_ATTEMPTS,
    MAX_GROUNDED_COLUMNS,
    modelFor,
    PROMPT_CAP,
    runPrompt,
    STATEMENT_CAP,
    stripFence,
    UNTRUSTED_BEGIN,
    UNTRUSTED_END,
};
