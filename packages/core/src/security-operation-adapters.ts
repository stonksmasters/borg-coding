import { z } from "zod";
import type { ExecutionResult } from "./execution-provider.ts";
import type { SecurityExecutionRecord, SecurityTarget } from "./security-domain.ts";
import type { KaliMcpInvocation } from "./kali-mcp-provider.ts";

export type SecurityOperationCommand = {
  executable: string;
  args: string[];
  timeoutMs: number;
};

export interface SecurityOperationAdapter<O> {
  readonly id: string;
  readonly classification: SecurityExecutionRecord["classification"];
  readonly requiredCapability: string;
  validate(targets: SecurityTarget[]): SecurityTarget[];
  buildExecution(targets: SecurityTarget[]): SecurityOperationCommand;
  buildMcpInvocation(targets: SecurityTarget[]): KaliMcpInvocation;
  acceptsResult?(result: ExecutionResult): boolean;
  parse(result: ExecutionResult, targets: SecurityTarget[]): O;
}

function quote(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new Error("MCP command arguments may not contain control characters.");
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function commandInvocation(command: SecurityOperationCommand): KaliMcpInvocation {
  return {
    mcpTool: "execute_command",
    arguments: { command: [command.executable, ...command.args].map(quote).join(" ") },
    timeoutMs: command.timeoutMs,
    expectedArtifacts: ["stdout", "stderr"],
    underlyingExecutable: command.executable,
  };
}

const DnsTargetSchema = z.array(z.object({
  kind: z.literal("domain"),
  value: z.string().trim().min(1),
})).length(1);

export type NormalizedDnsLookup = {
  operation: "dns_lookup";
  domain: string;
  records: Array<{ name: string; ttl: number; class: string; type: string; value: string }>;
};

export const dnsLookupAdapter: SecurityOperationAdapter<NormalizedDnsLookup> = {
  id: "dns_lookup",
  classification: "passive",
  requiredCapability: "dig",
  validate(targets) {
    return DnsTargetSchema.parse(targets);
  },
  buildExecution(targets) {
    const [target] = DnsTargetSchema.parse(targets);
    return {
      executable: "dig",
      args: [target.value, "+noall", "+answer", "+comments"],
      timeoutMs: 15_000,
    };
  },
  buildMcpInvocation(targets) { return commandInvocation(this.buildExecution(targets)); },
  parse(result, targets) {
    const records = result.stdout.split(/\r?\n/).flatMap((line) => {
      const value = line.trim();
      if (!value || value.startsWith(";")) return [];
      const match = value.match(/^(\S+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/);
      if (!match) return [];
      return [{ name: match[1], ttl: Number(match[2]), class: match[3], type: match[4], value: match[5] }];
    });
    if (records.length === 0) throw new Error("dig returned no parseable DNS answer records.");
    return { operation: "dns_lookup", domain: DnsTargetSchema.parse(targets)[0].value, records };
  },
};

const ServiceTargetSchema = z.array(z.object({
  kind: z.literal("host"),
  value: z.string().trim().min(1),
})).length(1);

export type NormalizedServiceInventory = {
  operation: "service_inventory";
  host: string;
  services: Array<{ port: number; protocol: string; state: string; service: string; product: string | null; version: string | null }>;
};

function xmlAttribute(source: string, name: string): string | null {
  const match = source.match(new RegExp(`${name}="([^"]*)"`));
  return match?.[1] ?? null;
}

export const serviceInventoryAdapter: SecurityOperationAdapter<NormalizedServiceInventory> = {
  id: "service_inventory",
  classification: "active_recon",
  requiredCapability: "nmap",
  validate(targets) {
    return ServiceTargetSchema.parse(targets);
  },
  buildExecution(targets) {
    const [target] = ServiceTargetSchema.parse(targets);
    return {
      executable: "nmap",
      args: ["-Pn", "-sT", "-sV", "--version-light", "--top-ports", "100", "-oX", "-", "--", target.value],
      timeoutMs: 120_000,
    };
  },
  buildMcpInvocation(targets) {
    return {
      ...commandInvocation(this.buildExecution(targets)),
      expectedArtifacts: ["network_services", "stdout", "stderr"],
    };
  },
  parse(result, targets) {
    if (!result.stdout.includes("<nmaprun")) throw new Error("nmap did not return XML output.");
    const services = [...result.stdout.matchAll(/<port\s+([^>]+)>([\s\S]*?)<\/port>/g)].map((match) => {
      const port = Number(xmlAttribute(match[1], "portid"));
      const protocol = xmlAttribute(match[1], "protocol") ?? "unknown";
      const stateTag = match[2].match(/<state\s+([^>]+)\/?\s*>/);
      const serviceTag = match[2].match(/<service\s+([^>]+)\/?\s*>/);
      return {
        port,
        protocol,
        state: stateTag ? xmlAttribute(stateTag[1], "state") ?? "unknown" : "unknown",
        service: serviceTag ? xmlAttribute(serviceTag[1], "name") ?? "unknown" : "unknown",
        product: serviceTag ? xmlAttribute(serviceTag[1], "product") : null,
        version: serviceTag ? xmlAttribute(serviceTag[1], "version") : null,
      };
    }).filter((service) => Number.isInteger(service.port));
    return { operation: "service_inventory", host: ServiceTargetSchema.parse(targets)[0].value, services };
  },
};

const HostOrCidrTargetSchema = z.array(z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("host"), value: z.string().trim().min(1).max(255) }),
  z.object({ kind: z.literal("cidr"), value: z.string().trim().min(1).max(64) }),
])).length(1);

export const arpScanDiscoveryAdapter: SecurityOperationAdapter<{ operation: "arp_scan_discovery"; network: string; hosts: Array<{ address: string; mac: string; vendor: string | null }> }> = {
  id: "arp_scan_discovery", classification: "active_recon", requiredCapability: "arp-scan",
  validate(targets) {
    const parsed = HostOrCidrTargetSchema.parse(targets);
    if (parsed[0].kind !== "cidr") throw new Error("ARP discovery requires an explicitly authorized CIDR target.");
    return parsed;
  },
  buildExecution(targets) {
    const target = this.validate(targets)[0].value;
    return { executable: "sudo", args: ["-n", "arp-scan", "--plain", "--ignoredups", "--retry=2", "--timeout=500", target], timeoutMs: 90_000 };
  },
  buildMcpInvocation(targets) { return { ...commandInvocation(this.buildExecution(targets)), expectedArtifacts: ["network_hosts", "stdout", "stderr"] }; },
  parse(result, targets) {
    const hosts = result.stdout.split(/\r?\n/).flatMap((line) => {
      const match = line.match(/^(\d{1,3}(?:\.\d{1,3}){3})\s+([0-9a-f]{2}(?::[0-9a-f]{2}){5})(?:\s+(.+))?$/i);
      return match ? [{ address: match[1], mac: match[2].toLowerCase(), vendor: match[3]?.trim() || null }] : [];
    });
    return { operation: "arp_scan_discovery", network: this.validate(targets)[0].value, hosts };
  },
};

export const fpingReachabilityAdapter: SecurityOperationAdapter<{ operation: "fping_reachability"; target: string; alive: string[] }> = {
  id: "fping_reachability", classification: "active_recon", requiredCapability: "fping",
  validate(targets) { return HostOrCidrTargetSchema.parse(targets); },
  buildExecution(targets) {
    const target = HostOrCidrTargetSchema.parse(targets)[0];
    return { executable: "fping", args: ["-4", "-a", "-r", "1", "-t", "500", "-i", "20", ...(target.kind === "cidr" ? ["-g"] : []), target.value], timeoutMs: 90_000 };
  },
  buildMcpInvocation(targets) { return { ...commandInvocation(this.buildExecution(targets)), expectedArtifacts: ["network_hosts", "stdout", "stderr"] }; },
  acceptsResult(result) { return result.exitCode === 0 || result.exitCode === 1; },
  parse(result, targets) {
    const alive = [...new Set(result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^(?:\d{1,3}\.){3}\d{1,3}$/.test(line)))];
    return { operation: "fping_reachability", target: HostOrCidrTargetSchema.parse(targets)[0].value, alive };
  },
};

export const ikeServiceProbeAdapter: SecurityOperationAdapter<{ operation: "ike_service_probe"; host: string; responders: Array<{ address: string; summary: string }> }> = {
  id: "ike_service_probe", classification: "active_recon", requiredCapability: "ike-scan",
  validate(targets) { return ServiceTargetSchema.parse(targets); },
  buildExecution(targets) {
    const host = ServiceTargetSchema.parse(targets)[0].value;
    return { executable: "ike-scan", args: ["--retry=2", "--timeout=500", "--interval=20", host], timeoutMs: 45_000 };
  },
  buildMcpInvocation(targets) { return { ...commandInvocation(this.buildExecution(targets)), expectedArtifacts: ["network_services", "stdout", "stderr"] }; },
  parse(result, targets) {
    const responders = result.stdout.split(/\r?\n/).flatMap((line) => {
      const match = line.match(/^(\d{1,3}(?:\.\d{1,3}){3})\s+(.+)$/);
      return match && !/hosts scanned/i.test(match[2]) ? [{ address: match[1], summary: match[2].trim() }] : [];
    });
    return { operation: "ike_service_probe", host: ServiceTargetSchema.parse(targets)[0].value, responders };
  },
};

type SmbFinding = { name: string; type: string | null; comment: string | null };

function parseSmbShares(output: string): SmbFinding[] {
  const shares: SmbFinding[] = [];
  for (const line of output.split(/\r?\n/)) {
    const grepable = line.match(/^Disk\|([^|]+)\|?(.*)$/i);
    if (grepable) { shares.push({ name: grepable[1].trim(), type: "Disk", comment: grepable[2]?.trim() || null }); continue; }
    const table = line.match(/^\s*([^\s]+)\s+(Disk|IPC|Printer)\s*(.*)$/i);
    if (table) shares.push({ name: table[1], type: table[2], comment: table[3]?.trim() || null });
  }
  return [...new Map(shares.map((share) => [`${share.type}:${share.name}`, share])).values()];
}

export const enum4linuxHostAuditAdapter: SecurityOperationAdapter<{ operation: "enum4linux_host_audit"; host: string; shares: SmbFinding[]; observations: string[] }> = {
  id: "enum4linux_host_audit", classification: "active_recon", requiredCapability: "enum4linux",
  validate(targets) { return ServiceTargetSchema.parse(targets); },
  buildExecution(targets) {
    const host = ServiceTargetSchema.parse(targets)[0].value;
    return { executable: "enum4linux", args: ["-S", "-P", "-o", "-n", host], timeoutMs: 180_000 };
  },
  buildMcpInvocation(targets) { return { ...commandInvocation(this.buildExecution(targets)), expectedArtifacts: ["network_services", "shares", "stdout", "stderr"] }; },
  parse(result, targets) {
    const observations = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^(Domain Name|Domain Sid|OS information|Workgroup|Server|Password)/i.test(line)).slice(0, 100);
    return { operation: "enum4linux_host_audit", host: ServiceTargetSchema.parse(targets)[0].value, shares: parseSmbShares(result.stdout), observations };
  },
};

export const smbAnonymousShareListAdapter: SecurityOperationAdapter<{ operation: "smb_anonymous_share_list"; host: string; shares: SmbFinding[] }> = {
  id: "smb_anonymous_share_list", classification: "active_recon", requiredCapability: "smbclient",
  validate(targets) { return ServiceTargetSchema.parse(targets); },
  buildExecution(targets) {
    const host = ServiceTargetSchema.parse(targets)[0].value;
    return { executable: "smbclient", args: ["-g", "-N", "-L", host, "-t", "10", "--option=client min protocol=SMB2"], timeoutMs: 60_000 };
  },
  buildMcpInvocation(targets) { return { ...commandInvocation(this.buildExecution(targets)), expectedArtifacts: ["shares", "stdout", "stderr"] }; },
  acceptsResult(result) { return result.exitCode === 0 || (result.exitCode === 1 && /NT_STATUS_(?:CONNECTION_REFUSED|LOGON_FAILURE|ACCESS_DENIED|IO_TIMEOUT|HOST_UNREACHABLE)/i.test(`${result.stdout}\n${result.stderr}`)); },
  parse(result, targets) { return { operation: "smb_anonymous_share_list", host: ServiceTargetSchema.parse(targets)[0].value, shares: parseSmbShares(result.stdout) }; },
};

export const smbMapAnonymousAdapter: SecurityOperationAdapter<{ operation: "smbmap_anonymous"; host: string; shares: Array<SmbFinding & { permissions: string | null }> }> = {
  id: "smbmap_anonymous", classification: "active_recon", requiredCapability: "smbmap",
  validate(targets) { return ServiceTargetSchema.parse(targets); },
  buildExecution(targets) {
    const host = ServiceTargetSchema.parse(targets)[0].value;
    return { executable: "smbmap", args: ["-H", host, "-u", "", "-p", "", "--no-banner", "--no-color", "--no-update", "--timeout", "3", "--no-write-check"], timeoutMs: 90_000 };
  },
  buildMcpInvocation(targets) { return { ...commandInvocation(this.buildExecution(targets)), expectedArtifacts: ["shares", "permissions", "stdout", "stderr"] }; },
  parse(result, targets) {
    const shares = result.stdout.split(/\r?\n/).flatMap((line) => {
      const match = line.match(/^\s*([^\s]+)\s+(READ ONLY|READ,\s*WRITE|WRITE ONLY|NO ACCESS|READ|WRITE)\s*(.*)$/i);
      return match ? [{ name: match[1], type: "Disk", comment: match[3]?.trim() || null, permissions: match[2].toUpperCase() }] : [];
    });
    return { operation: "smbmap_anonymous", host: ServiceTargetSchema.parse(targets)[0].value, shares };
  },
};

const FileTargetSchema = z.array(z.object({
  kind: z.literal("file"),
  value: z.string().trim().min(2).max(2048).refine((value) => value.startsWith("/") && !/[\0\r\n]/.test(value), "A safe absolute path on the execution node is required."),
})).length(1);

const QueryTargetSchema = z.array(z.object({
  kind: z.literal("query"),
  value: z.string().trim().min(2).max(200).refine((value) => !value.startsWith("-") && !/[\0\r\n]/.test(value), "A safe software or CVE query is required."),
})).length(1);

export const exiftoolMetadataAdapter: SecurityOperationAdapter<{ operation: "exiftool_metadata"; file: string; metadata: Record<string, unknown> }> = {
  id: "exiftool_metadata", classification: "passive", requiredCapability: "exiftool",
  validate(targets) { return FileTargetSchema.parse(targets); },
  buildExecution(targets) { return { executable: "exiftool", args: ["-json", "-G1", "-n", "--", FileTargetSchema.parse(targets)[0].value], timeoutMs: 60_000 }; },
  buildMcpInvocation(targets) { return { ...commandInvocation(this.buildExecution(targets)), expectedArtifacts: ["file_metadata", "stdout", "stderr"] }; },
  parse(result, targets) {
    const values = z.array(z.record(z.string(), z.unknown())).parse(JSON.parse(result.stdout));
    return { operation: "exiftool_metadata", file: FileTargetSchema.parse(targets)[0].value, metadata: values[0] ?? {} };
  },
};

export const hashdeepFileHashAdapter: SecurityOperationAdapter<{ operation: "hashdeep_file_hash"; file: string; sha256: string | null }> = {
  id: "hashdeep_file_hash", classification: "passive", requiredCapability: "hashdeep",
  validate(targets) { return FileTargetSchema.parse(targets); },
  buildExecution(targets) { return { executable: "hashdeep", args: ["-c", "sha256", "-b", "--", FileTargetSchema.parse(targets)[0].value], timeoutMs: 120_000 }; },
  buildMcpInvocation(targets) { return { ...commandInvocation(this.buildExecution(targets)), expectedArtifacts: ["file_hashes", "stdout", "stderr"] }; },
  parse(result, targets) {
    const sha256 = result.stdout.match(/\b([a-f0-9]{64})(?=,|\s)/i)?.[1]?.toLowerCase() ?? null;
    return { operation: "hashdeep_file_hash", file: FileTargetSchema.parse(targets)[0].value, sha256 };
  },
};

export const binwalkSignatureAdapter: SecurityOperationAdapter<{ operation: "binwalk_signature_scan"; file: string; signatures: Array<{ offset: number; description: string }> }> = {
  id: "binwalk_signature_scan", classification: "passive", requiredCapability: "binwalk",
  validate(targets) { return FileTargetSchema.parse(targets); },
  buildExecution(targets) { return { executable: "binwalk", args: ["--signature", "--term", FileTargetSchema.parse(targets)[0].value], timeoutMs: 180_000 }; },
  buildMcpInvocation(targets) { return { ...commandInvocation(this.buildExecution(targets)), expectedArtifacts: ["binary_analysis", "stdout", "stderr"] }; },
  parse(result, targets) {
    const signatures = result.stdout.split(/\r?\n/).flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s+0x[0-9A-F]+\s+(.+)$/i);
      return match ? [{ offset: Number(match[1]), description: match[2].trim() }] : [];
    });
    return { operation: "binwalk_signature_scan", file: FileTargetSchema.parse(targets)[0].value, signatures };
  },
};

export const tsharkCaptureAnalysisAdapter: SecurityOperationAdapter<{ operation: "tshark_capture_analysis"; file: string; packets: Array<{ number: number; timestamp: number | null; source: string | null; sourcePort: number | null; destination: string | null; destinationPort: number | null; protocol: string | null }> }> = {
  id: "tshark_capture_analysis", classification: "passive", requiredCapability: "tshark",
  validate(targets) { return FileTargetSchema.parse(targets); },
  buildExecution(targets) {
    return { executable: "tshark", args: ["-r", FileTargetSchema.parse(targets)[0].value, "-n", "-c", "1000", "-T", "fields", "-E", "separator=/t", "-e", "frame.number", "-e", "frame.time_epoch", "-e", "ip.src", "-e", "ipv6.src", "-e", "tcp.srcport", "-e", "udp.srcport", "-e", "ip.dst", "-e", "ipv6.dst", "-e", "tcp.dstport", "-e", "udp.dstport", "-e", "_ws.col.Protocol"], timeoutMs: 180_000 };
  },
  buildMcpInvocation(targets) { return { ...commandInvocation(this.buildExecution(targets)), expectedArtifacts: ["packet_analysis", "stdout", "stderr"] }; },
  parse(result, targets) {
    const packets = result.stdout.split(/\r?\n/).flatMap((line) => {
      const fields = line.split("\t");
      const number = Number(fields[0]);
      if (!Number.isInteger(number)) return [];
      const numberOrNull = (value?: string) => value && /^\d+$/.test(value) ? Number(value) : null;
      return [{ number, timestamp: fields[1] && Number.isFinite(Number(fields[1])) ? Number(fields[1]) : null, source: fields[2] || fields[3] || null, sourcePort: numberOrNull(fields[4]) ?? numberOrNull(fields[5]), destination: fields[6] || fields[7] || null, destinationPort: numberOrNull(fields[8]) ?? numberOrNull(fields[9]), protocol: fields[10] || null }];
    });
    return { operation: "tshark_capture_analysis", file: FileTargetSchema.parse(targets)[0].value, packets };
  },
};

export const searchsploitLookupAdapter: SecurityOperationAdapter<{ operation: "searchsploit_lookup"; query: string; matches: Array<{ id: string | null; title: string; path: string | null; type: string | null; platform: string | null }> }> = {
  id: "searchsploit_lookup", classification: "passive", requiredCapability: "searchsploit",
  validate(targets) { return QueryTargetSchema.parse(targets); },
  buildExecution(targets) { return { executable: "searchsploit", args: ["--json", QueryTargetSchema.parse(targets)[0].value], timeoutMs: 60_000 }; },
  buildMcpInvocation(targets) { return { ...commandInvocation(this.buildExecution(targets)), expectedArtifacts: ["vulnerability_references", "stdout", "stderr"] }; },
  parse(result, targets) {
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    const rows = [payload.RESULTS_EXPLOIT, payload.RESULTS_SHELLCODE, payload.RESULTS_PAPER].flatMap((value) => Array.isArray(value) ? value : []);
    const matches = rows.flatMap((row) => {
      if (!row || typeof row !== "object") return [];
      const item = row as Record<string, unknown>;
      const title = typeof item.Title === "string" ? item.Title : typeof item.title === "string" ? item.title : null;
      if (!title) return [];
      return [{ id: typeof item["EDB-ID"] === "string" ? item["EDB-ID"] : typeof item.id === "string" ? item.id : null, title, path: typeof item.Path === "string" ? item.Path : null, type: typeof item.Type === "string" ? item.Type : null, platform: typeof item.Platform === "string" ? item.Platform : null }];
    });
    return { operation: "searchsploit_lookup", query: QueryTargetSchema.parse(targets)[0].value, matches };
  },
};

const EmailTargetSchema = z.array(z.object({ kind: z.literal("email"), value: z.string().trim().email() })).length(1);
export const publicEmailSearchAdapter: SecurityOperationAdapter<{ operation: "public_email_search"; email: string; references: string[] }> = {
  id: "public_email_search", classification: "passive", requiredCapability: "theharvester",
  validate(targets) { return EmailTargetSchema.parse(targets); },
  buildExecution(targets) {
    const email = EmailTargetSchema.parse(targets)[0].value.toLowerCase();
    const domain = email.slice(email.lastIndexOf("@") + 1);
    return { executable: "theHarvester", args: ["-d", domain, "-b", "all"], timeoutMs: 120_000 };
  },
  buildMcpInvocation(targets) { return commandInvocation(this.buildExecution(targets)); },
  parse(result, targets) {
    const email = EmailTargetSchema.parse(targets)[0].value.toLowerCase();
    const references = [...new Set(result.stdout.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)?.map((value) => value.toLowerCase()).filter((value) => value === email) ?? [])];
    return { operation: "public_email_search", email, references };
  },
};

const UsernameTargetSchema = z.array(z.object({ kind: z.literal("username"), value: z.string().trim().min(1).max(100) })).length(1);
export const publicUsernameSearchAdapter: SecurityOperationAdapter<{ operation: "public_username_search"; username: string; profiles: string[] }> = {
  id: "public_username_search", classification: "passive", requiredCapability: "sherlock",
  validate(targets) { return UsernameTargetSchema.parse(targets); },
  buildExecution(targets) {
    const username = UsernameTargetSchema.parse(targets)[0].value;
    return { executable: "sherlock", args: ["--print-found", "--no-color", "--timeout", "10", username], timeoutMs: 180_000 };
  },
  buildMcpInvocation(targets) { return commandInvocation(this.buildExecution(targets)); },
  parse(result, targets) {
    const username = UsernameTargetSchema.parse(targets)[0].value;
    const profiles = [...new Set(result.stdout.split(/\r?\n/).flatMap((line) => {
      const match = line.match(/^\[\+\]\s+[^:]+:\s+(https?:\/\/\S+)\s*$/);
      return match ? [match[1]] : [];
    }))];
    return { operation: "public_username_search", username, profiles };
  },
};

function urlsFromOutput(value: string): string[] {
  return [...new Set(value.match(/https?:\/\/[^\s"'<>]+/gi) ?? [])];
}

export const maigretUsernameSearchAdapter: SecurityOperationAdapter<{ operation: "maigret_username_search"; username: string; profiles: string[] }> = {
  id: "maigret_username_search", classification: "passive", requiredCapability: "maigret",
  validate(targets) { return UsernameTargetSchema.parse(targets); },
  buildExecution(targets) {
    const username = UsernameTargetSchema.parse(targets)[0].value;
    return {
      executable: "maigret",
      args: ["--no-color", "--no-progressbar", "--folderoutput", "/tmp/borg-maigret-reports", "--timeout", "10", username],
      timeoutMs: 240_000,
    };
  },
  buildMcpInvocation(targets) { return commandInvocation(this.buildExecution(targets)); },
  acceptsResult(result) {
    if (result.exitCode === 0) return true;
    const output = `${result.stdout}\n${result.stderr}`;
    return result.exitCode === 2 && /Short text report:[\s\S]*Search by username/i.test(output);
  },
  parse(result, targets) {
    const profiles = [...new Set(result.stdout.split(/\r?\n/).flatMap((line) => {
      const match = line.match(/^\[\+\]\s+[^:]+:\s+(https?:\/\/\S+)\s*$/);
      return match ? [match[1]] : [];
    }))];
    return { operation: "maigret_username_search", username: UsernameTargetSchema.parse(targets)[0].value, profiles };
  },
};

export const maigretFullUsernameSearchAdapter: SecurityOperationAdapter<{ operation: "maigret_full_username_search"; username: string; profiles: string[] }> = {
  id: "maigret_full_username_search", classification: "passive", requiredCapability: "maigret",
  validate(targets) { return UsernameTargetSchema.parse(targets); },
  buildExecution(targets) {
    const username = UsernameTargetSchema.parse(targets)[0].value;
    return {
      executable: "maigret",
      args: ["--all-sites", "--no-color", "--no-progressbar", "--folderoutput", "/tmp/borg-maigret-reports", "--timeout", "10", "--retries", "1", username],
      timeoutMs: 30 * 60 * 1000,
    };
  },
  buildMcpInvocation(targets) { return commandInvocation(this.buildExecution(targets)); },
  acceptsResult: maigretUsernameSearchAdapter.acceptsResult,
  parse(result, targets) {
    const profiles = [...new Set(result.stdout.split(/\r?\n/).flatMap((line) => {
      const match = line.match(/^\[\+\]\s+[^:]+:\s+(https?:\/\/\S+)\s*$/);
      return match ? [match[1]] : [];
    }))];
    return { operation: "maigret_full_username_search", username: UsernameTargetSchema.parse(targets)[0].value, profiles };
  },
};

export const emailAccountSearchAdapter: SecurityOperationAdapter<{ operation: "email_account_search"; email: string; services: string[] }> = {
  id: "email_account_search", classification: "passive", requiredCapability: "holehe",
  validate(targets) { return EmailTargetSchema.parse(targets); },
  buildExecution(targets) {
    const email = EmailTargetSchema.parse(targets)[0].value.toLowerCase();
    return { executable: "holehe", args: ["--only-used", "--no-color", email], timeoutMs: 180_000 };
  },
  buildMcpInvocation(targets) { return commandInvocation(this.buildExecution(targets)); },
  parse(result, targets) {
    const services = [...new Set(result.stdout.split(/\r?\n/).flatMap((line) => {
      const match = line.match(/^\[\+\]\s+([A-Za-z0-9_.-]+)/);
      return match ? [match[1]] : [];
    }))];
    return { operation: "email_account_search", email: EmailTargetSchema.parse(targets)[0].value.toLowerCase(), services };
  },
};

const PhoneTargetSchema = z.array(z.object({ kind: z.literal("phone"), value: z.string().trim().min(3).max(50) })).length(1);
export const phoneEnrichmentAdapter: SecurityOperationAdapter<{ operation: "phone_enrichment"; phone: string; details: Record<string, unknown>; references: string[] }> = {
  id: "phone_enrichment", classification: "passive", requiredCapability: "phoneinfoga",
  validate(targets) { return PhoneTargetSchema.parse(targets); },
  buildExecution(targets) {
    const phone = PhoneTargetSchema.parse(targets)[0].value;
    return { executable: "phoneinfoga", args: ["scan", "-n", phone], timeoutMs: 120_000 };
  },
  buildMcpInvocation(targets) { return commandInvocation(this.buildExecution(targets)); },
  parse(result, targets) {
    let details: Record<string, unknown> = {};
    try { details = JSON.parse(result.stdout) as Record<string, unknown>; } catch { details = { rawSummary: result.stdout.trim() }; }
    return { operation: "phone_enrichment", phone: PhoneTargetSchema.parse(targets)[0].value, details, references: urlsFromOutput(result.stdout) };
  },
};

export const domainReconAdapter: SecurityOperationAdapter<{ operation: "domain_recon"; domain: string; records: unknown[] }> = {
  id: "domain_recon", classification: "passive", requiredCapability: "dnsrecon",
  validate(targets) { return DnsTargetSchema.parse(targets); },
  buildExecution(targets) {
    const domain = DnsTargetSchema.parse(targets)[0].value;
    return { executable: "dnsrecon", args: ["-d", domain, "-t", "std", "-j", "/dev/stdout"], timeoutMs: 120_000 };
  },
  buildMcpInvocation(targets) { return commandInvocation(this.buildExecution(targets)); },
  parse(result, targets) {
    let records: unknown[] = [];
    const start = result.stdout.indexOf("[\n");
    const end = result.stdout.lastIndexOf("]");
    try {
      const parsed = JSON.parse(start >= 0 && end >= start ? result.stdout.slice(start, end + 1) : result.stdout) as unknown;
      records = Array.isArray(parsed) ? parsed : [parsed];
    } catch { records = []; }
    return { operation: "domain_recon", domain: DnsTargetSchema.parse(targets)[0].value, records };
  },
};

export const whoisLookupAdapter: SecurityOperationAdapter<{ operation: "whois_lookup"; domain: string; fields: Record<string, string[]> }> = {
  id: "whois_lookup", classification: "passive", requiredCapability: "whois",
  validate(targets) { return DnsTargetSchema.parse(targets); },
  buildExecution(targets) {
    const domain = DnsTargetSchema.parse(targets)[0].value.toLowerCase();
    return { executable: "whois", args: ["--no-recursion", "--", domain], timeoutMs: 45_000 };
  },
  buildMcpInvocation(targets) { return commandInvocation(this.buildExecution(targets)); },
  parse(result, targets) {
    const fields: Record<string, string[]> = {};
    for (const line of result.stdout.split(/\r?\n/)) {
      if (!line || line.startsWith("%") || line.startsWith("#")) continue;
      const match = line.match(/^([^:]{1,80}):\s*(.+)$/);
      if (!match) continue;
      const key = match[1].trim().toLowerCase().replace(/\s+/g, "_");
      const value = match[2].trim();
      if (value) fields[key] = [...new Set([...(fields[key] ?? []), value])];
    }
    return { operation: "whois_lookup", domain: DnsTargetSchema.parse(targets)[0].value.toLowerCase(), fields };
  },
};

type NormalizedDomainDiscovery<Operation extends string> = {
  operation: Operation;
  domain: string;
  hosts: Array<{ name: string; address: string | null }>;
  emails: string[];
};

function domainDiscoveryOutput<Operation extends string>(operation: Operation, domain: string, output: string): NormalizedDomainDiscovery<Operation> {
  const escapedDomain = domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hostPattern = new RegExp(`(?:^|[^A-Za-z0-9_-])((?:[A-Za-z0-9_-]+\\.)+${escapedDomain})\\.?(?:[^A-Za-z0-9_.-]|$)`, "gi");
  const addressPattern = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
  const discovered = new Map<string, string | null>();
  for (const line of output.split(/\r?\n/)) {
    for (const match of line.matchAll(hostPattern)) {
      const name = match[1].toLowerCase().replace(/\.$/, "");
      const address = line.match(addressPattern)?.[0] ?? null;
      if (!discovered.has(name) || address) discovered.set(name, address);
    }
  }
  const emails = [...new Set(output.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)?.map((value) => value.toLowerCase()) ?? [])];
  return { operation, domain, hosts: [...discovered].map(([name, address]) => ({ name, address })), emails };
}

export const dnsenumDiscoveryAdapter: SecurityOperationAdapter<NormalizedDomainDiscovery<"dnsenum_discovery">> = {
  id: "dnsenum_discovery", classification: "active_recon", requiredCapability: "dnsenum",
  validate(targets) { return DnsTargetSchema.parse(targets); },
  buildExecution(targets) {
    const domain = DnsTargetSchema.parse(targets)[0].value.toLowerCase();
    return { executable: "dnsenum", args: ["--nocolor", "--noreverse", "--threads", "2", "--timeout", "5", domain], timeoutMs: 180_000 };
  },
  buildMcpInvocation(targets) { return { ...commandInvocation(this.buildExecution(targets)), expectedArtifacts: ["dns_records", "domains", "stdout", "stderr"] }; },
  parse(result, targets) { return domainDiscoveryOutput("dnsenum_discovery", DnsTargetSchema.parse(targets)[0].value.toLowerCase(), `${result.stdout}\n${result.stderr}`); },
};

export const dnsmapDiscoveryAdapter: SecurityOperationAdapter<NormalizedDomainDiscovery<"dnsmap_discovery">> = {
  id: "dnsmap_discovery", classification: "active_recon", requiredCapability: "dnsmap",
  validate(targets) { return DnsTargetSchema.parse(targets); },
  buildExecution(targets) {
    const domain = DnsTargetSchema.parse(targets)[0].value.toLowerCase();
    return { executable: "dnsmap", args: [domain, "-w", "/usr/share/wordlists/dnsmap.txt", "-d", "25"], timeoutMs: 180_000 };
  },
  buildMcpInvocation(targets) { return { ...commandInvocation(this.buildExecution(targets)), expectedArtifacts: ["domains", "stdout", "stderr"] }; },
  parse(result, targets) { return domainDiscoveryOutput("dnsmap_discovery", DnsTargetSchema.parse(targets)[0].value.toLowerCase(), `${result.stdout}\n${result.stderr}`); },
};

export const fierceDiscoveryAdapter: SecurityOperationAdapter<NormalizedDomainDiscovery<"fierce_discovery">> = {
  id: "fierce_discovery", classification: "active_recon", requiredCapability: "fierce",
  validate(targets) { return DnsTargetSchema.parse(targets); },
  buildExecution(targets) {
    const domain = DnsTargetSchema.parse(targets)[0].value.toLowerCase();
    return { executable: "fierce", args: ["--domain", domain, "--delay", "0.2"], timeoutMs: 180_000 };
  },
  buildMcpInvocation(targets) { return { ...commandInvocation(this.buildExecution(targets)), expectedArtifacts: ["domains", "ip_addresses", "stdout", "stderr"] }; },
  parse(result, targets) { return domainDiscoveryOutput("fierce_discovery", DnsTargetSchema.parse(targets)[0].value.toLowerCase(), `${result.stdout}\n${result.stderr}`); },
};

export const amassPassiveDiscoveryAdapter: SecurityOperationAdapter<NormalizedDomainDiscovery<"amass_passive_discovery">> = {
  id: "amass_passive_discovery", classification: "passive", requiredCapability: "amass",
  validate(targets) { return DnsTargetSchema.parse(targets); },
  buildExecution(targets) {
    const domain = DnsTargetSchema.parse(targets)[0].value.toLowerCase();
    return { executable: "amass", args: ["enum", "-passive", "-nocolor", "-timeout", "2", "-d", domain], timeoutMs: 150_000 };
  },
  buildMcpInvocation(targets) { return { ...commandInvocation(this.buildExecution(targets)), expectedArtifacts: ["domains", "relationships", "stdout", "stderr"] }; },
  parse(result, targets) { return domainDiscoveryOutput("amass_passive_discovery", DnsTargetSchema.parse(targets)[0].value.toLowerCase(), `${result.stdout}\n${result.stderr}`); },
};

export const dmitryDomainIntelAdapter: SecurityOperationAdapter<NormalizedDomainDiscovery<"dmitry_domain_intel">> = {
  id: "dmitry_domain_intel", classification: "passive", requiredCapability: "dmitry",
  validate(targets) { return DnsTargetSchema.parse(targets); },
  buildExecution(targets) {
    const domain = DnsTargetSchema.parse(targets)[0].value.toLowerCase();
    return { executable: "dmitry", args: ["-wse", domain], timeoutMs: 120_000 };
  },
  buildMcpInvocation(targets) { return { ...commandInvocation(this.buildExecution(targets)), expectedArtifacts: ["registration_records", "identity_references", "domains", "stdout", "stderr"] }; },
  parse(result, targets) { return domainDiscoveryOutput("dmitry_domain_intel", DnsTargetSchema.parse(targets)[0].value.toLowerCase(), `${result.stdout}\n${result.stderr}`); },
};

const UrlTargetSchema = z.array(z.object({ kind: z.literal("url"), value: z.string().trim().url() })).length(1);

export const wafDetectionAdapter: SecurityOperationAdapter<{ operation: "waf_detection"; url: string; detected: boolean; products: Array<{ firewall: string; manufacturer: string | null; triggerUrl: string | null }> }> = {
  id: "waf_detection", classification: "passive", requiredCapability: "wafw00f",
  validate(targets) { return UrlTargetSchema.parse(targets); },
  buildExecution(targets) {
    const url = UrlTargetSchema.parse(targets)[0].value;
    return { executable: "wafw00f", args: ["--findall", "--output", "-", "--format", "json", "--no-colors", "--timeout", "10", url], timeoutMs: 90_000 };
  },
  buildMcpInvocation(targets) { return commandInvocation(this.buildExecution(targets)); },
  parse(result, targets) {
    const parsed = z.array(z.object({ detected: z.boolean(), firewall: z.string(), manufacturer: z.string().nullable().optional(), trigger_url: z.string().nullable().optional() })).parse(JSON.parse(result.stdout));
    return {
      operation: "waf_detection",
      url: UrlTargetSchema.parse(targets)[0].value,
      detected: parsed.some((item) => item.detected),
      products: parsed.filter((item) => item.detected).map((item) => ({ firewall: item.firewall, manufacturer: item.manufacturer ?? null, triggerUrl: item.trigger_url ?? null })),
    };
  },
};

function tlsEndpoint(value: string): { endpoint: string; sni: string } {
  const url = new URL(value);
  const port = url.port || "443";
  return { endpoint: `${url.hostname}:${port}`, sni: url.hostname };
}

export const tlsConfigurationAdapter: SecurityOperationAdapter<{ operation: "tls_configuration"; url: string; connectivity: string | null; scanStatus: string | null; certificateDeployments: number; compliance: string | null }> = {
  id: "tls_configuration", classification: "active_recon", requiredCapability: "sslyze",
  validate(targets) { return UrlTargetSchema.parse(targets); },
  buildExecution(targets) {
    const url = UrlTargetSchema.parse(targets)[0].value;
    const target = tlsEndpoint(url);
    return { executable: "sslyze", args: ["--json_out=-", "--quiet", "--slow_connection", "--sni", target.sni, "--certinfo", "--http_headers", target.endpoint], timeoutMs: 180_000 };
  },
  buildMcpInvocation(targets) { return commandInvocation(this.buildExecution(targets)); },
  parse(result, targets) {
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    const scans = Array.isArray(payload.server_scan_results) ? payload.server_scan_results as Array<Record<string, unknown>> : [];
    const scan = scans[0] ?? {};
    const resultValue = scan.scan_result && typeof scan.scan_result === "object" ? scan.scan_result as Record<string, unknown> : {};
    const certInfo = resultValue.certificate_info && typeof resultValue.certificate_info === "object" ? resultValue.certificate_info as Record<string, unknown> : {};
    const certResult = certInfo.result && typeof certInfo.result === "object" ? certInfo.result as Record<string, unknown> : {};
    const compliance = scan.mozilla_config_test_results && typeof scan.mozilla_config_test_results === "object" ? scan.mozilla_config_test_results as Record<string, unknown> : {};
    return {
      operation: "tls_configuration",
      url: UrlTargetSchema.parse(targets)[0].value,
      connectivity: typeof scan.connectivity_status === "string" ? scan.connectivity_status : null,
      scanStatus: typeof scan.scan_status === "string" ? scan.scan_status : null,
      certificateDeployments: Array.isArray(certResult.certificate_deployments) ? certResult.certificate_deployments.length : 0,
      compliance: typeof compliance.compliance === "string" ? compliance.compliance : null,
    };
  },
};

export const sslscanConfigurationAdapter: SecurityOperationAdapter<{ operation: "sslscan_configuration"; url: string; protocols: string[]; ciphers: string[]; certificateSubjects: string[] }> = {
  id: "sslscan_configuration", classification: "active_recon", requiredCapability: "sslscan",
  validate(targets) { return UrlTargetSchema.parse(targets); },
  buildExecution(targets) {
    const url = UrlTargetSchema.parse(targets)[0].value;
    const target = tlsEndpoint(url);
    return { executable: "sslscan", args: ["--no-colour", "--timeout=8", "--connect-timeout=12", "--xml=-", `--sni-name=${target.sni}`, target.endpoint], timeoutMs: 180_000 };
  },
  buildMcpInvocation(targets) { return { ...commandInvocation(this.buildExecution(targets)), expectedArtifacts: ["certificate_metadata", "tls_configuration", "stdout", "stderr"] }; },
  parse(result, targets) {
    const protocols = [...new Set([...result.stdout.matchAll(/<protocol\s+([^>]+)\/?\s*>/gi)].flatMap((match) => {
      const enabled = xmlAttribute(match[1], "enabled");
      const type = xmlAttribute(match[1], "type");
      const version = xmlAttribute(match[1], "version");
      return (enabled === "1" || enabled === "true") && type ? [`${type}${version ? ` ${version}` : ""}`] : [];
    }))];
    const ciphers = [...new Set([...result.stdout.matchAll(/<cipher\s+([^>]+)\/?\s*>/gi)].flatMap((match) => xmlAttribute(match[1], "status") === "accepted" && xmlAttribute(match[1], "cipher") ? [xmlAttribute(match[1], "cipher")!] : []))];
    const certificateSubjects = [...new Set([...result.stdout.matchAll(/<subject>([^<]+)<\/subject>/gi)].map((match) => match[1].trim()))];
    return { operation: "sslscan_configuration", url: UrlTargetSchema.parse(targets)[0].value, protocols, ciphers, certificateSubjects };
  },
};

type WebPathFinding = { url: string; status: number | null; length: number | null };
type NormalizedWebPaths<Operation extends string> = { operation: Operation; url: string; paths: WebPathFinding[] };

export const ffufContentDiscoveryAdapter: SecurityOperationAdapter<NormalizedWebPaths<"ffuf_content_discovery">> = {
  id: "ffuf_content_discovery", classification: "active_recon", requiredCapability: "ffuf",
  validate(targets) { return UrlTargetSchema.parse(targets); },
  buildExecution(targets) {
    const url = UrlTargetSchema.parse(targets)[0].value.replace(/\/$/, "");
    return { executable: "ffuf", args: ["-noninteractive", "-s", "-json", "-t", "10", "-rate", "20", "-timeout", "8", "-maxtime", "120", "-w", "/usr/share/wordlists/dirb/common.txt", "-u", `${url}/FUZZ`], timeoutMs: 150_000 };
  },
  buildMcpInvocation(targets) { return { ...commandInvocation(this.buildExecution(targets)), expectedArtifacts: ["web_paths", "http_responses", "stdout", "stderr"] }; },
  parse(result, targets) {
    const paths = result.stdout.split(/\r?\n/).flatMap((line): WebPathFinding[] => {
      try {
        const start = line.indexOf("{");
        const value = JSON.parse(start >= 0 ? line.slice(start) : line) as Record<string, unknown>;
        if (typeof value.url !== "string") return [];
        return [{ url: value.url, status: typeof value.status === "number" ? value.status : null, length: typeof value.length === "number" ? value.length : null }];
      } catch { return []; }
    });
    return { operation: "ffuf_content_discovery", url: UrlTargetSchema.parse(targets)[0].value, paths };
  },
};

export const dirbContentDiscoveryAdapter: SecurityOperationAdapter<NormalizedWebPaths<"dirb_content_discovery">> = {
  id: "dirb_content_discovery", classification: "active_recon", requiredCapability: "dirb",
  validate(targets) { return UrlTargetSchema.parse(targets); },
  buildExecution(targets) {
    const url = UrlTargetSchema.parse(targets)[0].value;
    return { executable: "dirb", args: [url, "/usr/share/wordlists/dirb/common.txt", "-S", "-r", "-z", "50"], timeoutMs: 180_000 };
  },
  buildMcpInvocation(targets) { return { ...commandInvocation(this.buildExecution(targets)), expectedArtifacts: ["web_paths", "http_responses", "stdout", "stderr"] }; },
  parse(result, targets) {
    const paths = result.stdout.split(/\r?\n/).flatMap((line): WebPathFinding[] => {
      const match = line.match(/^\+\s+(https?:\/\/\S+)\s+\(CODE:(\d+)\|SIZE:(\d+)\)/i);
      return match ? [{ url: match[1], status: Number(match[2]), length: Number(match[3]) }] : [];
    });
    return { operation: "dirb_content_discovery", url: UrlTargetSchema.parse(targets)[0].value, paths };
  },
};

type WebObservation = { id: string | null; message: string; url: string | null };

function collectWebObservations(value: unknown, output: WebObservation[], key: string | null = null): void {
  if (Array.isArray(value)) { value.forEach((item) => collectWebObservations(item, output, key)); return; }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const message = [record.msg, record.message, record.description, record.title].find((item): item is string => typeof item === "string" && item.trim().length > 0);
  if (message) output.push({ id: typeof record.id === "string" ? record.id : key, message: message.trim(), url: typeof record.url === "string" ? record.url : null });
  for (const [childKey, child] of Object.entries(record)) if (child && typeof child === "object") collectWebObservations(child, output, childKey);
}

export const niktoWebAuditAdapter: SecurityOperationAdapter<{ operation: "nikto_web_audit"; url: string; findings: WebObservation[] }> = {
  id: "nikto_web_audit", classification: "active_recon", requiredCapability: "nikto",
  validate(targets) { return UrlTargetSchema.parse(targets); },
  buildExecution(targets) {
    const url = UrlTargetSchema.parse(targets)[0].value;
    return { executable: "nikto", args: ["-host", url, "-nointeractive", "-ask", "no", "-maxtime", "120s", "-timeout", "8", "-Format", "json", "-output", "-"], timeoutMs: 150_000 };
  },
  buildMcpInvocation(targets) { return { ...commandInvocation(this.buildExecution(targets)), expectedArtifacts: ["web_observations", "stdout", "stderr"] }; },
  parse(result, targets) {
    const findings: WebObservation[] = [];
    try { collectWebObservations(JSON.parse(result.stdout.replace(/,\s*([}\]])/g, "$1")), findings); } catch {
      for (const line of result.stdout.split(/\r?\n/)) if (/^\+\s+/.test(line)) findings.push({ id: null, message: line.replace(/^\+\s+/, "").trim(), url: urlsFromOutput(line)[0] ?? null });
    }
    return { operation: "nikto_web_audit", url: UrlTargetSchema.parse(targets)[0].value, findings };
  },
};

export const wpScanAuditAdapter: SecurityOperationAdapter<{ operation: "wpscan_audit"; url: string; findings: WebObservation[] }> = {
  id: "wpscan_audit", classification: "active_recon", requiredCapability: "wpscan",
  validate(targets) { return UrlTargetSchema.parse(targets); },
  buildExecution(targets) {
    const url = UrlTargetSchema.parse(targets)[0].value;
    return { executable: "wpscan", args: ["--url", url, "--format", "json", "--output", "-", "--no-banner", "--no-update", "--detection-mode", "passive", "--plugins-detection", "passive", "--max-threads", "3", "--request-timeout", "10", "--connect-timeout", "8"], timeoutMs: 180_000 };
  },
  buildMcpInvocation(targets) { return { ...commandInvocation(this.buildExecution(targets)), expectedArtifacts: ["web_observations", "vulnerability_observations", "stdout", "stderr"] }; },
  parse(result, targets) {
    const findings: WebObservation[] = [];
    try { collectWebObservations(JSON.parse(result.stdout), findings); } catch { /* raw evidence remains available */ }
    return { operation: "wpscan_audit", url: UrlTargetSchema.parse(targets)[0].value, findings };
  },
};

export const wfuzzContentDiscoveryAdapter: SecurityOperationAdapter<NormalizedWebPaths<"wfuzz_content_discovery">> = {
  id: "wfuzz_content_discovery", classification: "active_recon", requiredCapability: "wfuzz",
  validate(targets) { return UrlTargetSchema.parse(targets); },
  buildExecution(targets) {
    const url = UrlTargetSchema.parse(targets)[0].value.replace(/\/$/, "");
    return { executable: "wfuzz", args: ["-t", "10", "-s", "0.05", "--req-delay", "8", "--conn-delay", "8", "--hc", "404", "-o", "json", "-w", "/usr/share/wordlists/wfuzz/general/common.txt", `${url}/FUZZ`], timeoutMs: 180_000 };
  },
  buildMcpInvocation(targets) { return { ...commandInvocation(this.buildExecution(targets)), expectedArtifacts: ["web_paths", "http_responses", "stdout", "stderr"] }; },
  parse(result, targets) {
    const paths: WebPathFinding[] = [];
    try {
      const jsonStart = result.stdout.indexOf("[");
      const value = JSON.parse(jsonStart >= 0 ? result.stdout.slice(jsonStart) : result.stdout) as unknown;
      const rows = Array.isArray(value) ? value : value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).results) ? (value as { results: unknown[] }).results : [];
      for (const row of rows) if (row && typeof row === "object") {
        const item = row as Record<string, unknown>;
        const url = typeof item.url === "string" ? item.url : typeof item.request === "object" && item.request && typeof (item.request as Record<string, unknown>).url === "string" ? (item.request as Record<string, unknown>).url as string : null;
        if (url) paths.push({ url, status: typeof item.code === "number" ? item.code : null, length: typeof item.chars === "number" ? item.chars : null });
      }
    } catch { /* raw evidence remains available */ }
    return { operation: "wfuzz_content_discovery", url: UrlTargetSchema.parse(targets)[0].value, paths };
  },
};
export const webFingerprintAdapter: SecurityOperationAdapter<{ operation: "web_fingerprint"; url: string; technologies: string[] }> = {
  id: "web_fingerprint", classification: "passive", requiredCapability: "whatweb",
  validate(targets) { return UrlTargetSchema.parse(targets); },
  buildExecution(targets) {
    const url = UrlTargetSchema.parse(targets)[0].value;
    return { executable: "whatweb", args: ["--quiet", "--color=never", "--log-json=-", url], timeoutMs: 60_000 };
  },
  buildMcpInvocation(targets) { return commandInvocation(this.buildExecution(targets)); },
  parse(result, targets) {
    let technologies: string[] = [];
    try {
      const parsed = JSON.parse(result.stdout) as Array<{ plugins?: Record<string, unknown> }>;
      technologies = [...new Set(parsed.flatMap((item) => Object.keys(item.plugins ?? {})))];
    } catch { technologies = []; }
    return { operation: "web_fingerprint", url: UrlTargetSchema.parse(targets)[0].value, technologies };
  },
};

export const webContentDiscoveryAdapter: SecurityOperationAdapter<{ operation: "web_content_discovery"; url: string; paths: string[] }> = {
  id: "web_content_discovery", classification: "active_recon", requiredCapability: "gobuster",
  validate(targets) { return UrlTargetSchema.parse(targets); },
  buildExecution(targets) {
    const url = UrlTargetSchema.parse(targets)[0].value;
    return { executable: "gobuster", args: ["dir", "-q", "-t", "10", "--timeout", "10s", "-w", "/usr/share/wordlists/dirb/common.txt", "-u", url], timeoutMs: 180_000 };
  },
  buildMcpInvocation(targets) {
    return {
      ...commandInvocation(this.buildExecution(targets)),
      expectedArtifacts: ["web_paths", "stdout", "stderr"],
    };
  },
  parse(result, targets) {
    const paths = [...new Set(result.stdout.split(/\r?\n/).flatMap((line) => {
      const match = line.match(/^(\/\S+)\s+/);
      return match ? [match[1]] : [];
    }))];
    return { operation: "web_content_discovery", url: UrlTargetSchema.parse(targets)[0].value, paths };
  },
};

export const securityOperationAdapters = new Map<string, SecurityOperationAdapter<unknown>>([
  [dnsLookupAdapter.id, dnsLookupAdapter],
  [serviceInventoryAdapter.id, serviceInventoryAdapter],
  [arpScanDiscoveryAdapter.id, arpScanDiscoveryAdapter],
  [fpingReachabilityAdapter.id, fpingReachabilityAdapter],
  [ikeServiceProbeAdapter.id, ikeServiceProbeAdapter],
  [enum4linuxHostAuditAdapter.id, enum4linuxHostAuditAdapter],
  [smbAnonymousShareListAdapter.id, smbAnonymousShareListAdapter],
  [smbMapAnonymousAdapter.id, smbMapAnonymousAdapter],
  [exiftoolMetadataAdapter.id, exiftoolMetadataAdapter],
  [hashdeepFileHashAdapter.id, hashdeepFileHashAdapter],
  [tsharkCaptureAnalysisAdapter.id, tsharkCaptureAnalysisAdapter],
  [searchsploitLookupAdapter.id, searchsploitLookupAdapter],
  [publicEmailSearchAdapter.id, publicEmailSearchAdapter],
  [publicUsernameSearchAdapter.id, publicUsernameSearchAdapter],
  [maigretUsernameSearchAdapter.id, maigretUsernameSearchAdapter],
  [maigretFullUsernameSearchAdapter.id, maigretFullUsernameSearchAdapter],
  [emailAccountSearchAdapter.id, emailAccountSearchAdapter],
  [phoneEnrichmentAdapter.id, phoneEnrichmentAdapter],
  [domainReconAdapter.id, domainReconAdapter],
  [whoisLookupAdapter.id, whoisLookupAdapter],
  [dnsenumDiscoveryAdapter.id, dnsenumDiscoveryAdapter],
  [dnsmapDiscoveryAdapter.id, dnsmapDiscoveryAdapter],
  [fierceDiscoveryAdapter.id, fierceDiscoveryAdapter],
  [amassPassiveDiscoveryAdapter.id, amassPassiveDiscoveryAdapter],
  [dmitryDomainIntelAdapter.id, dmitryDomainIntelAdapter],
  [wafDetectionAdapter.id, wafDetectionAdapter],
  [tlsConfigurationAdapter.id, tlsConfigurationAdapter],
  [sslscanConfigurationAdapter.id, sslscanConfigurationAdapter],
  [ffufContentDiscoveryAdapter.id, ffufContentDiscoveryAdapter],
  [dirbContentDiscoveryAdapter.id, dirbContentDiscoveryAdapter],
  [niktoWebAuditAdapter.id, niktoWebAuditAdapter],
  [wpScanAuditAdapter.id, wpScanAuditAdapter],
  [wfuzzContentDiscoveryAdapter.id, wfuzzContentDiscoveryAdapter],
  [webFingerprintAdapter.id, webFingerprintAdapter],
  [webContentDiscoveryAdapter.id, webContentDiscoveryAdapter],
]);

export function getSecurityOperationAdapter(operation: string): SecurityOperationAdapter<unknown> {
  const adapter = securityOperationAdapters.get(operation);
  if (!adapter) throw new Error(`Security operation ${operation} has no typed execution adapter.`);
  return adapter;
}
