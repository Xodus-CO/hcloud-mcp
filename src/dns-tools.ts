// Hetzner DNS (Cloud API /zones, /zones/{id_or_name}/rrsets).
// hetzner-sdk-ts has no DNS services, so these use the direct client in hcloud-api.ts.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hcloudRequest, seg } from "./hcloud-api.js";
import { json, listAll, withToolError } from "./tool-helpers.js";

const zoneRef = z.string().describe("Zone ID or name, e.g. example.com");
const rrName = z
    .string()
    .describe('Record name relative to the zone: "@" for the apex, "www", "_acme-challenge", etc. Lowercase.');
const rrType = z.enum([
    "A", "AAAA", "CAA", "CNAME", "DS", "HINFO", "HTTPS", "MX", "NS", "PTR", "RP", "SOA", "SRV", "SVCB", "TLSA", "TXT",
]);
const record = z.object({
    value: z
        .string()
        .describe('Record value in zone-file syntax. TXT values must be quoted, e.g. "\\"v=spf1 -all\\"". MX: "10 mail.example.com."'),
    comment: z.string().optional(),
});
const records = z.array(record).min(1);
const ttl = z.number().int().describe("TTL in seconds");
const labels = z.record(z.string());
const labelSelector = z.string().optional().describe("Label selector, e.g. env=prod");
const nameserver = z.object({
    address: z.string().describe("IPv4 or IPv6 of the primary nameserver"),
    port: z.number().int().optional().describe("Default 53"),
    tsig_key: z.string().optional(),
    tsig_algorithm: z.string().optional().describe("e.g. hmac-sha256"),
});

const rrsetPath = (zone: string, name: string, type: string) => `/zones/${seg(zone)}/rrsets/${seg(name)}/${seg(type)}`;

export function registerDnsTools(server: McpServer) {
    // --- Zones ---
    server.tool(
        "list_zones",
        "List DNS zones (all pages). Optional filters by name, mode, label selector",
        {
            name: z.string().optional(),
            mode: z.enum(["primary", "secondary"]).optional(),
            label_selector: labelSelector,
        },
        async (args) => withToolError(async () => {
            const zones = await listAll(
                (p) => hcloudRequest("GET", "/zones", { query: { ...args, page: p.page, per_page: p.perPage } }),
                "zones",
            );
            return json(zones);
        }),
    );

    server.tool(
        "get_zone",
        "Get a DNS zone (status, nameservers it is authoritative on, delegation status, record count)",
        { zone: zoneRef },
        async ({ zone }) => withToolError(async () => json((await hcloudRequest("GET", `/zones/${seg(zone)}`)).zone)),
    );

    server.tool(
        "create_zone",
        'Create a DNS zone. mode "primary" = Hetzner hosts the records (optionally seed with rrsets or a zonefile); "secondary" = Hetzner pulls from primary_nameservers via AXFR. Returns zone + Action. After creating, delegate the domain to the zone\'s authoritative_nameservers at your registrar',
        {
            name: z.string().describe("Domain name, e.g. example.com (no trailing dot)"),
            mode: z.enum(["primary", "secondary"]).default("primary"),
            ttl: ttl.optional().describe("Default TTL for records without their own TTL (default 3600)"),
            labels: labels.optional(),
            primary_nameservers: z.array(nameserver).optional().describe("Required for mode=secondary"),
            rrsets: z
                .array(z.object({ name: rrName, type: rrType, ttl: ttl.nullable().optional(), records, labels: labels.optional() }))
                .optional()
                .describe("Initial RRSets (primary only; mutually exclusive with zonefile)"),
            zonefile: z.string().optional().describe("BIND zone file to import (primary only; mutually exclusive with rrsets)"),
        },
        async (args) => withToolError(async () => {
            if (args.rrsets && args.zonefile) throw new Error("Provide rrsets OR zonefile, not both");
            if (args.mode === "secondary" && !args.primary_nameservers?.length) {
                throw new Error("mode=secondary requires primary_nameservers");
            }
            return json(await hcloudRequest("POST", "/zones", { body: args }));
        }),
    );

    server.tool(
        "update_zone",
        "Update a zone's labels (replaces all labels)",
        { zone: zoneRef, labels },
        async ({ zone, labels }) => withToolError(async () =>
            json((await hcloudRequest("PUT", `/zones/${seg(zone)}`, { body: { labels } })).zone)),
    );

    server.tool(
        "delete_zone",
        "Delete a DNS zone and ALL its records. Irreversible; confirm with the user first. Returns an Action",
        { zone: zoneRef },
        async ({ zone }) => withToolError(async () => json(await hcloudRequest("DELETE", `/zones/${seg(zone)}`))),
    );

    server.tool(
        "export_zonefile",
        "Export a primary zone as a BIND zone file (good for backups or reviewing all records at once)",
        { zone: zoneRef },
        async ({ zone }) => withToolError(async () => {
            const res = await hcloudRequest("GET", `/zones/${seg(zone)}/zonefile`);
            return { content: [{ type: "text", text: res.zonefile ?? JSON.stringify(res, null, 2) }] };
        }),
    );

    server.tool(
        "import_zonefile",
        "Replace ALL records of a primary zone with a BIND zone file. Destructive for records not in the file; export_zonefile first as a backup. Returns an Action",
        { zone: zoneRef, zonefile: z.string() },
        async ({ zone, zonefile }) => withToolError(async () =>
            json(await hcloudRequest("POST", `/zones/${seg(zone)}/actions/import_zonefile`, { body: { zonefile } }))),
    );

    server.tool(
        "change_zone_ttl",
        "Change a zone's default TTL (applies to RRSets without their own TTL). Returns an Action",
        { zone: zoneRef, ttl },
        async ({ zone, ttl }) => withToolError(async () =>
            json(await hcloudRequest("POST", `/zones/${seg(zone)}/actions/change_ttl`, { body: { ttl } }))),
    );

    server.tool(
        "change_zone_primary_nameservers",
        "Set the primary nameservers a secondary zone transfers from (replaces the list). Returns an Action",
        { zone: zoneRef, primary_nameservers: z.array(nameserver).min(1) },
        async ({ zone, primary_nameservers }) => withToolError(async () =>
            json(await hcloudRequest("POST", `/zones/${seg(zone)}/actions/change_primary_nameservers`, { body: { primary_nameservers } }))),
    );

    server.tool(
        "change_zone_protection",
        "Enable/disable delete protection on a zone. Returns an Action",
        { zone: zoneRef, delete: z.boolean() },
        async ({ zone, delete: del }) => withToolError(async () =>
            json(await hcloudRequest("POST", `/zones/${seg(zone)}/actions/change_protection`, { body: { delete: del } }))),
    );

    // --- RRSets ---
    server.tool(
        "list_rrsets",
        "List record sets (RRSets) in a zone (all pages). Filter by name and/or type",
        { zone: zoneRef, name: z.string().optional(), type: rrType.optional(), label_selector: labelSelector },
        async ({ zone, ...filters }) => withToolError(async () => {
            const rrsets = await listAll(
                (p) => hcloudRequest("GET", `/zones/${seg(zone)}/rrsets`, { query: { ...filters, page: p.page, per_page: p.perPage } }),
                "rrsets",
            );
            return json(rrsets);
        }),
    );

    server.tool(
        "get_rrset",
        "Get one RRSet by name and type",
        { zone: zoneRef, name: rrName, type: rrType },
        async ({ zone, name, type }) => withToolError(async () =>
            json((await hcloudRequest("GET", rrsetPath(zone, name, type))).rrset)),
    );

    server.tool(
        "create_rrset",
        "Create an RRSet (all records sharing one name+type). Fails if it already exists; use add_rrset_records or set_rrset_records to change an existing one. Returns rrset + Action",
        { zone: zoneRef, name: rrName, type: rrType, records, ttl: ttl.nullable().optional().describe("Omit/null = zone default"), labels: labels.optional() },
        async ({ zone, ...body }) => withToolError(async () =>
            json(await hcloudRequest("POST", `/zones/${seg(zone)}/rrsets`, { body }))),
    );

    server.tool(
        "update_rrset",
        "Update an RRSet's labels (replaces all labels). To change records use set/add/remove_rrset_records",
        { zone: zoneRef, name: rrName, type: rrType, labels },
        async ({ zone, name, type, labels }) => withToolError(async () =>
            json((await hcloudRequest("PUT", rrsetPath(zone, name, type), { body: { labels } })).rrset)),
    );

    server.tool(
        "delete_rrset",
        "Delete an RRSet and all its records. Returns an Action",
        { zone: zoneRef, name: rrName, type: rrType },
        async ({ zone, name, type }) => withToolError(async () =>
            json(await hcloudRequest("DELETE", rrsetPath(zone, name, type)))),
    );

    server.tool(
        "set_rrset_records",
        "Replace all records of an RRSet with the given list. Returns an Action",
        { zone: zoneRef, name: rrName, type: rrType, records },
        async ({ zone, name, type, records }) => withToolError(async () =>
            json(await hcloudRequest("POST", `${rrsetPath(zone, name, type)}/actions/set_records`, { body: { records } }))),
    );

    server.tool(
        "add_rrset_records",
        "Add records to an RRSet, creating the RRSet if it does not exist. Returns an Action",
        { zone: zoneRef, name: rrName, type: rrType, records, ttl: ttl.nullable().optional().describe("Used only if the RRSet is created") },
        async ({ zone, name, type, records, ttl }) => withToolError(async () =>
            json(await hcloudRequest("POST", `${rrsetPath(zone, name, type)}/actions/add_records`, { body: { records, ttl } }))),
    );

    server.tool(
        "remove_rrset_records",
        "Remove specific records (matched by value) from an RRSet. Removing the last record deletes the RRSet. Returns an Action",
        { zone: zoneRef, name: rrName, type: rrType, records },
        async ({ zone, name, type, records }) => withToolError(async () =>
            json(await hcloudRequest("POST", `${rrsetPath(zone, name, type)}/actions/remove_records`, { body: { records } }))),
    );

    server.tool(
        "update_rrset_records",
        "Update the comments of existing records (matched by value). Cannot change values; use set_rrset_records for that",
        {
            zone: zoneRef, name: rrName, type: rrType,
            records: z.array(z.object({ value: z.string(), comment: z.string() })).min(1),
        },
        async ({ zone, name, type, records }) => withToolError(async () =>
            json(await hcloudRequest("POST", `${rrsetPath(zone, name, type)}/actions/update_records`, { body: { records } }))),
    );

    server.tool(
        "change_rrset_ttl",
        "Change an RRSet's TTL. ttl is required: a number of seconds, or null to fall back to the zone default. Returns an Action",
        { zone: zoneRef, name: rrName, type: rrType, ttl: ttl.nullable() },
        async ({ zone, name, type, ttl }) => withToolError(async () =>
            json(await hcloudRequest("POST", `${rrsetPath(zone, name, type)}/actions/change_ttl`, { body: { ttl } }))),
    );

    server.tool(
        "change_rrset_protection",
        "Enable/disable change protection on an RRSet (protected RRSets cannot be modified or deleted). Returns an Action",
        { zone: zoneRef, name: rrName, type: rrType, change: z.boolean() },
        async ({ zone, name, type, change }) => withToolError(async () =>
            json(await hcloudRequest("POST", `${rrsetPath(zone, name, type)}/actions/change_protection`, { body: { change } }))),
    );
}
