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
 * `apps/cloud` for a build to follow. The evaluator below handles exactly:
 * literals; `as` / `as const` / `satisfies` wrappers; object spreads; references
 * to top-level constants — of the contract, or imported from a module listed in
 * {@link MODULE_SOURCES} (the `celld-vps` row is `@lunora/config/celld`'s
 * `CELLD_RELEASE_BINDINGS`), followed through relative re-exports; and the one
 * call shape the contract builds a row with,
 * `Object.fromEntries(Object.keys(X).map((key) => [key, value]))`. It throws on
 * anything else rather than guessing.
 *
 * Usage:
 *   node apps/docs/scripts/generate-target-capabilities.js
 *   node apps/docs/scripts/generate-target-capabilities.js --check
 *
 * `__tests__/target-capabilities.test.ts` re-renders both pages and fails when
 * a committed page does not match, and `--check` is the same comparison from
 * the command line.
 */
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import prettier from "prettier";
import ts from "typescript";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ROOT_DIR = path.resolve(__dirname, "..", "..", "..");
const CONTRACT_PATH = path.join(ROOT_DIR, "apps", "cloud", "src", "provision-contract.ts");

/**
 * The packages whose constants the contract may import, by specifier → the
 * source file of that entry point. Anything else the contract imports a value
 * from fails generation, naming the specifier to add here.
 */
const MODULE_SOURCES = {
    "@lunora/config/celld": path.join(ROOT_DIR, "packages", "config", "src", "celld", "index.ts"),
};
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
    ai_search: "AI Search",
    ai_search_namespace: "AI Search namespaces",
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
    service: "Service bindings",
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

const propertyKey = (name, where) => {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) {
        return name.text;
    }

    throw new Error(`${where}: unsupported property key ${name.getText()}`);
};

const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * One source file's top level, as the evaluator needs it: its constants, the
 * values it imports and the names it re-exports from another module.
 * @param source the file's text
 * @param filePath where it lives — what its relative specifiers resolve against
 */
const parseModule = (source, filePath) => {
    const file = ts.createSourceFile(path.basename(filePath), source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const constants = new Map();
    const imports = new Map();
    const reexports = new Map();

    for (const statement of file.statements) {
        if (ts.isVariableStatement(statement)) {
            for (const declaration of statement.declarationList.declarations) {
                if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined) {
                    constants.set(declaration.name.text, declaration.initializer);
                }
            }
        } else if (ts.isImportDeclaration(statement) && !statement.importClause?.isTypeOnly) {
            const bindings = statement.importClause?.namedBindings;

            if (bindings !== undefined && ts.isNamedImports(bindings)) {
                for (const element of bindings.elements.filter((candidate) => !candidate.isTypeOnly)) {
                    imports.set(element.name.text, { name: (element.propertyName ?? element.name).text, specifier: statement.moduleSpecifier.text });
                }
            }
        } else if (
            ts.isExportDeclaration(statement) &&
            !statement.isTypeOnly &&
            statement.moduleSpecifier !== undefined &&
            statement.exportClause !== undefined &&
            ts.isNamedExports(statement.exportClause)
        ) {
            for (const element of statement.exportClause.elements) {
                reexports.set(element.name.text, { name: (element.propertyName ?? element.name).text, specifier: statement.moduleSpecifier.text });
            }
        }
    }

    return { constants, filePath, imports, reexports, where: path.relative(ROOT_DIR, filePath) };
};

/**
 * The source file a specifier names: a relative one beside `fromPath`, a
 * package one only when {@link MODULE_SOURCES} lists it.
 * @param specifier
 * @param fromPath
 * @param readFile reads a file's text by absolute path
 */
const resolveModulePath = (specifier, fromPath, readFile) => {
    if (!specifier.startsWith(".")) {
        const listed = MODULE_SOURCES[specifier];

        if (listed === undefined) {
            throw new Error(
                `${path.relative(ROOT_DIR, fromPath)} imports a value from "${specifier}", which the docs generator does not read: add its source file to MODULE_SOURCES`,
            );
        }

        return listed;
    }

    const base = path.resolve(path.dirname(fromPath), specifier);

    for (const candidate of [`${base}.ts`, path.join(base, "index.ts")]) {
        try {
            readFile(candidate);

            return candidate;
        } catch {
            // Not this one.
        }
    }

    throw new Error(`${path.relative(ROOT_DIR, fromPath)}: cannot find the module "${specifier}"`);
};

/**
 * Evaluate a literal expression from a module. Identifiers resolve to the
 * arrow parameter in scope (`locals`), then the module's top-level constants,
 * then the values it imports.
 * @param node
 * @param context `{ module, load, locals }` — the module the node is in, a loader of other modules by path, and arrow parameters in scope
 */
const evaluate = (node, context) => {
    const expression = unwrap(node);
    const { where } = context.module;

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
        return expression.elements.map((element) => evaluate(element, context));
    }

    if (ts.isObjectLiteralExpression(expression)) {
        const result = {};

        for (const property of expression.properties) {
            if (ts.isSpreadAssignment(property)) {
                const spread = evaluate(property.expression, context);

                if (!isPlainObject(spread)) {
                    throw new Error(`${where}: \`${property.getText()}\` does not spread an object`);
                }

                Object.assign(result, spread);
            } else if (ts.isPropertyAssignment(property)) {
                result[propertyKey(property.name, where)] = evaluate(property.initializer, context);
            } else {
                throw new Error(`${where}: unsupported object member ${property.getText()}`);
            }
        }

        return result;
    }

    if (ts.isIdentifier(expression)) {
        return resolveIdentifier(expression.text, context);
    }

    if (ts.isCallExpression(expression)) {
        return evaluateCall(expression, context);
    }

    throw new Error(`${where}: cannot evaluate \`${expression.getText()}\` statically`);
};

/**
 * The calls a contract table may be built with — `Object.fromEntries(…)`,
 * `Object.keys(…)` and `array.map((key) => …)` with an expression body — and
 * nothing else.
 * @param expression a call expression
 * @param context see {@link evaluate}
 */
const evaluateCall = (expression, context) => {
    const callee = expression.expression;
    const { where } = context.module;
    const unsupported = () => new Error(`${where}: cannot evaluate \`${expression.getText()}\` statically`);

    if (!ts.isPropertyAccessExpression(callee) || expression.arguments.length !== 1) {
        throw unsupported();
    }

    const [argument] = expression.arguments;
    const method = callee.name.text;
    const onObject = ts.isIdentifier(callee.expression) && callee.expression.text === "Object" && !context.locals.has("Object");

    if (onObject && method === "keys") {
        const value = evaluate(argument, context);

        if (!isPlainObject(value)) {
            throw unsupported();
        }

        return Object.keys(value);
    }

    if (onObject && method === "fromEntries") {
        const entries = evaluate(argument, context);

        if (!Array.isArray(entries) || !entries.every((entry) => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string")) {
            throw unsupported();
        }

        return Object.fromEntries(entries);
    }

    if (!onObject && method === "map" && ts.isArrowFunction(argument)) {
        const [parameter, ...rest] = argument.parameters;

        if (parameter === undefined || rest.length > 0 || !ts.isIdentifier(parameter.name) || ts.isBlock(argument.body)) {
            throw unsupported();
        }

        const receiver = evaluate(callee.expression, context);

        if (!Array.isArray(receiver)) {
            throw unsupported();
        }

        return receiver.map((element) => evaluate(argument.body, { ...context, locals: new Map([...context.locals, [parameter.name.text, element]]) }));
    }

    throw unsupported();
};

/**
 * An identifier's value: an arrow parameter in scope, a top-level constant of
 * the module, or a value it imports — followed into the module that declares it.
 * @param name
 * @param context see {@link evaluate}
 */
const resolveIdentifier = (name, context) => {
    if (context.locals.has(name)) {
        return context.locals.get(name);
    }

    const { module } = context;
    const initializer = module.constants.get(name);

    if (initializer !== undefined) {
        return evaluate(initializer, context);
    }

    const imported = module.imports.get(name);

    if (imported === undefined) {
        throw new Error(`${module.where}: ${name} is not a top-level constant of the file`);
    }

    return resolveExport(context.load(resolveModulePath(imported.specifier, module.filePath, context.readFile)), imported.name, context);
};

/**
 * The value module `target` exports as `name`: one of its own constants, or
 * one it re-exports or imports from another module, followed there.
 * @param target a module from {@link parseModule}
 * @param name
 * @param context see {@link evaluate}
 */
const resolveExport = (target, name, context) => {
    const inTarget = { ...context, locals: new Map(), module: target };

    if (target.constants.has(name)) {
        return evaluate(target.constants.get(name), inTarget);
    }

    const forwarded = target.reexports.get(name) ?? target.imports.get(name);

    if (forwarded === undefined) {
        throw new Error(`${target.where} does not export a constant \`${name}\``);
    }

    return resolveExport(context.load(resolveModulePath(forwarded.specifier, target.filePath, context.readFile)), forwarded.name, context);
};

/**
 * The four constants the pages are generated from, evaluated from `source`.
 * Pure over its inputs, so a test can hand it an edited contract and assert the drift check fails.
 * @param source the text of `provision-contract.ts`
 * @param readFile reads a module the contract imports from, by absolute path
 */
const readContract = (source, readFile = (filePath) => readFileSync(filePath, "utf8")) => {
    const modules = new Map();
    const load = (filePath) => {
        if (!modules.has(filePath)) {
            modules.set(filePath, parseModule(readFile(filePath), filePath));
        }

        return modules.get(filePath);
    };
    const contract = parseModule(source, CONTRACT_PATH);
    const context = { load, locals: new Map(), module: contract, readFile };

    const read = (name) => {
        const initializer = contract.constants.get(name);

        if (initializer === undefined) {
            throw new Error(`provision-contract.ts no longer declares \`${name}\`, which the cloud docs are generated from`);
        }

        return evaluate(initializer, context);
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

export {
    buildPage,
    CLOUD_DOCS_DIR,
    CONTRACT_PATH,
    markerEnd,
    markerStart,
    MODULE_SOURCES,
    PAGES,
    readContract,
    targetCapabilitiesTable,
    tokenPermissionsTable,
};
