/**
 * Generates the capability tables on the Lunora Cloud bring-your-own pages from
 * the control plane's provisioning contract (`apps/cloud/src/provision-contract.ts`):
 *
 * - `cloud/your-own-server.mdx` — `BINDING_SUPPORT`, `UNSUPPORTED_REASONS` and
 *   `TARGETS[…].limitations` for `celld-vps`;
 * - `cloud/your-own-cloudflare-account.mdx` — the same for `cloudflare-workers`,
 *   plus `CLOUDFLARE_TOKEN_PERMISSIONS`.
 *
 * Those tables are what the deploy handler refuses a release against and what
 * the studio's capability card states, so a hand-copied table would drift from
 * the product the first time a binding is wired. Only the blocks between the
 * markers are written; the prose around them is hand-authored.
 *
 * The contract is read as SOURCE and evaluated from its AST rather than
 * imported. Importing it would pull `@lunora/hostd/protocol` (a built `dist/`)
 * into the docs build and test, and `apps/docs` has no dependency edge on
 * `apps/cloud` for a build to follow. The constants are plain annotated object
 * literals, so the evaluator below handles exactly literals, `as const` /
 * `satisfies` wrappers and references to top-level string constants — and
 * throws on anything else rather than guessing.
 *
 * Usage:
 *   node apps/docs/scripts/generate-target-capabilities.js
 *   node apps/docs/scripts/generate-target-capabilities.js --check
 *
 * `__tests__/target-capabilities.test.ts` re-renders both pages and fails when
 * a committed page does not match, and `--check` is the same comparison from
 * the command line.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import prettier from "prettier";
import ts from "typescript";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ROOT_DIR = path.resolve(__dirname, "..", "..", "..");
const CONTRACT_PATH = path.join(ROOT_DIR, "apps", "cloud", "src", "provision-contract.ts");
const CLOUD_DOCS_DIR = path.join(__dirname, "..", "src", "content", "docs", "cloud");

const SOURCE_NOTE = "written from apps/cloud/src/provision-contract.ts by apps/docs/scripts/generate-target-capabilities.js. Do not edit by hand.";

/** MDX expression comments: an HTML comment is a parse error in MDX. */
const markerStart = (id) => `{/* generated:${id} — ${SOURCE_NOTE} */}`;
const markerEnd = (id) => `{/* /generated:${id} */}`;

/**
 * The reader-facing name of every binding type the contract rates. A type the
 * contract gains without an entry here fails generation, so a new binding is
 * named on purpose instead of rendering as a raw identifier.
 */
const BINDING_LABELS = {
    ai: "Workers AI",
    analytics_engine: "Analytics Engine",
    artifacts: "Artifacts",
    assets: "Static assets",
    browser: "Browser Rendering",
    container: "Containers",
    d1: "D1",
    durable_object: "Durable Objects",
    hyperdrive: "Hyperdrive",
    images: "Images",
    kv: "KV",
    media: "Media Transformations",
    pipeline: "Pipelines",
    queue_consumer: "Queue consumers",
    queue_producer: "Queue producers",
    r2: "R2",
    stream: "Stream",
    vectorize: "Vectorize",
    vpc_network: "VPC networks",
    vpc_service: "VPC services",
    workflow: "Workflows",
};

/** What each `BindingSupport` value means to someone deploying. */
const SUPPORT_LABELS = {
    bound: "Yes",
    provisioned: "Yes — created for you",
    routed: "Yes — delivered by Lunora Cloud",
    unsupported: "No",
};

/** The order rows are listed in: what works first, what is refused last. */
const SUPPORT_ORDER = ["provisioned", "bound", "routed", "unsupported"];

// ---------------------------------------------------------------------------
// Reading the contract
// ---------------------------------------------------------------------------

const unwrap = (node) => {
    let current = node;

    while (ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isParenthesizedExpression(current) || ts.isTypeAssertionExpression(current)) {
        current = current.expression;
    }

    return current;
};

const propertyKey = (name) => {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) {
        return name.text;
    }

    throw new Error(`provision-contract.ts: unsupported property key ${name.getText()}`);
};

/**
 * Evaluate a literal expression from the contract. `constants` resolves
 * identifiers to the top-level variable initialisers of the same file.
 * @param node
 * @param constants
 */
const evaluate = (node, constants) => {
    const expression = unwrap(node);

    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
        return expression.text;
    }

    if (expression.kind === ts.SyntaxKind.TrueKeyword) {
        return true;
    }

    if (expression.kind === ts.SyntaxKind.FalseKeyword) {
        return false;
    }

    if (ts.isNumericLiteral(expression)) {
        return Number(expression.text);
    }

    if (ts.isArrayLiteralExpression(expression)) {
        return expression.elements.map((element) => evaluate(element, constants));
    }

    if (ts.isObjectLiteralExpression(expression)) {
        const result = {};

        for (const property of expression.properties) {
            if (!ts.isPropertyAssignment(property)) {
                throw new Error(`provision-contract.ts: unsupported object member ${property.getText()}`);
            }

            result[propertyKey(property.name)] = evaluate(property.initializer, constants);
        }

        return result;
    }

    if (ts.isIdentifier(expression)) {
        const initializer = constants.get(expression.text);

        if (initializer === undefined) {
            throw new Error(`provision-contract.ts: ${expression.text} is not a top-level constant of the file`);
        }

        return evaluate(initializer, constants);
    }

    throw new Error(`provision-contract.ts: cannot evaluate \`${expression.getText()}\` statically`);
};

/**
 * The four constants the pages are generated from, evaluated from `source`.
 * Pure, so a test can hand it an edited contract and assert the drift check fails.
 * @param source the text of `provision-contract.ts`
 */
const readContract = (source) => {
    const file = ts.createSourceFile("provision-contract.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const constants = new Map();

    for (const statement of file.statements) {
        if (ts.isVariableStatement(statement)) {
            for (const declaration of statement.declarationList.declarations) {
                if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined) {
                    constants.set(declaration.name.text, declaration.initializer);
                }
            }
        }
    }

    const read = (name) => {
        const initializer = constants.get(name);

        if (initializer === undefined) {
            throw new Error(`provision-contract.ts no longer declares \`${name}\`, which the cloud docs are generated from`);
        }

        return evaluate(initializer, constants);
    };

    return {
        bindingSupport: read("BINDING_SUPPORT"),
        targets: read("TARGETS"),
        tokenPermissions: read("CLOUDFLARE_TOKEN_PERMISSIONS"),
        unsupportedReasons: read("UNSUPPORTED_REASONS"),
    };
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Make contract prose safe inside an MDX table cell: `|` always, and the
 * characters MDX would read as JSX or an expression outside a code span.
 * @param text
 */
const cell = (text) =>
    text
        .split(/(`[^`]*`)/u)
        .map((part, index) => (index % 2 === 1 ? part : part.replaceAll(/[<>{}]/gu, (character) => `\\${character}`)))
        .join("")
        .replaceAll("|", String.raw`\|`);

/**
 * A contract reason, closed with a full stop. The wording is otherwise kept
 * verbatim — it is the text the deploy error and the studio show — so its first
 * letter is left alone too ("celld's …" must stay lowercase).
 * @param text
 */
const sentence = (text) => {
    const trimmed = text.trim();

    return /[.!?]$/u.test(trimmed) ? trimmed : `${trimmed}.`;
};

/**
 * The binding table and limitations list of one target.
 * @param contract the result of {@link readContract}
 * @param target a `TargetId`
 */
const targetCapabilitiesTable = (contract, target) => {
    const support = contract.bindingSupport[target];
    const reasons = contract.unsupportedReasons[target] ?? {};
    const descriptor = contract.targets[target];

    if (support === undefined || descriptor === undefined) {
        throw new Error(`provision-contract.ts has no target "${target}"`);
    }

    const rows = Object.entries(support)
        .map(([type, value]) => {
            const label = BINDING_LABELS[type];

            if (label === undefined) {
                throw new Error(`binding type "${type}" has no label: add it to BINDING_LABELS in ${path.relative(ROOT_DIR, fileURLToPath(import.meta.url))}`);
            }

            if (!(value in SUPPORT_LABELS)) {
                throw new Error(`binding support "${value}" has no label: add it to SUPPORT_LABELS`);
            }

            const reason = value === "unsupported" ? reasons[type] : undefined;

            if (value === "unsupported" && reason === undefined) {
                throw new Error(`${target} refuses "${type}" with no reason in UNSUPPORTED_REASONS`);
            }

            return { label, reason, type, value };
        })
        .sort((a, b) => SUPPORT_ORDER.indexOf(a.value) - SUPPORT_ORDER.indexOf(b.value) || a.label.localeCompare(b.label));

    const lines = [
        "| Binding | `wrangler` type | Available | Why not |",
        "| ------- | --------------- | --------- | ------- |",
        ...rows.map(
            (row) => `| ${row.label} | \`${row.type}\` | ${SUPPORT_LABELS[row.value]} | ${row.reason === undefined ? "" : cell(sentence(row.reason))} |`,
        ),
    ];

    if (descriptor.limitations.length > 0) {
        lines.push("", "Beyond bindings, this target does not have:", "");

        for (const limitation of descriptor.limitations) {
            lines.push(`- **${cell(limitation.label)}.** ${cell(sentence(limitation.reason))}`);
        }
    }

    return lines.join("\n");
};

/**
 * The permissions table for a `cloudflare-workers` token.
 * @param contract the result of {@link readContract}
 */
const tokenPermissionsTable = (contract) => {
    const entries = Object.values(contract.tokenPermissions).sort((a, b) => Number(b.required) - Number(a.required) || a.label.localeCompare(b.label));

    return [
        "| Permission | Needed | Used for |",
        "| ---------- | ------ | -------- |",
        ...entries.map((entry) => `| ${cell(entry.label)} | ${entry.required ? "Required" : "Optional"} | ${cell(entry.use)} |`),
    ].join("\n");
};

/** Every generated block, by page and marker id. */
const PAGES = [
    {
        blocks: [{ id: "capabilities:celld-vps", markdown: (contract) => targetCapabilitiesTable(contract, "celld-vps") }],
        file: "your-own-server.mdx",
    },
    {
        blocks: [
            { id: "cloudflare-token-permissions", markdown: tokenPermissionsTable },
            { id: "capabilities:cloudflare-workers", markdown: (contract) => targetCapabilitiesTable(contract, "cloudflare-workers") },
        ],
        file: "your-own-cloudflare-account.mdx",
    },
];

/**
 * Replace every marked block of `page` in `source`, then format through the
 * repo's Prettier config so the generator and `lint:prettier` agree.
 * @param page an entry of {@link PAGES}
 * @param source the page's current text
 * @param contract the result of {@link readContract}
 */
const buildPage = async (page, source, contract) => {
    let next = source;

    for (const block of page.blocks) {
        const start = next.indexOf(markerStart(block.id));
        const end = next.indexOf(markerEnd(block.id));

        if (start === -1 || end === -1 || end < start) {
            throw new Error(`${page.file} is missing the generated-block markers:\n  ${markerStart(block.id)}\n  ...\n  ${markerEnd(block.id)}`);
        }

        next = [next.slice(0, start + markerStart(block.id).length), "", block.markdown(contract), "", next.slice(end)].join("\n");
    }

    const filepath = path.join(CLOUD_DOCS_DIR, page.file);
    const options = await prettier.resolveConfig(filepath);

    return prettier.format(next, { ...options, filepath });
};

const main = async () => {
    const check = process.argv.includes("--check");
    const contract = readContract(await fs.readFile(CONTRACT_PATH, "utf8"));
    const stale = [];

    for (const page of PAGES) {
        const filepath = path.join(CLOUD_DOCS_DIR, page.file);
        const source = await fs.readFile(filepath, "utf8");
        const next = await buildPage(page, source, contract);

        if (source === next) {
            continue;
        }

        if (check) {
            stale.push(path.relative(ROOT_DIR, filepath));
        } else {
            await fs.writeFile(filepath, next);
            console.log(`Generated the capability tables in ${path.relative(ROOT_DIR, filepath)}.`);
        }
    }

    if (stale.length > 0) {
        process.stderr.write(
            `${stale.join(", ")} ${stale.length === 1 ? "is" : "are"} stale — apps/cloud/src/provision-contract.ts changed but the docs did not.\n` +
                `Regenerate and commit the result:\n\n  node apps/docs/scripts/generate-target-capabilities.js\n`,
        );
        process.exit(1);
    }
};

// The CLI half runs only when this file IS the entry point, so the drift test can import the pure halves.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    await main();
}

export { buildPage, CLOUD_DOCS_DIR, CONTRACT_PATH, markerEnd, markerStart, PAGES, readContract, targetCapabilitiesTable, tokenPermissionsTable };
