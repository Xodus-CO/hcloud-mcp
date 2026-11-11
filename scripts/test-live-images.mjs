/**
 * Live test for image tools (#16) and change_protection (#18): drives the built MCP
 * server (dist/index.js) against the real Hetzner API.
 *
 * COSTS MONEY (~1-2 cents: cheapest x86 server for a few minutes plus a small snapshot
 * billed per GB-month hourly). Every resource is labeled hcloud-mcp-test=<run-id>; the
 * safety net in `finally` unprotects and deletes only servers and snapshot images with that label.
 *
 * Usage: HCLOUD_TOKEN=... node scripts/test-live-images.mjs   (npm run build first)
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

const client = new Client({ name: "live-test-images", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...process.env, HCLOUD_TOKEN: token } }));

async function call(name, args = {}) {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content[0].text;
    if (r.isError) throw new Error(`${name} failed: ${text}`);
    try { return JSON.parse(text); } catch { return text; }
}

// Expect a tool call to fail; returns the error text.
async function callFails(name, args) {
    const r = await client.callTool({ name, arguments: args });
    if (!r.isError) throw new Error(`${name} unexpectedly succeeded: ${r.content[0].text.slice(0, 200)}`);
    return r.content[0].text;
}

async function waitActions(resp, label, tries = 300) {
    if (!resp || typeof resp !== "object") return;
    const ids = [resp.action?.id, ...(resp.actions ?? []).map((a) => a.id), ...(resp.next_actions ?? []).map((a) => a.id)].filter(Boolean);
    for (const id of ids) {
        for (let i = 0; i < tries; i++) {
            const r = await call("get_action", { id });
            const a = r.action ?? r;
            if (a.status === "success") break;
            if (a.status === "error") throw new Error(`${label}: action ${id} error ${JSON.stringify(a.error)}`);
            await sleep(2000);
            if (i === tries - 1) throw new Error(`${label}: action ${id} timed out`);
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

// Only touches servers and snapshot/backup images carrying this run's exact label. Unprotects first,
// since a failure mid-test can leave protection on.
async function safetyNetCleanup() {
    const sel = `label_selector=${encodeURIComponent(`hcloud-mcp-test=${suffix}`)}`;
    const imgSel = `${sel}&type=snapshot&type=backup`;
    for (const img of (await rest("GET", `/images?${imgSel}`)).images ?? []) {
        if (img.protection?.delete) { await rest("POST", `/images/${img.id}/actions/change_protection`, { delete: false }); await sleep(2000); }
        await rest("DELETE", `/images/${img.id}`);
    }
    for (const s of (await rest("GET", `/servers?${sel}`)).servers ?? []) {
        if (s.protection?.delete || s.protection?.rebuild) {
            await rest("POST", `/servers/${s.id}/actions/change_protection`, { delete: false, rebuild: false });
            await sleep(3000);
        }
        await rest("DELETE", `/servers/${s.id}`);
    }
    await sleep(3000);
    const left = [];
    for (const [path, key] of [["/servers?" + sel, "servers"], ["/images?" + imgSel, "images"]]) {
        const items = (await rest("GET", path))[key] ?? [];
        if (items.length) left.push(`${key}:${items.map((i) => i.id).join(",")}`);
    }
    return left;
}

let failed = null;
try {
    // --- Cheapest available x86 type (any location) ---
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
            if (!l.available || l.deprecation) continue;
            const price = priceOf(t.name, l.name);
            if (!best || price < best.price) best = { type: t.name, location: l.name, price };
        }
    }
    if (!best) throw new Error("no available x86 server type");
    ok("select type/location", `${best.type} @ ${best.location} (€${best.price}/h)`);

    // --- Server ---
    const srvResp = await call("create_server", {
        name: `t-img-${suffix}`, server_type: best.type, image: "ubuntu-24.04", location: best.location, labels: LABEL,
    });
    const srv = srvResp.server;
    await waitActions(srvResp, "create_server");
    ok("create_server", `id ${srv.id}`);

    // --- create_snapshot (#16) ---
    await waitActions(await call("power_off_server", { id: srv.id }), "power_off"); // consistent disk + faster
    const snapResp = await call("create_snapshot", { id: srv.id, description: `t-snap-${suffix}`, labels: LABEL });
    const snapId = snapResp.image?.id;
    if (!snapId || snapResp.image.type !== "snapshot") throw new Error(`create_snapshot: ${JSON.stringify(snapResp).slice(0, 300)}`);
    await waitActions(snapResp, "create_image");
    ok("create_snapshot", `image ${snapId}, action ${snapResp.action?.command}`);

    // --- get_image: wait for available ---
    let img;
    for (let i = 0; i < 120; i++) {
        img = await call("get_image", { id: snapId });
        img = img.image ?? img;
        if (img.status === "available") break;
        await sleep(5000);
    }
    if (img.status !== "available") throw new Error(`snapshot not available: ${img.status}`);
    if (img.created_from?.id !== srv.id || img.labels?.["hcloud-mcp-test"] !== suffix) throw new Error(`get_image mismatch: ${JSON.stringify(img).slice(0, 300)}`);
    ok("get_image", `status ${img.status}, image_size ${img.image_size} GB, disk_size ${img.disk_size} GB`);

    // --- list_snapshots filtered by label ---
    const listed = await call("list_snapshots", { label_selector: `hcloud-mcp-test=${suffix}` });
    if (listed.length !== 1 || listed[0].id !== snapId) throw new Error(`list_snapshots: ${JSON.stringify(listed.map((i) => i.id))}`);
    ok("list_snapshots(label_selector)");

    // --- update_image (labels replace: keep the test label) ---
    const upd = await call("update_image", { id: snapId, description: `t-snap-upd-${suffix}`, labels: { ...LABEL, step: "updated" } });
    const u = upd.image ?? upd;
    if (u.description !== `t-snap-upd-${suffix}` || u.labels?.step !== "updated" || u.labels?.["hcloud-mcp-test"] !== suffix) throw new Error(`update_image: ${JSON.stringify(u).slice(0, 300)}`);
    const noArgs = await callFails("update_image", { id: snapId });
    ok("update_image (description, labels); empty update rejected locally", noArgs.slice(0, 60));

    // --- enable / disable backups ---
    await waitActions(await call("enable_server_backups", { id: srv.id }), "enable_backup");
    let s = await call("get_server", { id: srv.id }); s = s.server ?? s;
    if (!s.backup_window) throw new Error(`backups not enabled: backup_window=${s.backup_window}`);
    ok("enable_server_backups", `backup_window ${s.backup_window}`);

    // Manual backup, then convert it to a snapshot so it survives disabling backups.
    const bkResp = await call("create_snapshot", { id: srv.id, type: "backup", labels: LABEL });
    const bkId = bkResp.image?.id;
    if (!bkId || bkResp.image.type !== "backup") throw new Error(`create backup: ${JSON.stringify(bkResp).slice(0, 300)}`);
    await waitActions(bkResp, "create backup");
    let bk;
    for (let i = 0; i < 120; i++) { bk = await call("get_image", { id: bkId }); bk = bk.image ?? bk; if (bk.status === "available") break; await sleep(5000); }
    if (bk.status !== "available" || bk.bound_to !== srv.id) throw new Error(`backup image: status ${bk.status}, bound_to ${bk.bound_to}`);
    const bkBound = await call("list_snapshots", { type: ["backup"], bound_to: [String(srv.id)] });
    if (!bkBound.some((i) => i.id === bkId)) throw new Error("list_snapshots(bound_to) missed the backup");
    ok("create_snapshot(type backup) + list_snapshots(bound_to)", `image ${bkId}, bound_to ${bk.bound_to}`);
    let conv = await call("update_image", { id: bkId, type: "snapshot", labels: LABEL }); conv = conv.image ?? conv;
    if (conv.type !== "snapshot") throw new Error(`conversion: type ${conv.type}`);
    ok("update_image(type snapshot) converts backup", `bound_to now ${conv.bound_to}`);

    await waitActions(await call("disable_server_backups", { id: srv.id }), "disable_backup");
    s = await call("get_server", { id: srv.id }); s = s.server ?? s;
    if (s.backup_window) throw new Error(`backups still enabled: ${s.backup_window}`);
    let survived = await call("get_image", { id: bkId }); survived = survived.image ?? survived;
    if (survived.type !== "snapshot") throw new Error(`converted image after disable: ${JSON.stringify(survived).slice(0, 200)}`);
    await call("delete_image", { id: bkId });
    ok("disable_server_backups (converted snapshot survived, then deleted)");

    // --- change_protection local validation ---
    const e1 = await callFails("change_protection", { resource: "volume", id: 1, rebuild: true });
    const e2 = await callFails("change_protection", { resource: "image", id: snapId });
    const e3 = await callFails("change_protection", { resource: "server", id: srv.id, delete: true, rebuild: false });
    if (![e1, e2, e3].every((e) => /^Error: (rebuild|Pass|For servers)/.test(e))) throw new Error(`unexpected validation errors: ${e1} | ${e2} | ${e3}`);
    ok("change_protection local validation (rebuild non-server, no flag, server mismatch)");

    // Probe: what does the raw API do with {delete:true} alone for a server? (informational)
    const probe = await rest("POST", `/servers/${srv.id}/actions/change_protection`, { delete: true });
    if (probe.action) await waitActions(probe, "probe");
    let ps = await call("get_server", { id: srv.id }); ps = ps.server ?? ps;
    console.log(`     probe: raw {delete:true} on server -> ${probe.error ? `error ${probe.error.code}: ${probe.error.message}` : `ok, protection ${JSON.stringify(ps.protection)}`}`);
    if (!probe.error) { await waitActions(await rest("POST", `/servers/${srv.id}/actions/change_protection`, { delete: false, rebuild: false }), "probe reset"); }

    // --- protect server (delete only -> mirrored to rebuild) ---
    await waitActions(await call("change_protection", { resource: "server", id: srv.id, delete: true }), "protect server");
    s = await call("get_server", { id: srv.id }); s = s.server ?? s;
    if (!s.protection?.delete || !s.protection?.rebuild) throw new Error(`server protection: ${JSON.stringify(s.protection)}`);
    ok("change_protection(server, delete:true)", `protection ${JSON.stringify(s.protection)}`);
    const delErr = await callFails("delete_server", { id: srv.id });
    console.log(`     delete_server error text: ${delErr.slice(0, 200)}`);
    if (!/protect/i.test(delErr)) throw new Error(`delete_server error lacks 'protected': ${delErr}`);
    ok("delete_server on protected server rejected");
    await waitActions(await call("change_protection", { resource: "server", id: srv.id, delete: false }), "unprotect server");
    s = await call("get_server", { id: srv.id }); s = s.server ?? s;
    if (s.protection?.delete || s.protection?.rebuild) throw new Error(`server still protected: ${JSON.stringify(s.protection)}`);
    ok("change_protection(server, delete:false)");

    // --- protect + unprotect the snapshot ---
    await waitActions(await call("change_protection", { resource: "image", id: snapId, delete: true }), "protect image");
    img = await call("get_image", { id: snapId }); img = img.image ?? img;
    if (!img.protection?.delete) throw new Error(`image protection: ${JSON.stringify(img.protection)}`);
    const imgDelErr = await callFails("delete_image", { id: snapId });
    if (!/protect/i.test(imgDelErr)) throw new Error(`delete_image error lacks 'protected': ${imgDelErr}`);
    ok("change_protection(image, delete:true) + delete_image rejected", imgDelErr.slice(0, 80));
    await waitActions(await call("change_protection", { resource: "image", id: snapId, delete: false }), "unprotect image");
    img = await call("get_image", { id: snapId }); img = img.image ?? img;
    if (img.protection?.delete) throw new Error("image still protected");
    ok("change_protection(image, delete:false)");

    // --- delete_image, then server ---
    const del = await call("delete_image", { id: snapId });
    if (!del.deleted) throw new Error(`delete_image: ${JSON.stringify(del)}`);
    await callFails("get_image", { id: snapId });
    ok("delete_image (get_image now 404)");
    await waitActions(await call("delete_server", { id: srv.id }), "delete_server");
    ok("delete_server");
} catch (e) {
    failed = e;
    console.error(`FAIL ${e.message}`);
} finally {
    await client.close().catch(() => {});
    const left = await safetyNetCleanup();
    console.log(left.length ? `LEFTOVER RESOURCES: ${left.join(" ")}` : `cleanup verified: no hcloud-mcp-test=${suffix} servers/images remain`);
    console.log(`\n${results.length} steps passed${failed ? ", 1 failed" : ""}`);
    process.exit(failed || left.length ? 1 : 0);
}
