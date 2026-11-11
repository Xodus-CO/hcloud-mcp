/**
 * Live test for server ops (#17: rescue, console, root password) and metrics (#19),
 * driving the built MCP server (dist/index.js) against the real Hetzner API.
 *
 * COSTS MONEY (~1-2 cents: cheapest x86 server + lb11 for under an hour). Creates resources
 * labeled hcloud-mcp-test=<run-id>; the safety net in `finally` deletes only that run's resources.
 * Never prints passwords or console URLs (the wss_url embeds a token).
 *
 * Usage: HCLOUD_TOKEN=... node scripts/test-live-server-ops.mjs   (npm run build first)
 */
import "dotenv/config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const token = process.env.HCLOUD_TOKEN;
if (!token) { console.error("HCLOUD_TOKEN required"); process.exit(1); }

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const LABEL = { "hcloud-mcp-test": suffix };
const results = [];
const ok = (step, detail = "") => { results.push(["ok", step]); console.log(`ok   ${step}${detail ? " — " + detail : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const client = new Client({ name: "live-test", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...process.env, HCLOUD_TOKEN: token } }));

async function call(name, args = {}) {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content[0].text;
    if (r.isError) throw new Error(`${name} failed: ${text}`);
    try { return JSON.parse(text); } catch { return text; }
}

async function waitActions(resp, label) {
    if (!resp || typeof resp !== "object") return;
    const ids = [resp.action?.id, ...(resp.actions ?? []).map((a) => a.id), ...(resp.next_actions ?? []).map((a) => a.id)].filter(Boolean);
    for (const id of ids) {
        for (let i = 0; i < 120; i++) {
            const r = await call("get_action", { id });
            const a = r.action ?? r;
            if (a.status === "success") break;
            if (a.status === "error") {
                const err = new Error(`${label}: action ${id} error ${JSON.stringify(a.error)}`);
                err.actionError = a.error;
                throw err;
            }
            await sleep(2000);
            if (i === 119) throw new Error(`${label}: action ${id} timed out`);
        }
    }
}

async function rest(method, path, body) {
    const r = await fetch(`https://api.hetzner.cloud/v1${path}`, {
        method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
    });
    return r.status === 204 ? {} : r.json();
}

// Deletes only resources carrying this run's exact label.
async function safetyNetCleanup() {
    const sel = `label_selector=${encodeURIComponent(`hcloud-mcp-test=${suffix}`)}`;
    for (const lb of (await rest("GET", `/load_balancers?${sel}`)).load_balancers ?? []) await rest("DELETE", `/load_balancers/${lb.id}`);
    for (const s of (await rest("GET", `/servers?${sel}`)).servers ?? []) await rest("DELETE", `/servers/${s.id}`);
    await sleep(5000);
    const left = [];
    for (const [path, key] of [["/servers", "servers"], ["/load_balancers", "load_balancers"]]) {
        const items = (await rest("GET", `${path}?${sel}`))[key] ?? [];
        if (items.length) left.push(`${key}:${items.map((i) => i.id).join(",")}`);
    }
    return left;
}

// The project is shared with other live tests; on resource_limit_exceeded (e.g. Primary IP
// limit) wait for their teardown and retry instead of failing.
async function callRetryLimit(name, args) {
    for (let i = 0; ; i++) {
        try { return await call(name, args); }
        catch (e) {
            if (i >= 20 || !/Forbidden|resource_limit_exceeded/.test(e.message)) throw e;
            console.log(`     ${name}: ${e.message.slice(0, 80)} — retrying in 15s`);
            await sleep(15000);
        }
    }
}

const getServer = async (id) => { const r = await call("get_server", { id }); return r.server ?? r; };

let failed = null;
try {
    // --- Cheapest available x86 type in EU (same selection as test-live-lifecycle.mjs) ---
    const types = await call("list_server_types");
    const pr = await call("get_pricing");
    const pricing = pr.pricing ?? pr;
    const priceOf = (typeName, loc) => {
        const p = pricing.server_types.find((t) => t.name === typeName)?.prices.find((x) => x.location === loc);
        return p ? Number(p.price_hourly.gross) : Infinity;
    };
    const EU = ["fsn1", "nbg1", "hel1"];
    let best = null;
    for (const t of types) {
        if (t.architecture !== "x86") continue;
        for (const l of t.locations ?? []) {
            if (!EU.includes(l.name) || !l.available || l.deprecation) continue;
            const price = priceOf(t.name, l.name);
            if (!best || price < best.price) best = { type: t.name, location: l.name, price };
        }
    }
    if (!best) throw new Error("no available x86 type in EU");
    ok("select type/location", `${best.type} @ ${best.location} (€${best.price}/h)`);

    // --- Server ---
    const srvResp = await callRetryLimit("create_server", {
        name: `t-ops-${suffix}`, server_type: best.type, image: "ubuntu-24.04", location: best.location, labels: LABEL,
        public_net: { enable_ipv4: false, enable_ipv6: true }, // IPv6-only: one Primary IP, cheaper; nothing here needs v4
    });
    const srvId = srvResp.server.id;
    await waitActions(srvResp, "create_server");
    ok("create_server", `id ${srvId}`);

    // --- Load balancer (only for metrics) ---
    const lbResp = await callRetryLimit("create_load_balancer", { name: `t-ops-lb-${suffix}`, load_balancer_type: "lb11", location: best.location, labels: LABEL });
    const lbId = lbResp.load_balancer.id;
    await waitActions(lbResp, "create_lb");
    // No server target: an IPv6-only server is rejected as a public target ("cloud target was not
    // found"), and metrics don't need one.
    await waitActions(await call("add_load_balancer_service", {
        id: lbId, protocol: "tcp", listen_port: 22, destination_port: 22, proxyprotocol: false,
        health_check: { protocol: "tcp", port: 22, interval: 15, timeout: 10, retries: 3 },
    }), "add service");
    ok("create lb11 + tcp service", `lb ${lbId}`);

    // --- request_console ---
    const con = await call("request_console", { id: srvId });
    if (typeof con.wss_url !== "string" || !con.wss_url.startsWith("wss://")) throw new Error("request_console: no wss:// url");
    if (typeof con.password !== "string" || !con.password) throw new Error("request_console: no password");
    await waitActions(con, "request_console");
    ok("request_console", `wss_url wss://… + password returned, action ${con.action.command}`);

    // --- enable_rescue → disable_rescue (asserting rescue_enabled via get_server) ---
    const er = await call("enable_rescue", { id: srvId, type: "linux64" });
    if (!er.action?.id || er.action.command !== "enable_rescue") throw new Error(`enable_rescue: unexpected ${er.action?.command}`);
    if (typeof er.root_password !== "string" || !er.root_password) throw new Error("enable_rescue: no root_password");
    await waitActions(er, "enable_rescue");
    if ((await getServer(srvId)).rescue_enabled !== true) throw new Error("rescue_enabled not true after enable_rescue");
    ok("enable_rescue", "root_password returned, rescue_enabled=true");
    await waitActions(await call("disable_rescue", { id: srvId }), "disable_rescue");
    if ((await getServer(srvId)).rescue_enabled !== false) throw new Error("rescue_enabled not false after disable_rescue");
    ok("disable_rescue", "rescue_enabled=false");

    // --- reset_root_password (needs qemu guest agent in the running guest) ---
    for (let i = 0; i < 30 && (await getServer(srvId)).status !== "running"; i++) await sleep(2000);
    await sleep(45000); // boot grace so a failure reflects the image, not a guest still starting
    let rp;
    try {
        rp = await call("reset_root_password", { id: srvId });
    } catch (e) {
        // Synchronous rejection: must be a specific API error, not a tool/transport bug.
        const m = String(e.message).match(/Error: ([a-z_]+) \((\d{3})\)/);
        if (!m) throw e;
        ok("reset_root_password rejected by API", `${m[1]} (${m[2]})`);
    }
    if (rp) {
        if (!rp.action?.id || rp.action.command !== "reset_password") throw new Error(`reset_root_password: unexpected ${rp.action?.command}`);
        if (typeof rp.root_password !== "string" || !rp.root_password) throw new Error("reset_root_password: no root_password");
        try {
            await waitActions(rp, "reset_password");
            ok("reset_root_password", "Action succeeded, new root_password returned");
        } catch (e) {
            if (!e.actionError?.code) throw e;
            ok("reset_root_password Action failed (guest agent)", `${e.actionError.code}: ${e.actionError.message}`);
        }
    }

    // --- get_server_metrics: all three families in one call (verifies the type encoding) ---
    const sm = await call("get_server_metrics", { id: srvId, type: ["cpu", "disk", "network"], last_minutes: 10 });
    for (const key of ["cpu", "disk.0.iops.read", "network.0.bandwidth.in"]) {
        if (!sm.time_series?.[key]) throw new Error(`server metrics missing series ${key}: ${Object.keys(sm.time_series ?? {})}`);
        if (!sm.summary?.[key]) throw new Error(`server metrics summary missing ${key}`);
    }
    if (Object.keys(sm)[0] !== "summary") throw new Error("summary is not first key");
    ok("get_server_metrics(cpu,disk,network, last_minutes=10)", `${Object.keys(sm.time_series).length} series, step ${sm.step}s, cpu ${JSON.stringify(sm.summary.cpu)}`);

    const smCpu = await call("get_server_metrics", { id: srvId, type: ["cpu"], last_minutes: 10, include_values: false });
    if (smCpu.time_series !== undefined || !smCpu.summary?.cpu) throw new Error("include_values=false still returned time_series");
    ok("get_server_metrics(cpu, include_values=false)", "summary only");

    const endIso = new Date().toISOString();
    const startIso = new Date(Date.now() - 15 * 60_000).toISOString();
    const smRange = await call("get_server_metrics", { id: srvId, type: ["cpu"], start: startIso, end: endIso, step: 60 });
    if (smRange.step !== 60) throw new Error(`step not honored: ${smRange.step}`);
    ok("get_server_metrics(start/end ISO, step=60)", `${smRange.summary.cpu.points} points`);

    try { await call("get_server_metrics", { id: srvId, type: ["cpu"], start: startIso }); throw new Error("start without end accepted"); }
    catch (e) { if (!/both start and end/.test(e.message)) throw e; ok("get_server_metrics rejects start without end"); }

    // --- get_load_balancer_metrics ---
    const lm = await call("get_load_balancer_metrics", { id: lbId, type: ["requests_per_second", "open_connections", "bandwidth"], last_minutes: 10 });
    for (const key of ["requests_per_second", "open_connections", "bandwidth.in", "bandwidth.out"]) {
        if (!lm.time_series?.[key]) throw new Error(`lb metrics missing series ${key}: ${Object.keys(lm.time_series ?? {})}`);
    }
    ok("get_load_balancer_metrics(requests_per_second,open_connections,bandwidth)", `${Object.keys(lm.time_series).join(",")}; rps ${JSON.stringify(lm.summary.requests_per_second)}`);

    // --- Teardown via tools ---
    await waitActions(await call("delete_load_balancer", { id: lbId }), "delete_lb");
    await waitActions(await call("delete_server", { id: srvId }), "delete_server");
    ok("teardown via tools");
} catch (e) {
    failed = e;
    console.error(`FAIL ${e.message}`);
} finally {
    await client.close().catch(() => {});
    const left = await safetyNetCleanup();
    console.log(left.length ? `LEFTOVER RESOURCES: ${left.join(" ")}` : `cleanup verified: no hcloud-mcp-test=${suffix} resources remain`);
    console.log(`\n${results.length} steps passed${failed ? ", 1 failed" : ""}`);
    process.exit(failed || left.length ? 1 : 0);
}
