/**
 * Live lifecycle test: drives the built MCP server (dist/index.js) through a full
 * create → modify → teardown cycle against the real Hetzner API.
 *
 * COSTS MONEY (a few cents; Hetzner bills hourly). Creates resources labeled
 * hcloud-mcp-test=<run-id> and always cleans up only that run's resources via a REST safety net in `finally`.
 *
 * Usage: HCLOUD_TOKEN=... node scripts/test-live-lifecycle.mjs   (npm run build first)
 */
import "dotenv/config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const token = process.env.HCLOUD_TOKEN;
if (!token) { console.error("HCLOUD_TOKEN required"); process.exit(1); }

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
// Unique per run so the safety-net cleanup only ever touches this run's resources.
const LABEL = { "hcloud-mcp-test": suffix };
const results = [];
const ok = (step, detail = "") => { results.push(["ok", step]); console.log(`ok   ${step}${detail ? " — " + detail : ""}`); };

const client = new Client({ name: "live-test", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...process.env, HCLOUD_TOKEN: token } }));

async function call(name, args = {}) {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content[0].text;
    if (r.isError) throw new Error(`${name} failed: ${text}`);
    try { return JSON.parse(text); } catch { return text; }
}

// Collect every Action id in a response (action / actions / next_actions) and poll until done.
async function waitActions(resp, label) {
    if (!resp || typeof resp !== "object") return;
    const ids = [resp.action?.id, ...(resp.actions ?? []).map((a) => a.id), ...(resp.next_actions ?? []).map((a) => a.id)].filter(Boolean);
    for (const id of ids) {
        for (let i = 0; i < 120; i++) {
            const r = await call("get_action", { id });
            const a = r.action ?? r;
            if (a.status === "success") break;
            if (a.status === "error") throw new Error(`${label}: action ${id} error ${JSON.stringify(a.error)}`);
            await new Promise((r) => setTimeout(r, 2000));
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

async function safetyNetCleanup() {
    const sel = `label_selector=${encodeURIComponent(`hcloud-mcp-test=${suffix}`)}`;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (const lb of (await rest("GET", `/load_balancers?${sel}`)).load_balancers ?? []) await rest("DELETE", `/load_balancers/${lb.id}`);
    for (const v of (await rest("GET", `/volumes?${sel}`)).volumes ?? []) { if (v.server) { await rest("POST", `/volumes/${v.id}/actions/detach`); await sleep(5000); } await rest("DELETE", `/volumes/${v.id}`); }
    for (const f of (await rest("GET", `/floating_ips?${sel}`)).floating_ips ?? []) { if (f.server) { await rest("POST", `/floating_ips/${f.id}/actions/unassign`); await sleep(3000); } await rest("DELETE", `/floating_ips/${f.id}`); }
    for (const s of (await rest("GET", `/servers?${sel}`)).servers ?? []) await rest("DELETE", `/servers/${s.id}`);
    await sleep(10000);
    for (const p of (await rest("GET", `/primary_ips?${sel}`)).primary_ips ?? []) { if (p.assignee_id) continue; await rest("DELETE", `/primary_ips/${p.id}`); }
    for (const fw of (await rest("GET", `/firewalls?${sel}`)).firewalls ?? []) await rest("DELETE", `/firewalls/${fw.id}`);
    for (const n of (await rest("GET", `/networks?${sel}`)).networks ?? []) await rest("DELETE", `/networks/${n.id}`);
    const left = [];
    for (const [path, key] of [["/servers", "servers"], ["/load_balancers", "load_balancers"], ["/volumes", "volumes"], ["/floating_ips", "floating_ips"], ["/primary_ips", "primary_ips"], ["/firewalls", "firewalls"], ["/networks", "networks"]]) {
        const items = (await rest("GET", `${path}?${sel}`))[key] ?? [];
        if (items.length) left.push(`${key}:${items.map((i) => i.id).join(",")}`);
    }
    return left;
}

let failed = null;
try {
    // --- Pick location / type / image the way the skill says ---
    const types = await call("list_server_types");
    const pr = await call("get_pricing");
    const pricing = pr.pricing ?? pr;
    const priceOf = (typeName, loc) => {
        const st = pricing.server_types.find((t) => t.name === typeName);
        const p = st?.prices.find((x) => x.location === loc);
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
    const images = await call("list_images");
    const image = images.find((i) => i.name === "ubuntu-24.04" && i.architecture === "x86" && !i.deprecation);
    if (!image) throw new Error("ubuntu-24.04 x86 not found");
    ok("select type/location/image", `${best.type} @ ${best.location} (€${best.price}/h), ${image.name}`);

    // --- Network + subnet ---
    const net = (await call("create_network", { name: `t-net-${suffix}`, ip_range: "10.77.0.0/16", labels: LABEL })).network;
    await waitActions(await call("add_network_subnet", { id: net.id, type: "cloud", network_zone: "eu-central", ip_range: "10.77.1.0/24" }), "subnet");
    ok("create_network + add_network_subnet(type=cloud)");

    // --- Firewall with /32 CIDR ---
    const fwResp = await call("create_firewall", {
        name: `t-fw-${suffix}`, labels: LABEL,
        rules: [{ direction: "in", protocol: "tcp", port: "22", source_ips: ["203.0.113.57/32"] }],
    });
    await waitActions(fwResp, "firewall");
    const fw = fwResp.firewall;
    ok("create_firewall");

    // --- Server with location (no datacenter) ---
    const srvResp = await call("create_server", {
        name: `t-srv-${suffix}`, server_type: best.type, image: image.name, location: best.location,
        networks: [net.id], firewalls: [{ firewall: fw.id }], labels: LABEL,
    });
    const srv = srvResp.server;
    await waitActions(srvResp, "create_server");
    const srvInfo = (await call("get_server", { id: srv.id }));
    if (srvInfo.location?.name !== best.location) throw new Error(`server location mismatch: ${JSON.stringify(srvInfo.location)}`);
    if ("datacenter" in srvInfo) console.log("     note: server response still includes datacenter");
    ok("create_server(location)", `id ${srv.id}, location ${srvInfo.location.name}`);

    // --- list_network_members (#4) ---
    const members = await call("list_network_members", { id: net.id, type: "server" });
    if (!members.some((m) => m.id === srv.id && m.ip?.startsWith("10.77.1."))) throw new Error(`server not in members: ${JSON.stringify(members)}`);
    ok("list_network_members", `${members.length} member(s), ip ${members.find((m) => m.id === srv.id).ip}`);

    // --- change_dns_ptr set + reset (#7) ---
    const v4 = srvInfo.public_net.ipv4.ip;
    await waitActions(await call("change_dns_ptr", { resource: "server", id: srv.id, ip: v4, dns_ptr: `t-${suffix}.example.com` }), "ptr set");
    const ptrSet = (await call("get_server", { id: srv.id })).public_net.ipv4.dns_ptr;
    if (ptrSet !== `t-${suffix}.example.com`) throw new Error(`ptr not set: ${ptrSet}`);
    await waitActions(await call("change_dns_ptr", { resource: "server", id: srv.id, ip: v4, dns_ptr: null }), "ptr reset");
    const ptrReset = (await call("get_server", { id: srv.id })).public_net.ipv4.dns_ptr;
    if (ptrReset === `t-${suffix}.example.com`) throw new Error("ptr not reset");
    ok("change_dns_ptr (set, then null resets)", `default ${ptrReset}`);

    // --- rebuild_server with user_data (#5) ---
    const rb = await call("rebuild_server", { id: srv.id, image: image.name, user_data: "#cloud-config\nhostname: rebuilt\n" });
    if (!rb?.action?.id || rb.action.command !== "rebuild_server") throw new Error(`rebuild: ${JSON.stringify(rb).slice(0, 200)}`);
    await waitActions(rb, "rebuild");
    ok("rebuild_server (user_data)", `root_password ${rb.root_password ? "returned" : "null (ssh-key image)"}`);

    // --- Primary IP: create by location, swap onto server ---
    const pip = (await call("create_primary_ip", { name: `t-pip-${suffix}`, type: "ipv4", location: best.location, auto_delete: false, labels: LABEL })).primary_ip;
    if (pip.assignee_type !== "unassigned") throw new Error(`expected assignee_type unassigned, got ${pip.assignee_type}`);
    ok("create_primary_ip(location)", `assignee_type=${pip.assignee_type}`);
    const oldPipId = srvInfo.public_net.ipv4.id;
    await waitActions(await call("power_off_server", { id: srv.id }), "power_off");
    await waitActions(await call("unassign_primary_ip", { id: oldPipId }), "unassign old pip");
    await waitActions(await call("assign_primary_ip", { id: pip.id, server: srv.id }), "assign new pip");
    await waitActions(await call("power_on_server", { id: srv.id }), "power_on");
    await call("delete_primary_ip", { id: oldPipId });
    const after = await call("get_server", { id: srv.id });
    if (after.public_net.ipv4.id !== pip.id) throw new Error("primary ip swap did not stick");
    ok("primary IP swap + delete old");

    // --- Assigned IP delete must fail (must_be_unassigned) ---
    try { await call("delete_primary_ip", { id: pip.id }); throw new Error("deleting assigned primary IP unexpectedly succeeded"); }
    catch (e) { if (!/must_be_unassigned|assigned/i.test(String(e.message))) throw e; ok("delete assigned primary IP rejected", "must_be_unassigned"); }

    // --- Volume attach/detach/delete ---
    const volResp = await call("create_volume", { name: `t-vol-${suffix}`, size: 10, location: best.location, labels: LABEL });
    await waitActions(volResp, "create_volume");
    const vol = volResp.volume;
    await waitActions(await call("attach_volume", { id: vol.id, server: srv.id }), "attach_volume");
    await waitActions(await call("detach_volume", { id: vol.id }), "detach_volume");
    await call("delete_volume", { id: vol.id });
    ok("volume create/attach/detach/delete");

    // --- Floating IP assign/unassign/delete ---
    const fip = (await call("create_floating_ip", { type: "ipv4", home_location: best.location, labels: LABEL })).floating_ip;
    await waitActions(await call("assign_floating_ip", { id: fip.id, server: srv.id }), "assign fip");
    await waitActions(await call("unassign_floating_ip", { id: fip.id }), "unassign fip");
    await call("delete_floating_ip", { id: fip.id });
    ok("floating IP assign/unassign/delete");

    // --- Load balancer: delete returns Action ---
    const lbResp = await call("create_load_balancer", { name: `t-lb-${suffix}`, load_balancer_type: "lb11", location: best.location, labels: LABEL });
    await waitActions(lbResp, "create_lb");
    const lbId = lbResp.load_balancer.id;
    await waitActions(await call("add_load_balancer_service", {
        id: lbId, protocol: "http", listen_port: 80, destination_port: 80, proxyprotocol: false,
        health_check: { protocol: "http", port: 80, interval: 15, timeout: 10, retries: 3, http: { path: "/" } },
    }), "add service");
    await waitActions(await call("update_load_balancer_service", { id: lbId, listen_port: 80, http: { timeout_idle: 120 } }), "timeout_idle");
    const svc = (await call("get_load_balancer", { id: lbId })).services?.find((x) => x.listen_port === 80)
        ?? (await call("get_load_balancer", { id: lbId })).load_balancer?.services?.find((x) => x.listen_port === 80);
    if (svc?.http?.timeout_idle !== 120) throw new Error(`timeout_idle not applied: ${JSON.stringify(svc?.http)}`);
    ok("update_load_balancer_service http.timeout_idle", "120s");
    const lbIp = lbResp.load_balancer.public_net.ipv4.ip;
    await waitActions(await call("change_dns_ptr", { resource: "load_balancer", id: lbId, ip: lbIp, dns_ptr: `lb-${suffix}.example.com` }), "lb ptr");
    ok("change_dns_ptr on load balancer");
    const delLb = await call("delete_load_balancer", { id: lbId });
    if (!delLb?.action?.id) throw new Error(`delete_load_balancer returned no action: ${JSON.stringify(delLb).slice(0, 200)}`);
    await waitActions(delLb, "delete_lb");
    ok("delete_load_balancer returns Action", `command=${delLb.action.command}`);

    // --- Teardown in skill order ---
    await waitActions(await call("delete_server", { id: srv.id }), "delete_server");
    await call("unassign_primary_ip", { id: pip.id }).catch(() => {}); // already unassigned by server delete
    await call("delete_primary_ip", { id: pip.id });
    await call("delete_firewall", { id: fw.id });
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
