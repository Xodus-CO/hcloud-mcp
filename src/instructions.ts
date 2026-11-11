// Sent to MCP clients in the initialize response; most clients put it in the model's context.
// Keep it short and about how to use the tools, not a list of them.
export const SERVER_INSTRUCTIONS = `Hetzner Cloud API tools. Notes:

- Placement is by location (fsn1, nbg1, hel1, ash, hil, sin), not datacenter. Datacenters were removed from the API in 2026.
- Before create_server, call list_server_types. Each type has locations[] with available, recommended and deprecation. Pick a location where the type is available and not deprecated. Call list_images and skip any image whose deprecation is set.
- Most create, delete and action tools return an Action. They run asynchronously. Poll get_action until status is "success" or "error" before you start a step that depends on the result.
- Detach first, then delete. Floating IPs and Primary IPs must be unassigned before deletion (error must_be_unassigned). Assigning or unassigning a Primary IP requires the server to be powered off. Detach volumes and remove LB targets before you delete their servers.
- Firewall CIDRs must not have host bits set. Use 10.0.1.0/24, not 10.0.1.42/24. For a single host use /32 or /128.
- For private networks use subnet type "cloud". Type "server" is deprecated.
- List tools return all pages. In large projects, prefer get_* by ID when you already know it.
- Destructive tools (delete_*, rebuild_server, import_zonefile, reset_server, change_server_type, power_off_server) act immediately with no undo. Confirm with the user before using them on resources you did not create in this session.
- Reverse DNS: change_dns_ptr always needs dns_ptr. Pass a hostname to set it, or null to reset it.
- DNS: zones are referenced by ID or name (example.com). RRSet names are relative to the zone ("@" is the apex) and lowercase. TXT values must be quoted ("\"v=spf1 -all\""). Use add_rrset_records to append (it creates the RRSet if missing). set_rrset_records replaces all records and import_zonefile replaces the whole zone, so export_zonefile first as a backup. change_rrset_ttl needs ttl, or null for the zone default. A new zone only answers once the registrar delegates the domain to its authoritative_nameservers.
- Protected resources fail with "protected" (423). Use change_protection with delete:false, but only after the user confirms. For servers, delete and rebuild protection must have the same value.
- Secrets: root_password (from rebuild_server, enable_rescue and reset_root_password), console wss_url and passwords, and Storage Box passwords go to the user and nowhere else. Never put them in files, labels or later tool calls. A request_console URL expires after 60 seconds.
- Before risky changes (rebuild, change_type), offer create_snapshot. Power the server off first for a consistent disk. disable_server_backups deletes all existing backups immediately.
- Labels in update_* tools replace the whole set. Read the current labels and merge them first.
- Metrics: call get_*_metrics with last_minutes and include_values=false first. CPU is per vCPU (100 = one full core).
- Managed certificates only work for domains in a primary Hetzner DNS zone that is delegated to Hetzner. Certificates are attached to load balancers through http.certificates on update_load_balancer_service.
- Storage Boxes live on api.hetzner.com and use the same token. Poll their actions with get_storage_box_action. rollback_storage_box_snapshot discards everything newer than the snapshot.
- Pricing: get_pricing returns prices per location and server type, in EUR, with and without VAT.`;
