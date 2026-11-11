/**
 * Live Storage Box test: drives the built MCP server through the Storage Box tools on a
 * throwaway bx11 (labelled hcloud-mcp-test=<run-id>), then deletes it. bx11 costs about
 * EUR 0.005/h with no setup fee, so a run costs well under EUR 0.10.
 *
 * SAFETY: pre-existing Storage Boxes are only ever read. Every mutating call goes through
 * mutate(), which refuses any box id other than the one created in this run, and the
 * cleanup only deletes boxes that carry this run's exact label.
 *
 * Usage: HCLOUD_TOKEN=... node scripts/test-live-storage-box.mjs   (npm run build first)
 * Env: SB_TEST_LOCATION (default fsn1)
 */
import "dotenv/config";
import { randomInt } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const token = process.env.HCLOUD_TOKEN;
if (!token) { console.error("HCLOUD_TOKEN required"); process.exit(1); }

const API = "https://api.hetzner.com/v1";
const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const LABEL = "hcloud-mcp-test";
const LOCATION = process.env.SB_TEST_LOCATION ?? "fsn1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const ok = (step, detail = "") => { passed++; console.log(`ok   ${step}${detail ? " — " + detail : ""}`); };
const assert = (cond, msg) => { if (!cond) throw new Error(`assertion failed: ${msg}`); };

// Random password satisfying the policy (upper, lower, digit, special; 24 chars). Never logged.
function genPassword() {
    const sets = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "#-_.+*"];
    const all = sets.join("");
    const chars = sets.map((s) => s[randomInt(s.length)]);
    while (chars.length < 24) chars.push(all[randomInt(all.length)]);
    for (let i = chars.length - 1; i > 0; i--) { const j = randomInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
    return chars.join("");
}

const client = new Client({ name: "live-storage-box-test", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...process.env, HCLOUD_TOKEN: token } }));

async function rawCall(name, args) {
    const r = await client.callTool({ name, arguments: args });
    return { isError: r.isError, text: r.content[0].text };
}
async function call(name, args = {}) {
    const { isError, text } = await rawCall(name, args);
    if (isError) throw new Error(`${name} failed: ${text}`);
    try { return JSON.parse(text); } catch { return text; }
}
async function expectError(name, args, pattern) {
    const { isError, text } = await rawCall(name, args);
    assert(isError, `${name} should have failed`);
    assert(pattern.test(text), `${name} error should match ${pattern}: ${text}`);
}

let BOX = null; // id of the box created by this run; the only box mutate() may touch
const preexisting = new Set();
async function mutate(name, args) {
    assert(BOX != null && args.id === BOX && !preexisting.has(args.id), `refusing ${name} on box ${args.id}: not created by this run`);
    return call(name, args);
}
async function wait(resp, label, { timeoutMs = 120_000, intervalMs = 2000 } = {}) {
    const id = resp?.action?.id;
    assert(id, `${label}: response has an action`);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const a = await call("get_storage_box_action", { id });
        if (a.status === "success") return a;
        if (a.status === "error") throw new Error(`${label}: action ${id} error ${JSON.stringify(a.error)}`);
        if (Date.now() > deadline) throw new Error(`${label}: action ${id} timed out (${a.progress}%)`);
        await sleep(intervalMs);
    }
}

let failed = null;
let protectionOn = false;
try {
    // --- read-only discovery (safe on the user's existing boxes) ---
    const types = await call("list_storage_box_types");
    const bx11 = types.find((t) => t.name === "bx11");
    assert(bx11, "bx11 type exists");
    const price = bx11.prices.find((p) => p.location === LOCATION);
    assert(price, `bx11 available in ${LOCATION}`);
    assert(Number(price.setup_fee.gross) === 0, "bx11 has no setup fee");
    const t1 = await call("get_storage_box_type", { id: bx11.id });
    assert(t1.name === "bx11", "get_storage_box_type");
    ok("list/get_storage_box_types", `bx11 ${LOCATION} ${price.price_hourly.gross}/h, snapshots ${bx11.snapshot_limit}, auto ${bx11.automatic_snapshot_limit}, subaccounts ${bx11.subaccounts_limit}`);

    const before = await call("list_storage_boxes");
    before.forEach((b) => preexisting.add(b.id));
    ok("list_storage_boxes", `${before.length} pre-existing (read-only): ${[...preexisting].join(",") || "none"}`);
    if (before[0]) {
        const g = await call("get_storage_box", { id: before[0].id });
        assert(g.id === before[0].id, "get_storage_box on existing box");
        ok("get_storage_box (existing box, read-only)");
    }

    // --- create ---
    const created = await call("create_storage_box", {
        name: `hcloud-mcp-test-${runId}`, location: LOCATION, storage_box_type: "bx11",
        password: genPassword(), labels: { [LABEL]: runId },
        access_settings: { ssh_enabled: true, reachable_externally: false },
    });
    BOX = created.storage_box?.id;
    assert(BOX && !preexisting.has(BOX), "create_storage_box returns a new box id");
    ok("create_storage_box", `id ${BOX}, action ${created.action.id}`);

    // Is a Storage Box action visible on the Cloud API's get_action? (informational only)
    const cloud = await rawCall("get_action", { id: created.action.id });
    console.log(`info get_action (Cloud API) on a Storage Box action: ${cloud.isError ? "NOT pollable — " + cloud.text.slice(0, 80) : "pollable"}`);

    const t0 = Date.now();
    await wait(created, "create_storage_box", { timeoutMs: 20 * 60_000, intervalMs: 5000 });
    let box;
    for (;;) {
        box = await call("get_storage_box", { id: BOX });
        if (box.status === "active") break;
        if (Date.now() - t0 > 20 * 60_000) throw new Error(`box stuck in ${box.status}`);
        await sleep(5000);
    }
    assert(box.username && box.server, "active box has username + server");
    assert(box.labels[LABEL] === runId, "label set");
    ok("create action + box active", `${Math.round((Date.now() - t0) / 1000)}s, ${box.server}`);

    const byLabel = await call("list_storage_boxes", { label_selector: `${LABEL}=${runId}` });
    assert(byLabel.length === 1 && byLabel[0].id === BOX, "label_selector filter");
    ok("list_storage_boxes label_selector");

    const acts = await call("list_storage_box_actions", { storage_box_id: BOX });
    assert(acts.some((a) => a.id === created.action.id), "box actions include create");
    ok("list_storage_box_actions", acts.map((a) => a.command).join(","));

    // --- update + actions ---
    const upd = await mutate("update_storage_box", { id: BOX, name: `hcloud-mcp-test-${runId}-r`, labels: { [LABEL]: runId, stage: "updated" } });
    assert(upd.name.endsWith("-r") && upd.labels.stage === "updated" && upd.labels[LABEL] === runId, "update_storage_box");
    ok("update_storage_box (name + labels)");

    await wait(await mutate("update_storage_box_access_settings", { id: BOX, webdav_enabled: true, zfs_enabled: true }), "access");
    box = await call("get_storage_box", { id: BOX });
    assert(box.access_settings.webdav_enabled && box.access_settings.zfs_enabled && box.access_settings.ssh_enabled, "partial access update");
    ok("update_storage_box_access_settings (partial)");

    await wait(await mutate("reset_storage_box_password", { id: BOX, password: genPassword() }), "reset_password");
    ok("reset_storage_box_password");

    await wait(await mutate("change_storage_box_protection", { id: BOX, delete: true }), "protect");
    protectionOn = true;
    await expectError("delete_storage_box", { id: BOX }, /protect/i);
    await wait(await mutate("change_storage_box_protection", { id: BOX, delete: false }), "unprotect");
    protectionOn = false;
    ok("change_storage_box_protection (delete blocked while protected)");

    const maxSnaps = Math.max(1, Math.min(2, bx11.automatic_snapshot_limit ?? 2));
    await wait(await mutate("enable_storage_box_snapshot_plan", { id: BOX, max_snapshots: maxSnaps, hour: 3, minute: 30, day_of_week: 7 }), "enable plan");
    box = await call("get_storage_box", { id: BOX });
    assert(box.snapshot_plan?.hour === 3 && box.snapshot_plan?.minute === 30 && box.snapshot_plan?.day_of_week === 7, "snapshot plan set");
    await wait(await mutate("disable_storage_box_snapshot_plan", { id: BOX }), "disable plan");
    box = await call("get_storage_box", { id: BOX });
    assert(box.snapshot_plan == null, "snapshot plan cleared");
    ok("enable/disable_storage_box_snapshot_plan");

    // --- subaccounts ---
    const sub = await mutate("create_storage_box_subaccount", {
        id: BOX, home_directory: "mcp-test/sub1", password: genPassword(), description: "mcp test",
        labels: { [LABEL]: runId }, access_settings: { ssh_enabled: true, readonly: false },
    });
    const SUB = sub.subaccount?.id;
    assert(SUB, "create_storage_box_subaccount returns id");
    await wait(sub, "create subaccount");
    let s = await call("get_storage_box_subaccount", { id: BOX, subaccount_id: SUB });
    assert(s.home_directory.includes("mcp-test/sub1") && s.username, "subaccount details");
    ok("create/get_storage_box_subaccount", `${s.username} home ${s.home_directory}`);

    s = await mutate("update_storage_box_subaccount", { id: BOX, subaccount_id: SUB, name: `sub-${runId}`, description: "updated", labels: { [LABEL]: runId, k: "v" } });
    assert(s.description === "updated" && s.labels.k === "v", "update subaccount");
    const subs = await call("list_storage_box_subaccounts", { id: BOX });
    assert(subs.some((x) => x.id === SUB), "list subaccounts");
    ok("update/list_storage_box_subaccounts");

    await wait(await mutate("update_storage_box_subaccount_access_settings", { id: BOX, subaccount_id: SUB, readonly: true }), "sub access");
    await wait(await mutate("change_storage_box_subaccount_home_directory", { id: BOX, subaccount_id: SUB, home_directory: "mcp-test/sub2" }), "sub home");
    await wait(await mutate("reset_storage_box_subaccount_password", { id: BOX, subaccount_id: SUB, password: genPassword() }), "sub password");
    s = await call("get_storage_box_subaccount", { id: BOX, subaccount_id: SUB });
    assert(s.access_settings.readonly === true && s.access_settings.ssh_enabled === true && s.home_directory.includes("mcp-test/sub2"), "sub actions applied");
    ok("subaccount actions (access settings, home directory, password)");

    const folders = await call("list_storage_box_folders", { id: BOX });
    assert(Array.isArray(folders), "folders is an array");
    const sub2 = await call("list_storage_box_folders", { id: BOX, path: "mcp-test" });
    ok("list_storage_box_folders", `root ${JSON.stringify(folders)}, mcp-test ${JSON.stringify(sub2)}`);

    await wait(await mutate("delete_storage_box_subaccount", { id: BOX, subaccount_id: SUB }), "delete sub");
    await expectError("get_storage_box_subaccount", { id: BOX, subaccount_id: SUB }, /not_found/);
    ok("delete_storage_box_subaccount");

    // --- snapshots ---
    const snap = await mutate("create_storage_box_snapshot", { id: BOX, description: "mcp test", labels: { [LABEL]: runId } });
    const SNAP = snap.snapshot?.id;
    assert(SNAP, "create snapshot returns id");
    await wait(snap, "create snapshot", { timeoutMs: 5 * 60_000 });
    let sn = await call("get_storage_box_snapshot", { id: BOX, snapshot_id: SNAP });
    assert(sn.is_automatic === false && sn.name, "snapshot details");
    sn = await mutate("update_storage_box_snapshot", { id: BOX, snapshot_id: SNAP, description: "updated", labels: { [LABEL]: runId, k: "v" } });
    assert(sn.description === "updated" && sn.labels.k === "v", "update snapshot");
    const snaps = await call("list_storage_box_snapshots", { id: BOX, is_automatic: false });
    assert(snaps.some((x) => x.id === SNAP), "list snapshots");
    ok("create/get/update/list_storage_box_snapshot", `name ${sn.name}`);

    await wait(await mutate("rollback_storage_box_snapshot", { id: BOX, snapshot: String(SNAP) }), "rollback", { timeoutMs: 5 * 60_000 });
    ok("rollback_storage_box_snapshot (by id)");

    await wait(await mutate("delete_storage_box_snapshot", { id: BOX, snapshot_id: SNAP }), "delete snapshot");
    await expectError("get_storage_box_snapshot", { id: BOX, snapshot_id: SNAP }, /not_found/);
    ok("delete_storage_box_snapshot");

    // --- local validation ---
    await expectError("create_storage_box", { name: "x", location: LOCATION, storage_box_type: "bx11", password: "short" }, /12|too_small|at least/i);
    ok("password shorter than 12 chars rejected locally");

    // --- delete ---
    const del = await mutate("delete_storage_box", { id: BOX });
    await wait(del, "delete_storage_box", { timeoutMs: 10 * 60_000, intervalMs: 5000 });
    await expectError("get_storage_box", { id: BOX }, /not_found/);
    ok("delete_storage_box returns Action; box gone");
    BOX = null;
} catch (e) {
    failed = e;
    console.error(`FAIL ${e.message}`);
} finally {
    await client.close().catch(() => {});
    // Safety net: delete only boxes that carry THIS run's label and were not pre-existing.
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const list = await fetch(`${API}/storage_boxes?label_selector=${encodeURIComponent(`${LABEL}=${runId}`)}`, { headers });
    const leftovers = list.ok ? (await list.json()).storage_boxes : [];
    if (!list.ok) console.log(`safety-net list: HTTP ${list.status}`);
    for (const b of leftovers) {
        const g = await fetch(`${API}/storage_boxes/${b.id}`, { headers });
        const box = g.ok ? (await g.json()).storage_box : null;
        if (!box || box.labels?.[LABEL] !== runId || preexisting.has(box.id)) {
            console.log(`safety-net skipped box ${b.id}: not created by this run`);
            continue;
        }
        if (box.protection?.delete || protectionOn) {
            await fetch(`${API}/storage_boxes/${box.id}/actions/change_protection`, { method: "POST", headers, body: JSON.stringify({ delete: false }) });
            await sleep(5000);
        }
        for (let i = 0; i < 60; i++) {
            const r = await fetch(`${API}/storage_boxes/${box.id}`, { method: "DELETE", headers });
            if (r.ok || r.status === 404) { console.log(`safety-net delete of box ${box.id}: HTTP ${r.status}`); break; }
            if (i === 59) console.log(`safety-net delete of box ${box.id} FAILED: HTTP ${r.status} — delete it manually`);
            await sleep(10_000);
        }
    }
    console.log(`\n${passed} steps passed${failed ? ", 1 failed" : ""}`);
    process.exit(failed ? 1 : 0);
}
