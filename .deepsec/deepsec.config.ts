import { defineConfig } from "deepsec/config";

export default defineConfig({
    projects: [
        { id: "lunora", root: ".." },
        // <deepsec:projects-insert-above>
    ],
});
