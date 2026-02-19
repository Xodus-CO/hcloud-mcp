/**
 * Test list_* API calls using the same Hetzner SDK as the MCP server.
 * Run from project root: node scripts/test-list-api.mjs
 * Uses HCLOUD_TOKEN from environment or .env.
 */
import "dotenv/config";
import {
    LocationsService,
    ServerTypesService,
    DatacentersService,
    OpenAPI,
} from "hetzner-sdk-ts";

const token = process.env.HCLOUD_TOKEN;
if (!token) {
    console.error("Error: HCLOUD_TOKEN environment variable is required");
    process.exit(1);
}
OpenAPI.TOKEN = token;

async function run() {
    console.log("Testing list_locations...");
    try {
        const r = await LocationsService.getLocations({});
        console.log("list_locations OK, count:", r.locations?.length ?? 0);
    } catch (e) {
        console.error("list_locations failed:", e.message || e);
    }

    console.log("Testing list_server_types...");
    try {
        const r = await ServerTypesService.getServerTypes({});
        console.log("list_server_types OK, count:", r.server_types?.length ?? 0);
    } catch (e) {
        console.error("list_server_types failed:", e.message || e);
    }

    console.log("Testing list_datacenters...");
    try {
        const r = await DatacentersService.getDatacenters({});
        console.log("list_datacenters OK, datacenters:", r.datacenters?.length ?? 0);
    } catch (e) {
        console.error("list_datacenters failed:", e.message || e);
    }
}

run();
