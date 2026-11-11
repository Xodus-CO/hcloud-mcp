/**
 * Read-only check of the built direct API client (dist/hcloud-api.js) against the live API:
 * paginated list calls via listAll, a single GET, and the error format.
 * Run from project root after `npm run build`: node scripts/test-list-api.mjs
 * Uses HCLOUD_TOKEN from environment or .env. Creates nothing.
 */
import "dotenv/config";
import { hcloudRequest, HcloudApiError } from "../dist/hcloud-api.js";
import { listAll } from "../dist/tool-helpers.js";

if (!process.env.HCLOUD_TOKEN) {
    console.error("Error: HCLOUD_TOKEN environment variable is required");
    process.exit(1);
}

let failed = 0;
async function check(name, fn) {
    try {
        console.log(`ok   ${name}: ${await fn()}`);
    } catch (e) {
        failed++;
        console.error(`FAIL ${name}: ${e?.message ?? e}`);
    }
}

await check("list_locations", async () => {
    const items = await listAll((p) => hcloudRequest("GET", "/locations", { query: p }), "locations");
    if (!items.length || !items[0].name) throw new Error("no locations");
    return `${items.length} locations`;
});

await check("list_server_types", async () => {
    const items = await listAll((p) => hcloudRequest("GET", "/server_types", { query: p }), "server_types");
    if (!items.length) throw new Error("no server types");
    return `${items.length} server types`;
});

// Small pages force listAll to follow meta.pagination.next_page.
await check("pagination (per_page=2)", async () => {
    const all = await listAll((p) => hcloudRequest("GET", "/locations", { query: { ...p, per_page: 2 } }), "locations");
    const single = await hcloudRequest("GET", "/locations", { query: { per_page: 50 } });
    if (all.length !== single.locations.length) throw new Error(`${all.length} != ${single.locations.length}`);
    return `${all.length} locations across pages`;
});

await check("get_pricing", async () => {
    const r = await hcloudRequest("GET", "/pricing");
    if (!r.pricing?.currency) throw new Error("no pricing.currency");
    return `currency ${r.pricing.currency}`;
});

await check("error format (GET /servers/1)", async () => {
    try {
        // IDs start at 1, so 0 can never exist in any project (always not_found).
        await hcloudRequest("GET", "/servers/0");
    } catch (e) {
        if (!(e instanceof HcloudApiError) || !/^not_found \(404\): /.test(e.message)) throw new Error(`unexpected: ${e?.message ?? e}`);
        return e.message;
    }
    throw new Error("expected not_found");
});

if (failed) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
}
console.log("All API client checks passed");
