// Snapshots, backups and image management (#16) plus resource protection (#18),
// implemented with the direct client in hcloud-api.ts.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hcloudRequest } from "./hcloud-api.js";
import { json, listAll, withToolError } from "./tool-helpers.js";

const labelsSchema = z.record(z.string(), z.string());

// Every resource whose spec has POST /{collection}/{id}/actions/change_protection.
// Certificates have no change_protection action. DNS zones and RRSets are covered by
// change_zone_protection / change_rrset_protection in dns-tools.ts.
const PROTECTION_RESOURCES = {
    server: "servers",
    volume: "volumes",
    floating_ip: "floating_ips",
    primary_ip: "primary_ips",
    load_balancer: "load_balancers",
    network: "networks",
    image: "images",
} as const;

export function registerImageTools(server: McpServer) {
    server.tool(
        "create_snapshot",
        "Create an image from a server's disk. type snapshot (default) is independent of the server and survives its deletion; billed per GB-month. type backup needs backups enabled and is deleted with the server. Shut the server down first for a consistent disk. Returns the image (status creating) and an Action; the server is locked until it finishes",
        {
            id: z.number().describe("Server ID"),
            description: z.string().optional().describe("Image description (auto-generated if omitted)"),
            type: z.enum(["snapshot", "backup"]).optional().describe("Default snapshot"),
            labels: labelsSchema.optional(),
        },
        async ({ id, description, type, labels }) => withToolError(async () =>
            json(await hcloudRequest("POST", `/servers/${id}/actions/create_image`, {
                body: { type: type ?? "snapshot", description, labels },
            }))),
    );

    server.tool(
        "list_snapshots",
        "List images with filters (list_images has none): by default only snapshot and backup images. Filter by label_selector, bound_to (server IDs, backups only), status, architecture, name. All pages",
        {
            type: z.array(z.enum(["snapshot", "backup", "system", "app"])).optional()
                .describe("Image types; default [\"snapshot\", \"backup\"]"),
            bound_to: z.array(z.string()).optional().describe("Server IDs the backup images are bound to"),
            label_selector: z.string().optional().describe("e.g. env=prod"),
            status: z.array(z.enum(["available", "creating", "unavailable"])).optional(),
            architecture: z.enum(["x86", "arm"]).optional(),
            name: z.string().optional().describe("Exact name (system/app images have names; snapshots usually not)"),
            include_deprecated: z.boolean().optional(),
            sort: z.array(z.string()).optional().describe("e.g. [\"created:desc\"]; fields id, name, created"),
        },
        async ({ type, ...filters }) => withToolError(async () => {
            const images = await listAll(
                (p) => hcloudRequest("GET", "/images", {
                    query: { type: type ?? ["snapshot", "backup"], ...filters, ...p },
                }),
                "images",
            );
            return json(images);
        }),
    );

    server.tool(
        "get_image",
        "Get an image by ID (type, status, image_size/disk_size in GB, created_from, bound_to, protection, labels)",
        { id: z.number().describe("Image ID") },
        async ({ id }) => withToolError(async () => json(await hcloudRequest("GET", `/images/${id}`))),
    );

    server.tool(
        "update_image",
        "Update a snapshot or backup image: description, labels (REPLACES the whole label set), or type \"snapshot\" to convert a backup into a snapshot (it then survives server deletion and disabling backups). System/app images cannot be updated",
        {
            id: z.number().describe("Image ID"),
            description: z.string().optional(),
            type: z.literal("snapshot").optional().describe("Convert a backup image to a snapshot"),
            labels: labelsSchema.optional().describe("Replaces all existing labels"),
        },
        async ({ id, description, type, labels }) => withToolError(async () => {
            if (description === undefined && type === undefined && labels === undefined) {
                throw new Error("Pass at least one of description, type, labels");
            }
            return json(await hcloudRequest("PUT", `/images/${id}`, { body: { description, type, labels } }));
        }),
    );

    server.tool(
        "delete_image",
        "Delete a snapshot or backup image (system/app images cannot be deleted). Fails if delete protection is on. Irreversible; confirm with the user first",
        { id: z.number().describe("Image ID") },
        async ({ id }) => withToolError(async () => {
            await hcloudRequest("DELETE", `/images/${id}`);
            return json({ deleted: true, id });
        }),
    );

    server.tool(
        "enable_server_backups",
        "Enable automatic daily backups for a server: +20% of the server price, 7 rolling backup slots (list them with list_snapshots type [\"backup\"] and bound_to). Returns an Action",
        { id: z.number().describe("Server ID") },
        async ({ id }) => withToolError(async () =>
            json(await hcloudRequest("POST", `/servers/${id}/actions/enable_backup`))),
    );

    server.tool(
        "disable_server_backups",
        "Disable automatic backups for a server. IMMEDIATELY DELETES ALL EXISTING BACKUPS of the server; convert any you need to snapshots first (update_image type snapshot). Confirm with the user first. Returns an Action",
        { id: z.number().describe("Server ID") },
        async ({ id }) => withToolError(async () =>
            json(await hcloudRequest("POST", `/servers/${id}/actions/disable_backup`))),
    );

    server.tool(
        "change_protection",
        "Enable/disable protection on a server, volume, floating_ip, primary_ip, load_balancer, network or image (snapshot/backup). Protected resources cannot be deleted (servers: nor rebuilt). `delete` applies to all; `rebuild` only to servers, and the API currently requires a server's delete and rebuild to be equal, so passing just one for a server sets both. For DNS use change_zone_protection / change_rrset_protection; certificates have no protection. Returns an Action",
        {
            resource: z.enum(["server", "volume", "floating_ip", "primary_ip", "load_balancer", "network", "image"]),
            id: z.number().describe("Resource ID"),
            delete: z.boolean().optional().describe("Prevent deletion"),
            rebuild: z.boolean().optional().describe("Servers only: prevent rebuild"),
        },
        async ({ resource, id, delete: del, rebuild }) => withToolError(async () => {
            let body: { delete?: boolean; rebuild?: boolean };
            if (resource === "server") {
                if (del === undefined && rebuild === undefined) throw new Error("Pass delete and/or rebuild");
                if (del !== undefined && rebuild !== undefined && del !== rebuild) {
                    throw new Error("For servers the API currently requires delete and rebuild to have the same value");
                }
                const value = (del ?? rebuild) as boolean;
                body = { delete: value, rebuild: value };
            } else {
                if (rebuild !== undefined) throw new Error(`rebuild protection only exists for servers, not ${resource}`);
                if (del === undefined) throw new Error("Pass delete (true or false)");
                body = { delete: del };
            }
            return json(await hcloudRequest("POST", `/${PROTECTION_RESOURCES[resource]}/${id}/actions/change_protection`, { body }));
        }),
    );
}
