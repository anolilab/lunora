// WebSocket-through-dispatch spike probe (CLOUD-PLAN.md §6 risk #3).
//
// Drives the deployed spike tenant THROUGH the cloud dispatcher and reports
// whether the hibernated-WS subscription path and per-invocation CPU limits
// behave. Zero deps — uses Node 22's global `WebSocket` and `fetch`.
//
//   node probe.mjs https://ws-spike.<your-app-domain>
//
// Exit code 0 = all hard assertions passed; 1 = a failure (the burn/limit probe
// is reported, not asserted — its threshold is informational).

const base = process.argv[2];

if (!base) {
    console.error("usage: node probe.mjs https://<script>.<app-domain>");
    process.exit(2);
}

const wsUrl = `${base.replace(/^http/u, "ws")}/ws`;
const results = [];
const record = (name, ok, detail) => {
    results.push({ detail, name, ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const withTimeout = (promise, ms, label) =>
    Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms: ${label}`)), ms))]);

const openSocket = () =>
    new Promise((resolve, reject) => {
        const socket = new WebSocket(wsUrl);
        socket.addEventListener("open", () => resolve(socket), { once: true });
        socket.addEventListener("error", (event) => reject(new Error(`ws error: ${event.message ?? "unknown"}`)), { once: true });
    });

const nextMessage = (socket) =>
    new Promise((resolve, reject) => {
        socket.addEventListener("message", (event) => resolve(String(event.data)), { once: true });
        socket.addEventListener("close", (event) => reject(new Error(`socket closed (${event.code})`)), { once: true });
    });

const main = async () => {
    console.log(`probing ${base}\n`);

    // 1. Upgrade survives the dispatch hop.
    let socket;
    try {
        socket = await withTimeout(openSocket(), 10_000, "ws open");
        record("websocket upgrade through dispatch", true, "101 + live socket");
    } catch (error) {
        record("websocket upgrade through dispatch", false, error.message);
        finish();
        return;
    }

    // 2. Hibernated message handler runs (echo).
    try {
        const echoed = nextMessage(socket);
        socket.send("ping");
        const reply = await withTimeout(echoed, 10_000, "echo");
        const ok = reply.includes('"type":"echo"') && reply.includes("ping");
        record("hibernated webSocketMessage echo", ok, reply);
    } catch (error) {
        record("hibernated webSocketMessage echo", false, error.message);
    }

    // 3. Server push (broadcast) reaches the socket — the mutation→subscription shape.
    try {
        const pushed = nextMessage(socket);
        const response = await fetch(`${base}/broadcast`, { body: "hello-subscribers", method: "POST" });
        const summary = await response.json();
        const frame = await withTimeout(pushed, 10_000, "push");
        const ok = frame.includes('"type":"push"') && frame.includes("hello-subscribers");
        record("server push through dispatch", ok, `delivered=${summary.delivered}; frame=${frame}`);
    } catch (error) {
        record("server push through dispatch", false, error.message);
    }

    socket.close();

    // 4. Per-invocation CPU limit probe (informational): find where /burn starts
    //    being killed by the dispatcher's { limits: { cpuMs } }.
    console.log("\ncpuMs limit probe (informational — dispatcher caps free tier at 50ms):");
    for (const ms of [5, 25, 50, 100, 250, 500, 1000]) {
        try {
            // eslint-disable-next-line no-await-in-loop -- sequential probe by design
            const response = await withTimeout(fetch(`${base}/burn?ms=${ms}`), 15_000, `burn ${ms}`);
            console.log(`  burn ${String(ms).padStart(4)}ms → HTTP ${response.status}`);
        } catch (error) {
            console.log(`  burn ${String(ms).padStart(4)}ms → ${error.message}`);
        }
    }

    finish();
};

const finish = () => {
    const failed = results.filter((entry) => !entry.ok);
    console.log(`\n${results.length - failed.length}/${results.length} hard checks passed`);
    process.exit(failed.length > 0 ? 1 : 0);
};

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
