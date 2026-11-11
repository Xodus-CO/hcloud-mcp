/**
 * Live DNS test: drives the built MCP server through the DNS tools on a throwaway
 * zone (hcloud-mcp-test-<run-id>.com), then deletes it. DNS zones are free.
 *
 * Usage: HCLOUD_TOKEN=... node scripts/test-live-dns.mjs   (npm run build first)
 */
import "dotenv/config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const token = process.env.HCLOUD_TOKEN;
if (!token) { console.error("HCLOUD_TOKEN required"); process.exit(1); }

const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const ZONE = process.env.DNS_TEST_ZONE ?? `hcloud-mcp-test-${runId}.com`;
let passed = 0;
const ok = (step, detail = "") => { passed++; console.log(`ok   ${step}${detail ? " — " + detail : ""}`); };
const assert = (cond, msg) => { if (!cond) throw new Error(`assertion failed: ${msg}`); };

const client = new Client({ name: "live-dns-test", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...process.env, HCLOUD_TOKEN: token } }));

async function call(name, args = {}) {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content[0].text;
    if (r.isError) throw new Error(`${name} failed: ${text}`);
    try { return JSON.parse(text); } catch { return text; }
}
async function expectError(name, args, pattern) {
    const r = await client.callTool({ name, arguments: args });
    assert(r.isError, `${name} should have failed`);
    assert(pattern.test(r.content[0].text), `${name} error should match ${pattern}: ${r.content[0].text}`);
    return r.content[0].text;
}
async function wait(resp, label) {
    const ids = [resp?.action?.id, ...(resp?.actions ?? []).map((a) => a.id)].filter(Boolean);
    for (const id of ids) {
        for (let i = 0; ; i++) {
            const a = await call("get_action", { id });
            const act = a.action ?? a;
            if (act.status === "success") break;
            if (act.status === "error") throw new Error(`${label}: action ${id} error ${JSON.stringify(act.error)}`);
            if (i > 60) throw new Error(`${label}: action ${id} timed out`);
            await new Promise((r) => setTimeout(r, 1000));
        }
    }
}
const values = (rr) => rr.records.map((r) => r.value).sort();

let failed = null;
try {
    const created = await call("create_zone", {
        name: ZONE, mode: "primary", ttl: 3600, labels: { "hcloud-mcp-test": runId },
        rrsets: [{ name: "www", type: "A", records: [{ value: "192.0.2.10" }] }],
    });
    assert(created.zone?.name === ZONE, "create_zone returns zone");
    await wait(created, "create_zone");
    ok("create_zone (primary, seeded rrset)", `id ${created.zone.id}`);

    const zone = await call("get_zone", { zone: ZONE });
    assert(zone.name === ZONE && zone.mode === "primary", "get_zone by name");
    ok("get_zone by name", `nameservers: ${JSON.stringify(zone.authoritative_nameservers?.assigned ?? zone.authoritative_nameservers ?? "?")}`);

    const listed = await call("list_zones", { name: ZONE });
    assert(listed.length === 1 && listed[0].id === zone.id, "list_zones name filter");
    const byLabel = await call("list_zones", { label_selector: `hcloud-mcp-test=${runId}` });
    assert(byLabel.length === 1, "list_zones label_selector");
    ok("list_zones (name + label_selector filters)");

    const www = await call("get_rrset", { zone: ZONE, name: "www", type: "A" });
    assert(values(www).join() === "192.0.2.10", "seeded www A");
    ok("get_rrset");

    await wait(await call("create_rrset", { zone: String(zone.id), name: "@", type: "TXT", ttl: 300, records: [{ value: '"v=spf1 -all"' }] }), "create_rrset");
    ok("create_rrset (apex TXT, zone referenced by ID)");

    await wait(await call("add_rrset_records", { zone: ZONE, name: "www", type: "A", records: [{ value: "192.0.2.11", comment: "second" }] }), "add");
    assert(values(await call("get_rrset", { zone: ZONE, name: "www", type: "A" })).join() === "192.0.2.10,192.0.2.11", "add appended");
    await wait(await call("add_rrset_records", { zone: ZONE, name: "api", type: "CNAME", records: [{ value: "www" }] }), "add creates");
    ok("add_rrset_records (append + auto-create)");

    await wait(await call("update_rrset_records", { zone: ZONE, name: "www", type: "A", records: [{ value: "192.0.2.10", comment: "primary web" }] }), "update_records");
    const commented = await call("get_rrset", { zone: ZONE, name: "www", type: "A" });
    assert(commented.records.find((r) => r.value === "192.0.2.10")?.comment === "primary web", "comment updated");
    ok("update_rrset_records (comment)");

    await wait(await call("change_rrset_ttl", { zone: ZONE, name: "www", type: "A", ttl: 600 }), "ttl 600");
    assert((await call("get_rrset", { zone: ZONE, name: "www", type: "A" })).ttl === 600, "ttl 600");
    await wait(await call("change_rrset_ttl", { zone: ZONE, name: "www", type: "A", ttl: null }), "ttl null");
    assert((await call("get_rrset", { zone: ZONE, name: "www", type: "A" })).ttl == null, "ttl reset to zone default");
    ok("change_rrset_ttl (600, then null = zone default)");

    await wait(await call("remove_rrset_records", { zone: ZONE, name: "www", type: "A", records: [{ value: "192.0.2.11" }] }), "remove");
    await wait(await call("set_rrset_records", { zone: ZONE, name: "www", type: "A", records: [{ value: "192.0.2.20" }, { value: "192.0.2.21" }] }), "set");
    assert(values(await call("get_rrset", { zone: ZONE, name: "www", type: "A" })).join() === "192.0.2.20,192.0.2.21", "set replaced");
    ok("remove_rrset_records + set_rrset_records");

    await call("update_rrset", { zone: ZONE, name: "www", type: "A", labels: { role: "web" } });
    const filtered = await call("list_rrsets", { zone: ZONE, type: "A" });
    assert(filtered.every((r) => r.type === "A") && filtered.some((r) => r.labels?.role === "web"), "list_rrsets type filter + labels");
    ok("update_rrset labels + list_rrsets type filter", `${filtered.length} A rrsets`);

    await wait(await call("change_rrset_protection", { zone: ZONE, name: "www", type: "A", change: true }), "protect");
    await expectError("delete_rrset", { zone: ZONE, name: "www", type: "A" }, /protect/i);
    await wait(await call("change_rrset_protection", { zone: ZONE, name: "www", type: "A", change: false }), "unprotect");
    ok("change_rrset_protection blocks delete, then unprotect");

    const zonefile = await call("export_zonefile", { zone: ZONE });
    assert(typeof zonefile === "string" && zonefile.includes("192.0.2.20") && zonefile.includes("v=spf1"), "zonefile contents");
    ok("export_zonefile", `${zonefile.split("\n").length} lines`);

    const imported = zonefile.replace("192.0.2.20", "192.0.2.30");
    await wait(await call("import_zonefile", { zone: ZONE, zonefile: imported }), "import");
    assert(values(await call("get_rrset", { zone: ZONE, name: "www", type: "A" })).includes("192.0.2.30"), "import applied");
    ok("import_zonefile (round-trip with edit)");

    await wait(await call("change_zone_ttl", { zone: ZONE, ttl: 7200 }), "zone ttl");
    await call("update_zone", { zone: ZONE, labels: { "hcloud-mcp-test": runId, stage: "done" } });
    const z2 = await call("get_zone", { zone: ZONE });
    assert(z2.ttl === 7200 && z2.labels.stage === "done", "zone ttl + labels");
    ok("change_zone_ttl + update_zone labels");

    await wait(await call("delete_rrset", { zone: ZONE, name: "api", type: "CNAME" }), "delete_rrset");
    await expectError("get_rrset", { zone: ZONE, name: "api", type: "CNAME" }, /not_found/);
    ok("delete_rrset");

    await expectError("create_zone", { name: `x-${runId}.com`, mode: "secondary" }, /primary_nameservers/);
    ok("create_zone secondary without nameservers rejected locally");

    const del = await call("delete_zone", { zone: ZONE });
    assert(del.action?.id, "delete_zone returns action");
    await wait(del, "delete_zone");
    await expectError("get_zone", { zone: ZONE }, /not_found/);
    ok("delete_zone returns Action; zone gone");
} catch (e) {
    failed = e;
    console.error(`FAIL ${e.message}`);
} finally {
    await client.close().catch(() => {});
    // Safety net: delete the test zone only if it still exists AND carries this run's label,
    // so a pre-existing zone (DNS_TEST_ZONE override or name collision) is never touched.
    const url = `https://api.hetzner.cloud/v1/zones/${encodeURIComponent(ZONE)}`;
    const headers = { Authorization: `Bearer ${token}` };
    const lookup = await fetch(url, { headers });
    if (lookup.ok) {
        const { zone } = await lookup.json();
        if (zone?.labels?.["hcloud-mcp-test"] === runId) {
            const r = await fetch(url, { method: "DELETE", headers });
            console.log(`safety-net delete of ${ZONE}: HTTP ${r.status}`);
        } else {
            console.log(`safety-net skipped for ${ZONE}: not created by this run`);
        }
    } else if (lookup.status !== 404) {
        console.log(`safety-net lookup of ${ZONE}: HTTP ${lookup.status}`);
    }
    console.log(`\n${passed} steps passed${failed ? ", 1 failed" : ""}`);
    process.exit(failed ? 1 : 0);
}
