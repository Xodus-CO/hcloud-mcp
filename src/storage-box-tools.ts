// Hetzner Storage Boxes (Hetzner API, https://api.hetzner.com/v1): boxes, types, folders,
// actions, subaccounts and snapshots. Same bearer token as the Cloud API, different host.
// Storage Box Actions are polled with get_storage_box_action (GET /storage_boxes/actions/{id}).
// (Verified live 2026-11: the Cloud API's /actions/{id} also returns them, but the Storage Box
// endpoint is the documented one.)
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HETZNER_API, hcloudRequest } from "./hcloud-api.js";
import { json, listAll, withToolError } from "./tool-helpers.js";

type Method = "GET" | "POST" | "PUT" | "DELETE";
type Opts = { query?: Record<string, any>; body?: unknown };
// Every Storage Box request must go to api.hetzner.com, never api.hetzner.cloud.
const sb = <T = any>(method: Method, path: string, opts: Opts = {}) =>
    hcloudRequest<T>(method, path, { ...opts, baseUrl: HETZNER_API });

const boxPath = (id: number) => `/storage_boxes/${id}`;
const subPath = (id: number, sub: number) => `${boxPath(id)}/subaccounts/${sub}`;
const snapPath = (id: number, snap: number) => `${boxPath(id)}/snapshots/${snap}`;

const boxId = z.number().int().positive().describe("Storage Box ID");
const subaccountId = z.number().int().positive().describe("Subaccount ID");
const snapshotId = z.number().int().positive().describe("Snapshot ID");
const labels = z.record(z.string());
const labelSelector = z.string().optional().describe("Label selector, e.g. env=prod");
const sort = z
    .array(z.string())
    .optional()
    .describe('Sort fields with optional direction, e.g. ["name:asc", "created:desc"]');
const password = z
    .string()
    .min(12)
    .max(128)
    .describe(
        "Password policy: 12-128 chars from a-z A-Z ÄÖÜäöüß 0-9 ^°!§$%/()=?+#-.,;:~*@{}_& with at least one upper case letter, " +
            "lower case letter, digit and special character; must not appear in known data breaches. " +
            "Generate a strong random one; never echo it back to the user unless they asked for it",
    );
const homeDirectory = z
    .string()
    .describe('Home directory relative to the main account root, e.g. "backups/app1". Created if missing');

const boxAccess = {
    reachable_externally: z.boolean().optional().describe("Allow access from outside the Hetzner network"),
    samba_enabled: z.boolean().optional().describe("Enable Samba/SMB"),
    ssh_enabled: z.boolean().optional().describe("Enable SSH/SFTP/SCP (port 23)"),
    webdav_enabled: z.boolean().optional().describe("Enable WebDAV"),
    zfs_enabled: z.boolean().optional().describe("Show the .zfs snapshot folder"),
};
const subAccess = {
    reachable_externally: boxAccess.reachable_externally,
    samba_enabled: boxAccess.samba_enabled,
    ssh_enabled: boxAccess.ssh_enabled,
    webdav_enabled: boxAccess.webdav_enabled,
    readonly: z.boolean().optional().describe("Read-only subaccount"),
};

const actionStatus = z.array(z.enum(["running", "success", "error"])).optional().describe("Filter by status");
const POLL = "Returns an Action; poll get_storage_box_action until status is success";
const CONFIRM = "Irreversible; confirm with the user first";

export function registerStorageBoxTools(server: McpServer) {
    // --- Storage Box Types ---
    server.tool(
        "list_storage_box_types",
        "List Storage Box Types (bx11, bx21, ...) with size, snapshot/subaccount limits and per-location hourly/monthly prices and setup fees",
        { name: z.string().optional() },
        async (args) => withToolError(async () =>
            json(await listAll(
                (p) => sb("GET", "/storage_box_types", { query: { ...args, ...p } }),
                "storage_box_types",
            ))),
    );

    server.tool(
        "get_storage_box_type",
        "Get a Storage Box Type by ID",
        { id: z.number().int().positive() },
        async ({ id }) => withToolError(async () => json((await sb("GET", `/storage_box_types/${id}`)).storage_box_type)),
    );

    // --- Storage Boxes ---
    server.tool(
        "list_storage_boxes",
        "List Storage Boxes (all pages). Optional filters by exact name and label selector",
        { name: z.string().optional(), label_selector: labelSelector, sort },
        async (args) => withToolError(async () =>
            json(await listAll(
                (p) => sb("GET", "/storage_boxes", { query: { ...args, ...p } }),
                "storage_boxes",
            ))),
    );

    server.tool(
        "get_storage_box",
        "Get a Storage Box: status (initializing/active/locked), type, location, username, server FQDN, access settings, snapshot plan, protection, disk usage stats. username/server/system are null while initializing",
        { id: boxId },
        async ({ id }) => withToolError(async () => json((await sb("GET", boxPath(id))).storage_box)),
    );

    server.tool(
        "create_storage_box",
        `Create a Storage Box (billed hourly, capped at the monthly price; see list_storage_box_types for prices). ${POLL}; provisioning can take several minutes and username/server stay null until status is active`,
        {
            name: z.string().describe("Storage Box name"),
            location: z.string().describe("Location ID or name, e.g. fsn1, hel1 (see list_storage_box_types prices for availability)"),
            storage_box_type: z.string().describe("Storage Box Type ID or name, e.g. bx11"),
            password,
            labels: labels.optional(),
            ssh_keys: z.array(z.string()).optional().describe("SSH public keys in OpenSSH format to install"),
            access_settings: z.object(boxAccess).optional().describe("Initial access settings"),
        },
        async (args) => withToolError(async () => {
            const res = await sb("POST", "/storage_boxes", { body: args });
            return json({ storage_box: res.storage_box, action: res.action });
        }),
    );

    server.tool(
        "update_storage_box",
        "Update a Storage Box's name and/or labels (labels replace the whole set)",
        { id: boxId, name: z.string().optional(), labels: labels.optional() },
        async ({ id, ...body }) => withToolError(async () => json((await sb("PUT", boxPath(id), { body })).storage_box)),
    );

    server.tool(
        "delete_storage_box",
        `Delete a Storage Box and ALL its data, subaccounts and snapshots. ${CONFIRM}. Fails if delete protection is enabled. ${POLL}`,
        { id: boxId },
        async ({ id }) => withToolError(async () => json(await sb("DELETE", boxPath(id)))),
    );

    server.tool(
        "list_storage_box_folders",
        "List folders in a Storage Box directory (not files). Box must be active",
        { id: boxId, path: z.string().optional().describe('Relative path to list (default: root)') },
        async ({ id, path }) => withToolError(async () =>
            json((await sb("GET", `${boxPath(id)}/folders`, { query: { path } })).folders)),
    );

    // --- Actions ---
    server.tool(
        "get_storage_box_action",
        "Get a Storage Box Action by ID (create/delete/reset_password/snapshot/subaccount actions). This is the documented endpoint for Storage Box Actions (get_action currently also resolves them)",
        { id: z.number().int().positive().describe("Action ID") },
        async ({ id }) => withToolError(async () => json((await sb("GET", `/storage_boxes/actions/${id}`)).action)),
    );

    server.tool(
        "list_storage_box_actions",
        "List Actions (all pages). With storage_box_id: actions for that box. Without: actions across all Storage Boxes (optionally filtered by id)",
        {
            storage_box_id: boxId.optional(),
            id: z.array(z.number().int().positive()).optional().describe("Filter by action IDs (Storage-Box-wide listing)"),
            status: actionStatus,
            sort,
        },
        async ({ storage_box_id, ...query }) => withToolError(async () => {
            const path = storage_box_id ? `${boxPath(storage_box_id)}/actions` : "/storage_boxes/actions";
            if (storage_box_id && query.id) throw new Error("id filter is only supported without storage_box_id");
            return json(await listAll(
                (p) => sb("GET", path, { query: { ...query, ...p } }),
                "actions",
            ));
        }),
    );

    server.tool(
        "change_storage_box_protection",
        `Enable/disable delete protection for a Storage Box. ${POLL}`,
        { id: boxId, delete: z.boolean().describe("Prevent deletion") },
        async ({ id, ...body }) => withToolError(async () =>
            json(await sb("POST", `${boxPath(id)}/actions/change_protection`, { body }))),
    );

    server.tool(
        "change_storage_box_type",
        `Upgrade/downgrade a Storage Box to another type (changes billing). Cannot downgrade below current usage. ${POLL}`,
        { id: boxId, storage_box_type: z.string().describe("Target Storage Box Type ID or name, e.g. bx21") },
        async ({ id, ...body }) => withToolError(async () =>
            json(await sb("POST", `${boxPath(id)}/actions/change_type`, { body }))),
    );

    server.tool(
        "reset_storage_box_password",
        `Set a new password for the Storage Box main account (existing clients using the old password lose access). ${POLL}`,
        { id: boxId, password },
        async ({ id, ...body }) => withToolError(async () =>
            json(await sb("POST", `${boxPath(id)}/actions/reset_password`, { body }))),
    );

    server.tool(
        "update_storage_box_access_settings",
        `Update the main account's access settings (partial: omitted fields are unchanged). ${POLL}`,
        { id: boxId, ...boxAccess },
        async ({ id, ...body }) => withToolError(async () => {
            if (Object.keys(body).length === 0) throw new Error("Provide at least one access setting");
            return json(await sb("POST", `${boxPath(id)}/actions/update_access_settings`, { body }));
        }),
    );

    server.tool(
        "enable_storage_box_snapshot_plan",
        `Enable (or replace) the automatic snapshot plan. Runs at hour:minute UTC, optionally only on day_of_week (1=Mon..7=Sun) and/or day_of_month; null/omitted = every day. Oldest automatic snapshots beyond max_snapshots are deleted. ${POLL}`,
        {
            id: boxId,
            max_snapshots: z.number().int().min(1).describe("Snapshots to keep (<= the type's automatic_snapshot_limit)"),
            hour: z.number().int().min(0).max(23).describe("Hour (UTC)"),
            minute: z.number().int().min(0).max(59).describe("Minute (UTC)"),
            day_of_week: z.number().int().min(1).max(7).nullable().optional().describe("1=Monday..7=Sunday; null = every day"),
            day_of_month: z.number().int().min(1).max(31).nullable().optional().describe("Day of month; null = every day"),
        },
        async ({ id, ...body }) => withToolError(async () =>
            json(await sb("POST", `${boxPath(id)}/actions/enable_snapshot_plan`, { body }))),
    );

    server.tool(
        "disable_storage_box_snapshot_plan",
        `Disable the automatic snapshot plan. Existing automatic snapshots are kept (delete them manually). ${POLL}`,
        { id: boxId },
        async ({ id }) => withToolError(async () =>
            json(await sb("POST", `${boxPath(id)}/actions/disable_snapshot_plan`))),
    );

    server.tool(
        "rollback_storage_box_snapshot",
        `Roll a Storage Box back to a snapshot. Deletes all newer snapshots and ALL data written since the snapshot. ${CONFIRM}. ${POLL}`,
        { id: boxId, snapshot: z.string().describe("Snapshot ID or name") },
        async ({ id, ...body }) => withToolError(async () =>
            json(await sb("POST", `${boxPath(id)}/actions/rollback_snapshot`, { body }))),
    );

    // --- Subaccounts ---
    server.tool(
        "list_storage_box_subaccounts",
        "List subaccounts of a Storage Box (username, home_directory, access settings, server FQDN)",
        { id: boxId, name: z.string().optional(), username: z.string().optional(), label_selector: labelSelector, sort },
        async ({ id, ...query }) => withToolError(async () =>
            json((await sb("GET", `${boxPath(id)}/subaccounts`, { query })).subaccounts)),
    );

    server.tool(
        "get_storage_box_subaccount",
        "Get a Storage Box subaccount",
        { id: boxId, subaccount_id: subaccountId },
        async ({ id, subaccount_id }) => withToolError(async () =>
            json((await sb("GET", subPath(id, subaccount_id))).subaccount)),
    );

    server.tool(
        "create_storage_box_subaccount",
        `Create a subaccount: a separate login restricted to home_directory inside the box (shares the box's quota). Username is assigned by Hetzner (<box-username>-subN). Returns {subaccount: {id, storage_box}, action}; ${POLL}, then get_storage_box_subaccount for details`,
        {
            id: boxId,
            home_directory: homeDirectory,
            password,
            name: z.string().optional().describe("Defaults to the generated username"),
            description: z.string().optional(),
            labels: labels.optional(),
            access_settings: z.object(subAccess).optional(),
        },
        async ({ id, ...body }) => withToolError(async () => json(await sb("POST", `${boxPath(id)}/subaccounts`, { body }))),
    );

    server.tool(
        "update_storage_box_subaccount",
        "Update a subaccount's name, description and/or labels (labels replace the whole set). Use change_storage_box_subaccount_home_directory / update_storage_box_subaccount_access_settings for those",
        {
            id: boxId,
            subaccount_id: subaccountId,
            name: z.string().optional(),
            description: z.string().optional(),
            labels: labels.optional(),
        },
        async ({ id, subaccount_id, ...body }) => withToolError(async () =>
            json((await sb("PUT", subPath(id, subaccount_id), { body })).subaccount)),
    );

    server.tool(
        "delete_storage_box_subaccount",
        `Delete a subaccount (its login stops working; files in its home directory remain in the main account). ${CONFIRM}. ${POLL}`,
        { id: boxId, subaccount_id: subaccountId },
        async ({ id, subaccount_id }) => withToolError(async () => json(await sb("DELETE", subPath(id, subaccount_id)))),
    );

    server.tool(
        "change_storage_box_subaccount_home_directory",
        `Change a subaccount's home directory (created if missing). ${POLL}`,
        { id: boxId, subaccount_id: subaccountId, home_directory: homeDirectory },
        async ({ id, subaccount_id, ...body }) => withToolError(async () =>
            json(await sb("POST", `${subPath(id, subaccount_id)}/actions/change_home_directory`, { body }))),
    );

    server.tool(
        "reset_storage_box_subaccount_password",
        `Set a new password for a subaccount. ${POLL}`,
        { id: boxId, subaccount_id: subaccountId, password },
        async ({ id, subaccount_id, ...body }) => withToolError(async () =>
            json(await sb("POST", `${subPath(id, subaccount_id)}/actions/reset_subaccount_password`, { body }))),
    );

    server.tool(
        "update_storage_box_subaccount_access_settings",
        `Update a subaccount's access settings incl. readonly (partial: omitted fields are unchanged). ${POLL}`,
        { id: boxId, subaccount_id: subaccountId, ...subAccess },
        async ({ id, subaccount_id, ...body }) => withToolError(async () => {
            if (Object.keys(body).length === 0) throw new Error("Provide at least one access setting");
            return json(await sb("POST", `${subPath(id, subaccount_id)}/actions/update_access_settings`, { body }));
        }),
    );

    // --- Snapshots ---
    server.tool(
        "list_storage_box_snapshots",
        "List snapshots of a Storage Box (manual and automatic; is_automatic filters)",
        { id: boxId, name: z.string().optional(), label_selector: labelSelector, is_automatic: z.boolean().optional(), sort },
        async ({ id, ...query }) => withToolError(async () =>
            json((await sb("GET", `${boxPath(id)}/snapshots`, { query })).snapshots)),
    );

    server.tool(
        "get_storage_box_snapshot",
        "Get a Storage Box snapshot (name, description, size stats, is_automatic)",
        { id: boxId, snapshot_id: snapshotId },
        async ({ id, snapshot_id }) => withToolError(async () =>
            json((await sb("GET", snapPath(id, snapshot_id))).snapshot)),
    );

    server.tool(
        "create_storage_box_snapshot",
        `Create a manual snapshot (limited by the type's snapshot_limit). Returns {snapshot: {id, storage_box}, action}; ${POLL}, then get_storage_box_snapshot for details`,
        { id: boxId, description: z.string().optional(), labels: labels.optional() },
        async ({ id, ...body }) => withToolError(async () => json(await sb("POST", `${boxPath(id)}/snapshots`, { body }))),
    );

    server.tool(
        "update_storage_box_snapshot",
        "Update a snapshot's description and/or labels (labels replace the whole set)",
        { id: boxId, snapshot_id: snapshotId, description: z.string().optional(), labels: labels.optional() },
        async ({ id, snapshot_id, ...body }) => withToolError(async () =>
            json((await sb("PUT", snapPath(id, snapshot_id), { body })).snapshot)),
    );

    server.tool(
        "delete_storage_box_snapshot",
        `Delete a snapshot. ${CONFIRM}. ${POLL}`,
        { id: boxId, snapshot_id: snapshotId },
        async ({ id, snapshot_id }) => withToolError(async () => json(await sb("DELETE", snapPath(id, snapshot_id)))),
    );
}
