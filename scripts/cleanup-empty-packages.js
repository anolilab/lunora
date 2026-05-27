/**
 * This script is used to cleanup empty packages in the `packages` directory.
 *
 * Modified copy of https://github.com/TanStack/router/blob/main/scripts/cleanup-empty-packages.mjs
 *
 * MIT License
 * Copyright (c) 2021-present Tanner Linsley
 */

import { readdir, existsSync, rm } from "node:fs";
import { join } from "node:path";

const packagesDir = join(import.meta.dirname, "..", "packages");

readdir(packagesDir, { withFileTypes: true }, (err, entries) => {
    if (err) {
        console.error("Error reading directory:", err);
        return;
    }

    entries.forEach((entry) => {
        if (entry.isDirectory()) {
            const packageJsonPath = join(packagesDir, entry.name, "package.json");

            if (!existsSync(packageJsonPath)) {
                const dirPath = join(packagesDir, entry.name);

                rm(dirPath, { recursive: true }, (err) => {
                    if (err) {
                        console.error(`❌ Error deleting directory ${dirPath}:`, err);
                    } else {
                        console.log(`✅ Deleted directory: ${dirPath}`);
                    }
                });
            }
        }
    });
});
