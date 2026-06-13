/**
 * `vis generate cirrus-container` — declare a Cloudflare Container in
 * cirrus/containers.ts and scaffold its Dockerfile.
 *
 * If containers.ts doesn't exist yet we write a fresh one. If it does, we
 * append one more `export const <name> = defineContainer({...})` declaration
 * (exports are order-independent, so a plain append is safe — unlike crons,
 * no AST surgery is needed). Either way a starter Dockerfile is scaffolded at
 * containers/<name>/Dockerfile following the platform rules: exec-form
 * ENTRYPOINT (so SIGTERM reaches the process during rolling deploys), an
 * EXPOSEd port (required by local dev), and a linux/amd64 base.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createTemplate } from "@visulima/vis/generate";

import { camelCase, kebabCase } from "./_helpers/case.js";

const DEFAULT_PORT = 8080;

const definitionFor = (exportName: string, directory: string): string => `/**
 * One Cloudflare Container instance class. \`cirrus dev\`/\`cirrus deploy\`
 * reconcile the wrangler \`containers[]\` entry + Durable Object binding, and
 * codegen wires \`ctx.containers.${exportName}\` onto actions.
 */
export const ${exportName} = defineContainer({
    image: "./${directory}", // directory containing the Dockerfile
    defaultPort: ${String(DEFAULT_PORT)},
    instanceType: "lite", // lite | basic | standard-1..4 | { vcpu, memoryMib, diskMb }
    maxInstances: 2, // cap concurrent running instances (and the .any() pool)
    sleepAfter: "5m", // idle timeout before the instance sleeps (scale-to-zero)
    // secrets: ["MY_API_KEY"], // Worker secrets forwarded into the container env
});
`;

const freshContainers = (exportName: string, directory: string): string => `import { defineContainer } from "@cirrus/container";

${definitionFor(exportName, directory)}`;

const dockerfile = (
    exportName: string,
): string => `# Container image for the \`${exportName}\` definition in cirrus/containers.ts.
# Cloudflare Containers run linux/amd64 images — keep the platform explicit so
# builds from Apple Silicon don't produce an arm64 image that fails at deploy.
FROM --platform=linux/amd64 node:22-slim

WORKDIR /app

COPY . .

# Local dev requires the listening port to be EXPOSEd (production exposes all ports).
EXPOSE ${String(DEFAULT_PORT)}

# Exec form (not shell form) so SIGTERM reaches the process — Cloudflare sends
# SIGTERM on rollouts and gives the container 15 minutes before SIGKILL.
ENTRYPOINT ["node", "server.mjs"]
`;

const starterServer = (exportName: string): string => `// Minimal HTTP server for the \`${exportName}\` container. Replace with your service.
import { createServer } from "node:http";

const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, path: request.url }));
});

server.listen(${String(DEFAULT_PORT)});

// Graceful shutdown: Cloudflare sends SIGTERM on rollouts and sleep.
process.on("SIGTERM", () => {
    server.close(() => process.exit(0));
});
`;

export default createTemplate({
    about: {
        description: "Declare a container in cirrus/containers.ts and scaffold its Dockerfile",
        name: "cirrus-container",
    },
    options: {
        name: {
            prompt: "Container name (e.g. transcoder)",
            required: true,
            type: "string",
        },
    },
    produce: ({ builtins, options }) => {
        const raw = String(options.name).trim();

        if (raw === "") {
            throw new Error("invalid container name: name must be a non-empty string");
        }

        const exportName = camelCase(raw);
        const directoryName = kebabCase(raw);
        const directory = `containers/${directoryName}`;
        const containersPath = join(builtins.dest_dir, "cirrus", "containers.ts");

        const dockerFiles = {
            containers: {
                [directoryName]: {
                    Dockerfile: dockerfile(exportName),
                    "server.mjs": starterServer(exportName),
                },
            },
        };

        const suggestions = [
            `Scaffolded ${directory}/Dockerfile (+ a starter server.mjs).`,
            "Re-export the generated classes from your worker entry: `export * from \"./cirrus/_generated/containers\"`.",
            "Run `cirrus codegen` (or just `cirrus dev`) to emit the Container class and reconcile wrangler.jsonc.",
        ];

        if (!existsSync(containersPath)) {
            return {
                files: { ...dockerFiles, cirrus: { "containers.ts": freshContainers(exportName, directory) } },
                suggestions: [`Created cirrus/containers.ts with container "${exportName}".`, ...suggestions],
            };
        }

        const original = readFileSync(containersPath, "utf8");

        if (new RegExp(String.raw`\bexport\s+const\s+${exportName}\b`, "u").test(original)) {
            throw new Error(`container "${exportName}" already exists in ${containersPath} — pick a different name.`);
        }

        const separator = original.endsWith("\n") ? "\n" : "\n\n";

        return {
            files: { ...dockerFiles, cirrus: { "containers.ts": `${original}${separator}${definitionFor(exportName, directory)}` } },
            filesMeta: { "cirrus/containers.ts": { force: true } },
            suggestions: [`Added container "${exportName}" to cirrus/containers.ts.`, ...suggestions],
        };
    },
});
