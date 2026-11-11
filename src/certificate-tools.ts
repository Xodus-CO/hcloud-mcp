// TLS Certificates (Cloud API /certificates) for Load Balancer HTTPS services.
// Uses the direct client in hcloud-api.ts. The API never returns private keys; tool
// output is always the API response, never the request arguments.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hcloudRequest } from "./hcloud-api.js";
import { json, listAll, withToolError } from "./tool-helpers.js";

const certId = z.number().int().describe("Certificate ID");
const certType = z.enum(["uploaded", "managed"]);
const labels = z.record(z.string());

const MANAGED_REQUIREMENTS =
    "Managed (Let's Encrypt) certificates are validated via DNS: every domain must be in a PRIMARY Hetzner DNS zone (create_zone) " +
    "that is delegated to Hetzner's nameservers at the registrar, and any CAA record must allow Let's Encrypt. " +
    "Typical failures: dns_zone_not_found, dns_zone_is_secondary_zone, could_not_verify_domain_delegated_to_zone, " +
    "caa_record_does_not_allow_ca, ca_dns_validation_failed, Let's Encrypt rate limits";

const USAGE =
    "Certificates are referenced by ID in Load Balancer HTTPS services: http.certificates in add_load_balancer_service / update_load_balancer_service";

export function registerCertificateTools(server: McpServer) {
    server.tool(
        "list_certificates",
        "List TLS certificates (all pages). Optional filters: name, label_selector, type. Each includes domain_names, not_valid_after, fingerprint, managed status and used_by (load balancers using it)",
        {
            name: z.string().optional().describe("Exact certificate name"),
            label_selector: z.string().optional().describe("Label selector, e.g. env=prod"),
            type: z.array(certType).optional().describe("Filter by type(s)"),
        },
        async (args) => withToolError(async () => {
            const certs = await listAll(
                (p) => hcloudRequest("GET", "/certificates", { query: { ...args, ...p } }),
                "certificates",
            );
            return json(certs);
        }),
    );

    server.tool(
        "get_certificate",
        "Get a TLS certificate: PEM chain (public), domain_names, validity window, fingerprint, used_by, and for managed certs status.issuance / status.renewal / status.error",
        { id: certId },
        async ({ id }) => withToolError(async () => json((await hcloudRequest("GET", `/certificates/${id}`)).certificate)),
    );

    server.tool(
        "create_certificate",
        "Create a TLS certificate. type \"uploaded\" (default): provide certificate (PEM, leaf first then chain) and private_key (PEM); " +
            "supported keys RSA 2048/3072/4096 or ECDSA P-256/P-384; you must renew it yourself before not_valid_after. " +
            "type \"managed\": provide domain_names; Hetzner requests and auto-renews a Let's Encrypt cert. " +
            MANAGED_REQUIREMENTS +
            ". Returns {certificate, action}: action tracks managed issuance (poll get_action), null for uploaded. " +
            USAGE,
        {
            name: z.string().describe("Unique name within the project"),
            type: certType.default("uploaded"),
            certificate: z.string().optional().describe("uploaded only: certificate + chain in PEM, each cert certifying the preceding one"),
            private_key: z.string().optional().describe("uploaded only: private key in PEM. Sent to the API only; never returned"),
            domain_names: z.array(z.string()).optional().describe('managed only: domains to include, e.g. ["example.com", "www.example.com"]'),
            labels: labels.optional(),
        },
        async (args) => withToolError(async () => {
            const { name, type, certificate, private_key, domain_names, labels } = args;
            let body: Record<string, unknown>;
            if (type === "uploaded") {
                if (!certificate || !private_key) throw new Error("type=uploaded requires both certificate and private_key (PEM)");
                if (domain_names?.length) throw new Error("domain_names is only valid for type=managed (uploaded certs take their domains from the PEM)");
                body = { name, type, certificate, private_key, labels };
            } else {
                if (!domain_names?.length) throw new Error("type=managed requires a non-empty domain_names list");
                if (certificate || private_key) throw new Error("certificate/private_key are only valid for type=uploaded");
                body = { name, type, domain_names, labels };
            }
            return json(await hcloudRequest("POST", "/certificates", { body }));
        }),
    );

    server.tool(
        "update_certificate",
        "Rename a certificate and/or replace its labels (labels overwrite the whole set). The certificate content cannot be changed; to rotate an uploaded cert, create a new one, point the load balancer service at it, then delete the old one",
        { id: certId, name: z.string().optional(), labels: labels.optional() },
        async ({ id, name, labels }) => withToolError(async () => {
            if (name === undefined && labels === undefined) throw new Error("Provide name and/or labels");
            return json((await hcloudRequest("PUT", `/certificates/${id}`, { body: { name, labels } })).certificate);
        }),
    );

    server.tool(
        "delete_certificate",
        "Delete a certificate. Irreversible; confirm with the user first. Check used_by (get_certificate) first: load balancer HTTPS services referencing it should be switched to another certificate",
        { id: certId },
        async ({ id }) => withToolError(async () => {
            await hcloudRequest("DELETE", `/certificates/${id}`);
            return json({ deleted: id });
        }),
    );

    server.tool(
        "retry_certificate",
        "Retry a failed issuance or renewal of a managed certificate (only when status.issuance or status.renewal is \"failed\"; see status.error for the cause and fix it first). " +
            MANAGED_REQUIREMENTS +
            ". Returns an Action (poll get_action)",
        { id: certId },
        async ({ id }) => withToolError(async () => json(await hcloudRequest("POST", `/certificates/${id}/actions/retry`))),
    );
}
