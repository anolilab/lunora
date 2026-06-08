import "./index.css";

import { StudioApp } from "@cirrus/studio";
import { createRoot } from "react-dom/client";

import { createDevMockClient } from "./mock/dev-client.js";

// Dev-only harness: render the full studio chrome against a backend-free mock
// client (see `mock/dev-client.ts`), so every panel paints with representative
// data for design/screenshot iteration. Reached at `/mock.html` in dev.
const element = document.querySelector("#root");

if (element === null) {
    throw new Error("main.mock: #root not found");
}

createRoot(element).render(<StudioApp client={createDevMockClient()} />);
