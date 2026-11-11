/**
 * Live test for the server / load balancer / network action-gap tools (issue #20):
 * drives the built MCP server (dist/index.js) against the real Hetzner API.
 *
 * COSTS MONEY (a few cents; Hetzner bills hourly): one cheapest x86 server, one lb11
 * (briefly lb21), a network and a placement group. Everything is labeled
 * hcloud-mcp-test=<run-id>; the REST safety net in `finally` deletes only resources
 * carrying that exact label.
 *
 * Usage: HCLOUD_TOKEN=... node scripts/test-live-action-gaps.mjs   (npm run build first)
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
            if (a.status === "error") throw new Error(`${label}: action ${id} error ${JSON.stringify(a.error)}`);
            await sleep(2000);
            if (i === 119) throw new Error(`${label}: action ${id} timed out`);
        }
    }
}

// Run an action tool, assert it returned an Action with the expected command, and wait for it.
async function act(name, args, command) {
    const resp = await call(name, args);
    if (!resp?.action?.id) throw new Error(`${name} returned no action: ${JSON.stringify(resp).slice(0, 200)}`);
    if (command && resp.action.command !== command) throw new Error(`${name}: expected command ${command}, got ${resp.action.command}`);
    await waitActions(resp, name);
    return resp;
}

async function rest(method, path, body) {
    const r = await fetch(`https://api.hetzner.cloud/v1${path}`, {
        method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
    });
    return r.status === 204 ? {} : r.json();
}

async function safetyNetCleanup() {
    const sel = `label_selector=${encodeURIComponent(`hcloud-mcp-test=${suffix}`)}`;
    for (const lb of (await rest("GET", `/load_balancers?${sel}`)).load_balancers ?? []) await rest("DELETE", `/load_balancers/${lb.id}`);
    for (const s of (await rest("GET", `/servers?${sel}`)).servers ?? []) await rest("DELETE", `/servers/${s.id}`);
    await sleep(10000);
    for (const pg of (await rest("GET", `/placement_groups?${sel}`)).placement_groups ?? []) await rest("DELETE", `/placement_groups/${pg.id}`);
    for (const n of (await rest("GET", `/networks?${sel}`)).networks ?? []) await rest("DELETE", `/networks/${n.id}`);
    const left = [];
    for (const [path, key] of [["/servers", "servers"], ["/load_balancers", "load_balancers"], ["/placement_groups", "placement_groups"], ["/networks", "networks"]]) {
        const items = (await rest("GET", `${path}?${sel}`))[key] ?? [];
        if (items.length) left.push(`${key}:${items.map((i) => i.id).join(",")}`);
    }
    return left;
}

let failed = null;
try {
    // --- list_isos (no resources needed) ---
    const allIsos = await call("list_isos");
    if (!Array.isArray(allIsos) || allIsos.length === 0) throw new Error("list_isos returned nothing");
    const x86 = await call("list_isos", { architecture: "x86" });
    if (x86.some((i) => i.architecture !== "x86")) throw new Error("architecture filter leaked non-x86 ISOs");
    const withWild = await call("list_isos", { architecture: "x86", include_architecture_wildcard: true });
    if (withWild.length < x86.length) throw new Error("wildcard include returned fewer ISOs");
    const one = await call("list_isos", { name: allIsos[0].name });
    if (one.length !== 1 || one[0].id !== allIsos[0].id) throw new Error(`name filter: ${JSON.stringify(one).slice(0, 200)}`);
    ok("list_isos (all pages, architecture, wildcard, exact name)", `${allIsos.length} total, ${x86.length} x86, ${withWild.length} x86+wildcard`);

    // --- Pick cheapest available x86 type in EU (same selection as test-live-lifecycle) ---
    const types = await call("list_server_types");
    const pr = await call("get_pricing");
    const pricing = pr.pricing ?? pr;
    const priceOf = (typeName, loc) => {
        const p = pricing.server_types.find((t) => t.name === typeName)?.prices.find((x) => x.location === loc);
        return p ? Number(p.price_hourly.gross) : Infinity;
    };
    let best = null;
    for (const t of types) {
        if (t.architecture !== "x86") continue;
        for (const l of t.locations ?? []) {
            if (!["fsn1", "nbg1", "hel1"].includes(l.name) || !l.available || l.deprecation) continue;
            const price = priceOf(t.name, l.name);
            if (!best || price < best.price) best = { type: t.name, location: l.name, price };
        }
    }
    if (!best) throw new Error("no available x86 type in EU");
    ok("select type/location", `${best.type} @ ${best.location} (€${best.price}/h)`);

    // --- Network + subnet, placement group, server, LB ---
    const net = (await call("create_network", { name: `t-net-${suffix}`, ip_range: "10.88.0.0/16", labels: LABEL })).network;
    await waitActions(await call("add_network_subnet", { id: net.id, type: "cloud", network_zone: "eu-central", ip_range: "10.88.1.0/24" }), "subnet");
    const pg = (await call("create_placement_group", { name: `t-pg-${suffix}`, type: "spread", labels: LABEL })).placement_group;
    const srvResp = await call("create_server", {
        name: `t-srv-${suffix}`, server_type: best.type, image: "ubuntu-24.04", location: best.location,
        // Private-only: no Primary IPs, so the run fits under tight project primary_ip limits.
        networks: [net.id], public_net: { enable_ipv4: false, enable_ipv6: false }, labels: LABEL,
    });
    const srv = srvResp.server;
    const lbResp = await call("create_load_balancer", { name: `t-lb-${suffix}`, load_balancer_type: "lb11", location: best.location, labels: LABEL });
    const lbId = lbResp.load_balancer.id;
    await waitActions(srvResp, "create_server");
    await waitActions(lbResp, "create_lb");
    ok("create network/subnet, placement group, server, lb11", `net ${net.id}, pg ${pg.id}, server ${srv.id}, lb ${lbId}`);

    // --- Placement group: add (server must be off), remove ---
    try {
        await call("add_server_to_placement_group", { id: srv.id, placement_group: pg.id });
        throw new Error("add_server_to_placement_group on a running server unexpectedly succeeded");
    } catch (e) {
        if (!/server_not_stopped/.test(String(e.message))) throw e;
        ok("add_server_to_placement_group rejected while running", "server_not_stopped");
    }
    await act("power_off_server", { id: srv.id });
    await act("add_server_to_placement_group", { id: srv.id, placement_group: pg.id }, "add_to_placement_group");
    let s = await call("get_server", { id: srv.id });
    if (s.placement_group?.id !== pg.id) throw new Error(`placement_group not set: ${JSON.stringify(s.placement_group)}`);
    const pgAfter = (await call("list_placement_groups")).find((x) => x.id === pg.id);
    if (!pgAfter?.servers?.includes(srv.id)) throw new Error(`pg.servers missing server: ${JSON.stringify(pgAfter?.servers)}`);
    ok("add_server_to_placement_group (powered off)", `server.placement_group=${pg.id}`);
    await act("power_on_server", { id: srv.id });
    let removedWhileRunning = true;
    try {
        await act("remove_server_from_placement_group", { id: srv.id }, "remove_from_placement_group");
    } catch (e) {
        if (!/server_not_stopped/.test(String(e.message))) throw e;
        removedWhileRunning = false;
        await act("power_off_server", { id: srv.id });
        await act("remove_server_from_placement_group", { id: srv.id }, "remove_from_placement_group");
        await act("power_on_server", { id: srv.id });
    }
    s = await call("get_server", { id: srv.id });
    if (s.placement_group) throw new Error(`placement_group still set: ${JSON.stringify(s.placement_group)}`);
    ok("remove_server_from_placement_group", removedWhileRunning ? "works while running" : "required server off");

    // --- Alias IPs: set, then clear ---
    const privIp = s.private_net.find((p) => p.network === net.id)?.ip;
    if (!privIp) throw new Error(`server not on network: ${JSON.stringify(s.private_net)}`);
    await act("change_server_alias_ips", { id: srv.id, network: net.id, alias_ips: ["10.88.1.50", "10.88.1.51"] }, "change_alias_ips");
    s = await call("get_server", { id: srv.id });
    const aliases = s.private_net.find((p) => p.network === net.id)?.alias_ips ?? [];
    if (!(aliases.includes("10.88.1.50") && aliases.includes("10.88.1.51"))) throw new Error(`alias IPs not applied: ${JSON.stringify(aliases)}`);
    await act("change_server_alias_ips", { id: srv.id, network: net.id, alias_ips: ["10.88.1.51"] }, "change_alias_ips");
    s = await call("get_server", { id: srv.id });
    const aliases2 = s.private_net.find((p) => p.network === net.id)?.alias_ips ?? [];
    if (aliases2.length !== 1 || aliases2[0] !== "10.88.1.51") throw new Error(`alias replace semantics: ${JSON.stringify(aliases2)}`);
    ok("change_server_alias_ips (set two, then replace with one)", `primary ${privIp}, aliases ${JSON.stringify(aliases2)}`);

    // --- Network routes ---
    await act("add_network_route", { id: net.id, destination: "10.100.0.0/24", gateway: privIp }, "add_route");
    let n = await call("get_network", { id: net.id });
    if (!n.routes?.some((r) => r.destination === "10.100.0.0/24" && r.gateway === privIp)) throw new Error(`route missing: ${JSON.stringify(n.routes)}`);
    ok("add_network_route", `10.100.0.0/24 via ${privIp}`);
    await act("delete_network_route", { id: net.id, destination: "10.100.0.0/24", gateway: privIp }, "delete_route");
    n = await call("get_network", { id: net.id });
    if (n.routes?.length) throw new Error(`route not deleted: ${JSON.stringify(n.routes)}`);
    ok("delete_network_route");

    // --- Load balancer: algorithm, network, public interface, type ---
    await act("change_load_balancer_algorithm", { id: lbId, type: "least_connections" }, "change_algorithm");
    let lb = await call("get_load_balancer", { id: lbId });
    if (lb.algorithm?.type !== "least_connections") throw new Error(`algorithm: ${JSON.stringify(lb.algorithm)}`);
    ok("change_load_balancer_algorithm", "least_connections");

    try {
        await call("disable_load_balancer_public_interface", { id: lbId });
        throw new Error("disable public interface without network unexpectedly succeeded");
    } catch (e) {
        if (!/load_balancer_not_attached_to_network/.test(String(e.message))) throw e;
        ok("disable_load_balancer_public_interface rejected without network", "load_balancer_not_attached_to_network");
    }

    await act("attach_load_balancer_to_network", { id: lbId, network: net.id, ip: "10.88.1.10", ip_range: "10.88.1.0/24" }, "attach_to_network");
    lb = await call("get_load_balancer", { id: lbId });
    const lbPriv = lb.private_net?.find((p) => p.network === net.id);
    if (lbPriv?.ip !== "10.88.1.10") throw new Error(`lb private_net: ${JSON.stringify(lb.private_net)}`);
    ok("attach_load_balancer_to_network (ip + ip_range)", `private ip ${lbPriv.ip}`);

    await act("disable_load_balancer_public_interface", { id: lbId }, "disable_public_interface");
    lb = await call("get_load_balancer", { id: lbId });
    if (lb.public_net?.enabled !== false) throw new Error(`public_net.enabled: ${JSON.stringify(lb.public_net)}`);
    ok("disable_load_balancer_public_interface", "public_net.enabled=false");
    await act("enable_load_balancer_public_interface", { id: lbId }, "enable_public_interface");
    lb = await call("get_load_balancer", { id: lbId });
    if (lb.public_net?.enabled !== true) throw new Error(`public_net.enabled: ${JSON.stringify(lb.public_net)}`);
    ok("enable_load_balancer_public_interface", "public_net.enabled=true");

    await act("change_load_balancer_type", { id: lbId, load_balancer_type: "lb21" }, "change_load_balancer_type");
    lb = await call("get_load_balancer", { id: lbId });
    if (lb.load_balancer_type?.name !== "lb21") throw new Error(`lb type: ${JSON.stringify(lb.load_balancer_type?.name)}`);
    ok("change_load_balancer_type", "lb11 -> lb21");

    await act("detach_load_balancer_from_network", { id: lbId, network: net.id }, "detach_from_network");
    lb = await call("get_load_balancer", { id: lbId });
    if (lb.private_net?.length) throw new Error(`lb still attached: ${JSON.stringify(lb.private_net)}`);
    ok("detach_load_balancer_from_network");

    // --- change_network_ip_range: must fail with members, succeed after detaching the server ---
    try {
        await act("change_network_ip_range", { id: net.id, ip_range: "10.88.0.0/15" });
        throw new Error("change_network_ip_range with attached server unexpectedly succeeded");
    } catch (e) {
        if (/unexpectedly succeeded/.test(String(e.message))) throw e;
        ok("change_network_ip_range rejected with attached member", String(e.message).slice(0, 120));
    }
    await act("detach_server_from_network", { id: srv.id, network: net.id });
    await act("change_network_ip_range", { id: net.id, ip_range: "10.88.0.0/15" }, "change_ip_range");
    n = await call("get_network", { id: net.id });
    if (n.ip_range !== "10.88.0.0/15") throw new Error(`ip_range: ${n.ip_range}`);
    ok("change_network_ip_range", "10.88.0.0/16 -> 10.88.0.0/15");

    // --- Teardown via tools ---
    await waitActions(await call("delete_load_balancer", { id: lbId }), "delete_lb");
    await waitActions(await call("delete_server", { id: srv.id }), "delete_server");
    await call("delete_placement_group", { id: pg.id });
    await call("delete_network", { id: net.id });
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
