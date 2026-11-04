// Runs the named root scripts at the same time and exits non-zero if any of them
// fails. Each script keeps its own output; a failure lists the scripts that failed.
import { spawn } from "node:child_process";

const scripts = process.argv.slice(2);

if (scripts.length === 0) {
    console.error("usage: run-lint-parallel.mjs <script> [<script>...]");
    process.exit(2);
}

const results = await Promise.all(
    scripts.map(
        (name) =>
            new Promise((resolve) => {
                const child = spawn("pnpm", ["run", name], { stdio: "inherit" });

                child.on("error", () => resolve({ name, code: 1 }));
                child.on("close", (code) => resolve({ name, code: code ?? 1 }));
            }),
    ),
);

const failed = results.filter((result) => result.code !== 0).map((result) => result.name);

if (failed.length > 0) {
    console.error(`Failed: ${failed.join(", ")}`);
    process.exit(1);
}
