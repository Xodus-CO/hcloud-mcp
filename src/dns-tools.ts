// Hetzner DNS (Cloud API /zones, /zones/{id_or_name}/rrsets).
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hcloudRequest, seg } from "./hcloud-api.js";
import { ADDITIVE, ADDITIVE_IDEMPOTENT, DESTRUCTIVE_IDEMPOTENT, READ_ONLY, json, listAll, withToolError } from "./tool-helpers.js";

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
    server.registerTool(
        "list_zones",
        {
            description: "List DNS zones (all pages). Optional filters by name, mode, label selector",
            inputSchema: {
                name: z.string().optional(),
                mode: z.enum(["primary", "secondary"]).optional(),
                label_selector: labelSelector,
            },
            annotations: READ_ONLY,
        },
        async (args) => withToolError(async () => {
            const zones = await listAll(
                (p) => hcloudRequest("GET", "/zones", { query: { ...args, ...p } }),
                "zones",
            );
            return json(zones);
        }),
    );

    server.registerTool(
        "get_zone",
        {
            description: "Get a DNS zone (status, nameservers it is authoritative on, delegation status, record count)",
            inputSchema: { zone: zoneRef },
            annotations: READ_ONLY,
        },
        async ({ zone }) => withToolError(async () => json((await hcloudRequest("GET", `/zones/${seg(zone)}`)).zone)),
    );

    server.registerTool(
        "create_zone",
        {
            description: 'Create a DNS zone. mode "primary" = Hetzner hosts the records (optionally seed with rrsets or a zonefile); "secondary" = Hetzner pulls from primary_nameservers via AXFR. Returns zone + Action. After creating, delegate the domain to the zone\'s authoritative_nameservers at your registrar',
            inputSchema: {
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
            annotations: ADDITIVE,
        },
        async (args) => withToolError(async () => {
            if (args.rrsets && args.zonefile) throw new Error("Provide rrsets OR zonefile, not both");
            if (args.mode === "secondary" && !args.primary_nameservers?.length) {
                throw new Error("mode=secondary requires primary_nameservers");
            }
            return json(await hcloudRequest("POST", "/zones", { body: args }));
        }),
    );

    server.registerTool(
        "update_zone",
        {
            description: "Update a zone's labels (replaces all labels)",
            inputSchema: { zone: zoneRef, labels },
            annotations: ADDITIVE_IDEMPOTENT,
        },
        async ({ zone, labels }) => withToolError(async () =>
            json((await hcloudRequest("PUT", `/zones/${seg(zone)}`, { body: { labels } })).zone)),
    );

    server.registerTool(
        "delete_zone",
        {
            description: "Delete a DNS zone and ALL its records. Irreversible; confirm with the user first. Returns an Action",
            inputSchema: { zone: zoneRef },
            annotations: DESTRUCTIVE_IDEMPOTENT,
        },
        async ({ zone }) => withToolError(async () => json(await hcloudRequest("DELETE", `/zones/${seg(zone)}`))),
    );

    server.registerTool(
        "export_zonefile",
        {
            description: "Export a primary zone as a BIND zone file (good for backups or reviewing all records at once)",
            inputSchema: { zone: zoneRef },
            annotations: READ_ONLY,
        },
        async ({ zone }) => withToolError(async () => {
            const res = await hcloudRequest("GET", `/zones/${seg(zone)}/zonefile`);
            return { content: [{ type: "text", text: res.zonefile ?? JSON.stringify(res, null, 2) }] };
        }),
    );

    server.registerTool(
        "import_zonefile",
        {
            description: "Replace ALL records of a primary zone with a BIND zone file. Destructive for records not in the file; export_zonefile first as a backup. Returns an Action",
            inputSchema: { zone: zoneRef, zonefile: z.string() },
            annotations: DESTRUCTIVE_IDEMPOTENT,
        },
        async ({ zone, zonefile }) => withToolError(async () =>
            json(await hcloudRequest("POST", `/zones/${seg(zone)}/actions/import_zonefile`, { body: { zonefile } }))),
    );

    server.registerTool(
        "change_zone_ttl",
        {
            description: "Change a zone's default TTL (applies to RRSets without their own TTL). Returns an Action",
            inputSchema: { zone: zoneRef, ttl },
            annotations: ADDITIVE_IDEMPOTENT,
        },
        async ({ zone, ttl }) => withToolError(async () =>
            json(await hcloudRequest("POST", `/zones/${seg(zone)}/actions/change_ttl`, { body: { ttl } }))),
    );

    server.registerTool(
        "change_zone_primary_nameservers",
        {
            description: "Set the primary nameservers a secondary zone transfers from (replaces the list). Returns an Action",
            inputSchema: { zone: zoneRef, primary_nameservers: z.array(nameserver).min(1) },
            annotations: DESTRUCTIVE_IDEMPOTENT,
        },
        async ({ zone, primary_nameservers }) => withToolError(async () =>
            json(await hcloudRequest("POST", `/zones/${seg(zone)}/actions/change_primary_nameservers`, { body: { primary_nameservers } }))),
    );

    server.registerTool(
        "change_zone_protection",
        {
            description: "Enable/disable delete protection on a zone. Returns an Action",
            inputSchema: { zone: zoneRef, delete: z.boolean() },
            annotations: DESTRUCTIVE_IDEMPOTENT,
        },
        async ({ zone, delete: del }) => withToolError(async () =>
            json(await hcloudRequest("POST", `/zones/${seg(zone)}/actions/change_protection`, { body: { delete: del } }))),
    );

    // --- RRSets ---
    server.registerTool(
        "list_rrsets",
        {
            description: "List record sets (RRSets) in a zone (all pages). Filter by name and/or type",
            inputSchema: { zone: zoneRef, name: z.string().optional(), type: rrType.optional(), label_selector: labelSelector },
            annotations: READ_ONLY,
        },
        async ({ zone, ...filters }) => withToolError(async () => {
            const rrsets = await listAll(
                (p) => hcloudRequest("GET", `/zones/${seg(zone)}/rrsets`, { query: { ...filters, ...p } }),
                "rrsets",
            );
            return json(rrsets);
        }),
    );

    server.registerTool(
        "get_rrset",
        {
            description: "Get one RRSet by name and type",
            inputSchema: { zone: zoneRef, name: rrName, type: rrType },
            annotations: READ_ONLY,
        },
        async ({ zone, name, type }) => withToolError(async () =>
            json((await hcloudRequest("GET", rrsetPath(zone, name, type))).rrset)),
    );

    server.registerTool(
        "create_rrset",
        {
            description: "Create an RRSet (all records sharing one name+type). Fails if it already exists; use add_rrset_records or set_rrset_records to change an existing one. Returns rrset + Action",
            inputSchema: { zone: zoneRef, name: rrName, type: rrType, records, ttl: ttl.nullable().optional().describe("Omit/null = zone default"), labels: labels.optional() },
            annotations: ADDITIVE,
        },
        async ({ zone, ...body }) => withToolError(async () =>
            json(await hcloudRequest("POST", `/zones/${seg(zone)}/rrsets`, { body }))),
    );

    server.registerTool(
        "update_rrset",
        {
            description: "Update an RRSet's labels (replaces all labels). To change records use set/add/remove_rrset_records",
            inputSchema: { zone: zoneRef, name: rrName, type: rrType, labels },
            annotations: ADDITIVE_IDEMPOTENT,
        },
        async ({ zone, name, type, labels }) => withToolError(async () =>
            json((await hcloudRequest("PUT", rrsetPath(zone, name, type), { body: { labels } })).rrset)),
    );

    server.registerTool(
        "delete_rrset",
        {
            description: "Delete an RRSet and all its records. Returns an Action",
            inputSchema: { zone: zoneRef, name: rrName, type: rrType },
            annotations: DESTRUCTIVE_IDEMPOTENT,
        },
        async ({ zone, name, type }) => withToolError(async () =>
            json(await hcloudRequest("DELETE", rrsetPath(zone, name, type)))),
    );

    server.registerTool(
        "set_rrset_records",
        {
            description: "Replace all records of an RRSet with the given list. Returns an Action",
            inputSchema: { zone: zoneRef, name: rrName, type: rrType, records },
            annotations: DESTRUCTIVE_IDEMPOTENT,
        },
        async ({ zone, name, type, records }) => withToolError(async () =>
            json(await hcloudRequest("POST", `${rrsetPath(zone, name, type)}/actions/set_records`, { body: { records } }))),
    );

    server.registerTool(
        "add_rrset_records",
        {
            description: "Add records to an RRSet, creating the RRSet if it does not exist. Returns an Action",
            inputSchema: { zone: zoneRef, name: rrName, type: rrType, records, ttl: ttl.nullable().optional().describe("Used only if the RRSet is created") },
            annotations: ADDITIVE_IDEMPOTENT,
        },
        async ({ zone, name, type, records, ttl }) => withToolError(async () =>
            json(await hcloudRequest("POST", `${rrsetPath(zone, name, type)}/actions/add_records`, { body: { records, ttl } }))),
    );

    server.registerTool(
        "remove_rrset_records",
        {
            description: "Remove specific records (matched by value) from an RRSet. Removing the last record deletes the RRSet. Returns an Action",
            inputSchema: { zone: zoneRef, name: rrName, type: rrType, records },
            annotations: DESTRUCTIVE_IDEMPOTENT,
        },
        async ({ zone, name, type, records }) => withToolError(async () =>
            json(await hcloudRequest("POST", `${rrsetPath(zone, name, type)}/actions/remove_records`, { body: { records } }))),
    );

    server.registerTool(
        "update_rrset_records",
        {
            description: "Update the comments of existing records (matched by value). Cannot change values; use set_rrset_records for that",
            inputSchema: {
                zone: zoneRef, name: rrName, type: rrType,
                records: z.array(z.object({ value: z.string(), comment: z.string() })).min(1),
            },
            annotations: ADDITIVE_IDEMPOTENT,
        },
        async ({ zone, name, type, records }) => withToolError(async () =>
            json(await hcloudRequest("POST", `${rrsetPath(zone, name, type)}/actions/update_records`, { body: { records } }))),
    );

    server.registerTool(
        "change_rrset_ttl",
        {
            description: "Change an RRSet's TTL. ttl is required: a number of seconds, or null to fall back to the zone default. Returns an Action",
            inputSchema: { zone: zoneRef, name: rrName, type: rrType, ttl: ttl.nullable() },
            annotations: ADDITIVE_IDEMPOTENT,
        },
        async ({ zone, name, type, ttl }) => withToolError(async () =>
            json(await hcloudRequest("POST", `${rrsetPath(zone, name, type)}/actions/change_ttl`, { body: { ttl } }))),
    );

    server.registerTool(
        "change_rrset_protection",
        {
            description: "Enable/disable change protection on an RRSet (protected RRSets cannot be modified or deleted). Returns an Action",
            inputSchema: { zone: zoneRef, name: rrName, type: rrType, change: z.boolean() },
            annotations: DESTRUCTIVE_IDEMPOTENT,
        },
        async ({ zone, name, type, change }) => withToolError(async () =>
            json(await hcloudRequest("POST", `${rrsetPath(zone, name, type)}/actions/change_protection`, { body: { change } }))),
    );
}
