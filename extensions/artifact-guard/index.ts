/**
 * artifact-guard is a SELF-CONSISTENCY TRIPWIRE, not a security boundary.
 * Every enforced contract is declared by the same model the extension constrains.
 * It catches forgot/drifted failures (wrong root/worktree or skipped QA); it is
 * not a sandbox, permission system, or defense against a deliberately adversarial agent.
 */

import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	isToolCallEventType,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type GuardMode = "ENFORCE" | "ADVISORY";
type ContractStatus = "PASS" | "NOT_ESTABLISHED" | "INVALID";

/**
 * Sole schema owner for .artifact-guard.json:
 * { "lease_markers"?: string[], "notes"?: string,
 *   "default_write_roots"?: string[], "allow_scratch"?: boolean },
 * with no other keys.
 * Each lease marker is one filename or dirname directly beneath an approved root.
 * default_write_roots are unioned at gate time and do not need to be restated on every contract_check.
 */
interface ArtifactGuardConfig {
	lease_markers?: string[];
	notes?: string;
	default_write_roots?: string[];
	allow_scratch?: boolean;
}

interface ScopeState {
	cwd: string;
	repositoryRoot: string | null;
	markerPath: string | null;
	markerDigest: string | null;
	mode: GuardMode;
	config: ArtifactGuardConfig;
	configError: string | null;
	identity: string;
}

interface PathRecord {
	declared: string;
	absolute: string;
	canonical: string;
}

interface ImmutableInput extends PathRecord {
	sha256: string | null;
}

interface ContractState {
	mode: "write" | "fix" | "integrate";
	concepts: Array<{ name: string; schema_owner: string }>;
	roots: PathRecord[];
	requiredOutputs: PathRecord[];
	forbiddenOutputs: PathRecord[];
	immutableInputs: ImmutableInput[];
	behavioralChecks: string[];
	deterministicRegenerationRequired: boolean;
	notes: string;
	sessionRepositoryRoot: PathRecord | null;
	digest: string;
}

interface LeaseFinding {
	root: string;
	marker: string | null;
	status: "disabled" | "verified" | "ownership_unverified" | "conflict";
	reason: string;
}

interface FinalizeState {
	status: "NEVER" | "PASS" | "FAIL" | "STALE";
	digest?: string;
	reason?: string;
}

interface ShellToken {
	kind: "word" | "op";
	value: string;
}

interface BashTarget {
	path: string;
	cwd: string;
}

const MARKER_NAME = ".artifact-guard.json";
const DEFAULTS_NAME = "artifact-guard.defaults.json";
const NO_CONTRACT_REASON = "artifact-guard: establish the contract first with contract_check.";
const LEASE_CONFLICT_REASON = "artifact-guard: conflicting live exclusive lease for an approved root.";
const COMPLETION_WARNING =
	"[artifact-guard warning: completion was claimed without artifact_finalize PASS; this warning does not block final text.]";

// Operational reminder only; task/interface guidance belongs to the skill.
const contractKernel = (mode: GuardMode) => `Artifact Guard (${mode}) checks participating Pi tool calls only, not external harnesses or authorization.
In ENFORCE, establish contract_check before mutation; renew it for changed roots. Do not bypass a blocked write.
For an established contract, run artifact_finalize before claiming completion. PASS covers declared checks only; project QA/review still decides acceptance.`;

const contractCheckSchema = Type.Object({
	mode: StringEnum(["write", "fix", "integrate"] as const),
	concepts: Type.Optional(
		Type.Array(
			Type.Object({
				name: Type.String(),
				schema_owner: Type.String(),
			}),
		),
	),
	allowed_write_roots: Type.Array(Type.String()),
	required_outputs: Type.Optional(Type.Array(Type.String())),
	forbidden_outputs: Type.Optional(Type.Array(Type.String())),
	immutable_inputs: Type.Optional(
		Type.Array(
			Type.Object({
				path: Type.String(),
				sha256: Type.Optional(
					Type.Any({ description: "SHA-256 hex, or null when the input is not frozen" }),
				),
			}),
		),
	),
	behavioral_checks: Type.Optional(Type.Array(Type.String(), {
		description: "Required QA command strings, not prose labels. Supply every command in artifact_finalize qa_commands; the guard never executes this field implicitly.",
	})),
	deterministic_regeneration_required: Type.Optional(
		Type.Boolean({ description: "Whether artifact_finalize must run a deterministic regeneration command" }),
	),
	notes: Type.Optional(Type.String()),
});

const finalizeSchema = Type.Object({
	qa_commands: Type.Optional(Type.Array(Type.String())),
	required_outputs: Type.Optional(Type.Array(Type.String())),
	negative_checks: Type.Optional(Type.Array(Type.String())),
	deterministic_regeneration: Type.Object({
		required: Type.Boolean(),
		command: Type.Optional(Type.Any({ description: "Shell command, or null when not required" })),
	}),
});

function sha256Bytes(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code?: unknown }).code)
		: undefined;
}

async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return false;
		throw error;
	}
}

async function canonicalizePotential(rawPath: string, cwd: string): Promise<PathRecord> {
	const declared = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
	if (!declared.trim() || declared.includes("\0")) throw new Error("path must be non-empty");
	const absolute = resolve(cwd, declared);
	const suffix: string[] = [];
	let cursor = absolute;

	while (true) {
		try {
			const canonicalBase = await realpath(cursor);
			return {
				declared: rawPath,
				absolute,
				canonical: resolve(canonicalBase, ...suffix),
			};
		} catch (error) {
			if (errorCode(error) !== "ENOENT") throw error;
			try {
				await lstat(cursor);
				throw new Error(`unresolvable or broken symlink: ${cursor}`);
			} catch (entryError) {
				if (errorCode(entryError) !== "ENOENT") throw entryError;
			}
			const parent = dirname(cursor);
			if (parent === cursor) throw error;
			suffix.unshift(basename(cursor));
			cursor = parent;
		}
	}
}

async function canonicalizeRoot(rawPath: string, cwd: string): Promise<PathRecord> {
	const record = await canonicalizePotential(rawPath, cwd);
	const info = await stat(record.canonical);
	if (!info.isDirectory()) throw new Error(`write root is not a directory: ${rawPath}`);
	return record;
}

function isWithin(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function uniqueRoots(roots: PathRecord[]): PathRecord[] {
	const seen = new Set<string>();
	const result: PathRecord[] = [];
	for (const root of roots) {
		if (seen.has(root.canonical)) continue;
		seen.add(root.canonical);
		result.push(root);
	}
	return result;
}

function isScratchPath(canonical: string, scratchRoots: string[]): boolean {
	if (scratchRoots.some((root) => isWithin(root, canonical))) return true;
	const parts = canonical.split(sep);
	// macOS per-user temp: /var/folders/<cell>/<store>/T/...
	const folders = parts.indexOf("folders");
	if (parts[1] === "var" && folders === 2 && parts[5] === "T") return true;
	return false;
}

function formatOutsideRootReason(target: string, allowed: PathRecord[]): string {
	const roots =
		allowed.length === 0 ? "  (none)" : allowed.map((root) => `  - ${root.canonical}`).join("\n");
	return [
		"artifact-guard: write target is outside the approved write roots.",
		`rejected: ${target}`,
		"approved_write_roots:",
		roots,
		"hint: re-run contract_check and include this path in allowed_write_roots. A new worktree or root needs a new contract.",
	].join("\n");
}

async function loadGuardDefaults(): Promise<ArtifactGuardConfig> {
	const path = join(homedir(), ".pi", "agent", DEFAULTS_NAME);
	try {
		const raw = await readFile(path, "utf8");
		const { config, error } = parseConfig(raw);
		return error ? {} : config;
	} catch {
		return {};
	}
}

async function scratchRoots(): Promise<string[]> {
	const roots = new Set<string>(["/tmp", "/private/tmp"]);
	try {
		roots.add(await realpath(tmpdir()));
	} catch {
		roots.add(resolve(tmpdir()));
	}
	return [...roots];
}

async function resolveConfiguredRoots(
	configured: string[] | undefined,
	cwd: string,
): Promise<PathRecord[]> {
	const roots: PathRecord[] = [];
	for (const raw of configured ?? []) {
		try {
			roots.push(await canonicalizeRoot(raw, cwd));
		} catch {
			// Missing optional defaults must not fail the gate.
		}
	}
	return roots;
}

function sameSet(left: string[], right: string[]): boolean {
	if (left.length !== right.length) return false;
	const a = [...left].sort();
	const b = [...right].sort();
	return a.every((value, index) => value === b[index]);
}

function nonEmptyStrings(values: string[], label: string, errors: string[]): string[] {
	const result: string[] = [];
	for (const value of values) {
		const trimmed = value.trim();
		if (!trimmed) errors.push(`${label} contains an empty value`);
		else result.push(trimmed);
	}
	return result;
}

function parseConfig(raw: string): { config: ArtifactGuardConfig; error: string | null } {
	try {
		const value = JSON.parse(raw.trim() || "{}") as unknown;
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			return { config: {}, error: "marker config must be a JSON object" };
		}
		const record = value as Record<string, unknown>;
		const unknown = Object.keys(record).filter(
			(key) => !["lease_markers", "notes", "default_write_roots", "allow_scratch"].includes(key),
		);
		if (unknown.length > 0) return { config: {}, error: `unknown marker key: ${unknown.join(", ")}` };
		if (record.notes !== undefined && typeof record.notes !== "string") {
			return { config: {}, error: "notes must be a string" };
		}
		if (record.allow_scratch !== undefined && typeof record.allow_scratch !== "boolean") {
			return { config: {}, error: "allow_scratch must be a boolean" };
		}
		let defaultWriteRoots: string[] | undefined;
		if (record.default_write_roots !== undefined) {
			if (!Array.isArray(record.default_write_roots)) {
				return { config: {}, error: "default_write_roots must be an array of paths" };
			}
			defaultWriteRoots = [];
			for (const item of record.default_write_roots) {
				if (typeof item !== "string" || !item.trim()) {
					return { config: {}, error: "each default write root must be a non-empty path" };
				}
				defaultWriteRoots.push(item.trim());
			}
		}
		if (record.lease_markers !== undefined) {
			if (!Array.isArray(record.lease_markers)) {
				return { config: {}, error: "lease_markers must be an array of names" };
			}
			const markers: string[] = [];
			for (const item of record.lease_markers) {
				if (
					typeof item !== "string" ||
					!item.trim() ||
					item !== basename(item) ||
					item === "." ||
					item === ".."
				) {
					return { config: {}, error: "each lease marker must be one filename or dirname" };
				}
				if (markers.includes(item)) return { config: {}, error: `duplicate lease marker: ${item}` };
				markers.push(item);
			}
			return {
				config: {
					lease_markers: markers,
					notes: record.notes as string | undefined,
					default_write_roots: defaultWriteRoots,
					allow_scratch: record.allow_scratch as boolean | undefined,
				},
				error: null,
			};
		}
		return {
			config: {
				notes: record.notes as string | undefined,
				default_write_roots: defaultWriteRoots,
				allow_scratch: record.allow_scratch as boolean | undefined,
			},
			error: null,
		};
	} catch (error) {
		return { config: {}, error: `invalid marker JSON: ${error instanceof Error ? error.message : String(error)}` };
	}
}

async function inspectScope(cwdInput: string): Promise<ScopeState> {
	const cwd = await realpath(resolve(cwdInput));
	const filesystemRoot = parse(cwd).root;
	let cursor = cwd;
	let repositoryRoot: string | null = null;

	while (true) {
		if (await exists(join(cursor, ".git"))) {
			repositoryRoot = cursor;
			break;
		}
		if (cursor === filesystemRoot) break;
		cursor = dirname(cursor);
	}

	const boundary = repositoryRoot ?? filesystemRoot;
	cursor = cwd;
	let markerPath: string | null = null;
	while (true) {
		const candidate = join(cursor, MARKER_NAME);
		if (await exists(candidate)) {
			markerPath = candidate;
			break;
		}
		if (cursor === boundary) break;
		const parent = dirname(cursor);
		if (parent === cursor) break;
		cursor = parent;
	}

	let markerDigest: string | null = null;
	let config: ArtifactGuardConfig = {};
	let configError: string | null = null;
	if (markerPath) {
		try {
			const raw = await readFile(markerPath, "utf8");
			markerDigest = sha256Bytes(raw);
			({ config, error: configError } = parseConfig(raw));
		} catch (error) {
			configError = `cannot read marker: ${error instanceof Error ? error.message : String(error)}`;
		}
	}

	const mode: GuardMode = markerPath ? "ENFORCE" : "ADVISORY";
	const identity = [cwd, repositoryRoot ?? "", markerPath ?? "", markerDigest ?? "", configError ?? ""].join("\0");
	return { cwd, repositoryRoot, markerPath, markerDigest, mode, config, configError, identity };
}

async function hashFile(path: string): Promise<string> {
	return sha256Bytes(await readFile(path));
}

async function checkRequiredOutputs(outputs: PathRecord[], cwd: string, phase: string, errors: string[]) {
	for (const output of outputs) {
		try {
			const current = await canonicalizePotential(output.absolute, cwd);
			if (current.canonical !== output.canonical) {
				errors.push(`required output changed identity ${phase}: ${output.declared}`);
			} else if (!(await stat(current.canonical)).isFile()) {
				errors.push(`required output is not a file ${phase}: ${output.declared}`);
			}
		} catch {
			errors.push(`required output is missing or unresolvable ${phase}: ${output.declared}`);
		}
	}
}

function isInventoryName(path: string): boolean {
	const name = basename(path).toLowerCase();
	return (
		name === "sha256sums" ||
		name === "sha256sum" ||
		/(^|[._-])(inventory|manifest|checksums?|sha256sums?)([._-]|$)/.test(name)
	);
}

function stableContractDigest(contract: Omit<ContractState, "digest">): string {
	const normalized = {
		mode: contract.mode,
		concepts: [...contract.concepts].sort((a, b) =>
			`${a.name}\0${a.schema_owner}`.localeCompare(`${b.name}\0${b.schema_owner}`),
		),
		roots: contract.roots.map((item) => item.canonical).sort(),
		required_outputs: contract.requiredOutputs.map((item) => item.canonical).sort(),
		forbidden_outputs: contract.forbiddenOutputs.map((item) => item.canonical).sort(),
		immutable_inputs: contract.immutableInputs
			.map((item) => ({ path: item.canonical, sha256: item.sha256 }))
			.sort((a, b) => a.path.localeCompare(b.path)),
		behavioral_checks: [...contract.behavioralChecks].sort(),
		deterministic_regeneration_required: contract.deterministicRegenerationRequired,
		notes: contract.notes,
		session_repository_root: contract.sessionRepositoryRoot?.canonical ?? null,
	};
	return sha256Bytes(JSON.stringify(normalized));
}

function textResult(details: Record<string, unknown>) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(details) }],
		details,
	};
}

function bounded(value: string, maxBytes = 8192): { text: string; truncated: boolean } {
	const bytes = Buffer.from(value);
	if (bytes.length <= maxBytes) return { text: value, truncated: false };
	return { text: bytes.subarray(0, maxBytes).toString("utf8"), truncated: true };
}

function livePid(pid: unknown): boolean {
	if (!Number.isInteger(pid) || Number(pid) <= 0) return false;
	try {
		process.kill(Number(pid), 0);
		return true;
	} catch (error) {
		return errorCode(error) === "EPERM";
	}
}

/** Lease fields are interpreted only as high-confidence hints; this does not define a lease schema. */
function inspectLeaseRecord(value: unknown, sessionId: string): { status: LeaseFinding["status"]; reason: string } {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { status: "ownership_unverified", reason: "marker has no JSON object metadata" };
	}
	const record = value as Record<string, unknown>;
	const ownerCandidates = [
		record.owner_session_id,
		record.ownerSessionId,
		record.session_id,
		record.sessionId,
		record.owner,
	];
	const owner = ownerCandidates.find((candidate) => typeof candidate === "string") as string | undefined;
	const statusValue = String(record.status ?? record.state ?? "").toLowerCase();
	const explicitlyReleased = ["released", "expired", "stale", "inactive", "closed"].includes(statusValue);
	const exclusive =
		record.exclusive === true ||
		String(record.mode ?? "").toLowerCase() === "exclusive" ||
		String(record.ownership ?? "").toLowerCase() === "exclusive";
	const expiryRaw = record.expires_at ?? record.expiresAt ?? record.expiry;
	const expiry = typeof expiryRaw === "string" || typeof expiryRaw === "number" ? Date.parse(String(expiryRaw)) : Number.NaN;
	const expired = Number.isFinite(expiry) && expiry <= Date.now();
	const live =
		!explicitlyReleased &&
		!expired &&
		(record.active === true ||
			["active", "live", "held", "acquired"].includes(statusValue) ||
			(Number.isFinite(expiry) && expiry > Date.now()) ||
			livePid(record.pid));

	if (exclusive && owner && owner !== sessionId && live) {
		return { status: "conflict", reason: `live exclusive owner is another session (${owner})` };
	}
	if (exclusive && owner === sessionId && live) {
		return { status: "verified", reason: "live exclusive owner matches this session" };
	}
	return { status: "ownership_unverified", reason: "exclusive live ownership cannot be proven" };
}

async function inspectLeases(
	contract: ContractState,
	scope: ScopeState,
	sessionId: string,
): Promise<LeaseFinding[]> {
	const markers = scope.config.lease_markers ?? [];
	if (markers.length === 0) {
		return contract.roots.map((root) => ({
			root: root.canonical,
			marker: null,
			status: "disabled",
			reason: scope.configError ?? "no lease markers configured",
		}));
	}

	const findings: LeaseFinding[] = [];
	for (const root of contract.roots) {
		let found = false;
		for (const markerName of markers) {
			const markerPath = join(root.canonical, markerName);
			if (!(await exists(markerPath))) continue;
			found = true;
			try {
				const info = await lstat(markerPath);
				if (!info.isFile()) {
					findings.push({
						root: root.canonical,
						marker: markerPath,
						status: "ownership_unverified",
						reason: "marker is not a readable metadata file",
					});
					continue;
				}
				if (info.size > 64 * 1024) {
					findings.push({
						root: root.canonical,
						marker: markerPath,
						status: "ownership_unverified",
						reason: "marker metadata exceeds 64 KiB",
					});
					continue;
				}
				const metadata = JSON.parse(await readFile(markerPath, "utf8")) as unknown;
				const result = inspectLeaseRecord(metadata, sessionId);
				findings.push({ root: root.canonical, marker: markerPath, ...result });
			} catch (error) {
				findings.push({
					root: root.canonical,
					marker: markerPath,
					status: "ownership_unverified",
					reason: `cannot verify marker metadata: ${error instanceof Error ? error.message : String(error)}`,
				});
			}
		}
		if (!found) {
			findings.push({
				root: root.canonical,
				marker: null,
				status: "ownership_unverified",
				reason: "no configured marker is present directly beneath the root",
			});
		}
	}
	return findings;
}

function lexShell(command: string): ShellToken[] | null {
	const tokens: ShellToken[] = [];
	let word = "";
	let started = false;
	let quote: "single" | "double" | null = null;
	const flush = () => {
		if (started) tokens.push({ kind: "word", value: word });
		word = "";
		started = false;
	};

	for (let index = 0; index < command.length; index += 1) {
		const char = command[index];
		if (quote === "single") {
			if (char === "'") quote = null;
			else word += char;
			continue;
		}
		if (quote === "double") {
			if (char === '"') quote = null;
			else if (char === "\\" && index + 1 < command.length) word += command[++index];
			else word += char;
			continue;
		}
		if (char === "'") {
			quote = "single";
			started = true;
			continue;
		}
		if (char === '"') {
			quote = "double";
			started = true;
			continue;
		}
		if (char === "\\" && index + 1 < command.length) {
			started = true;
			word += command[++index];
			continue;
		}
		if (/\s/.test(char)) {
			flush();
			continue;
		}
		if (";&|><".includes(char)) {
			flush();
			let operator = char;
			const next = command[index + 1];
			if ((char === ">" || char === "<") && next === char) {
				operator += next;
				index += 1;
			} else if ((char === "&" || char === "|") && next === char) {
				operator += next;
				index += 1;
			} else if (char === "&" && next === ">") {
				operator = "&>";
				index += 1;
			}
			tokens.push({ kind: "op", value: operator });
			continue;
		}
		started = true;
		word += char;
	}
	if (quote) return null;
	flush();
	return tokens;
}

function reliableShellPath(value: string): boolean {
	return (
		value !== "-" &&
		!value.startsWith("-") &&
		!/[\$`*?\[\]{}~\n\r]/.test(value) &&
		!value.startsWith("&")
	);
}

function isOutputSink(value: string): boolean {
	return value === "/dev/null" || value === "/dev/stdout" || value === "/dev/stderr" || value.startsWith("/dev/fd/");
}

function commandPosition(words: string[]): number | null {
	let index = 0;
	while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) index += 1;
	if (words[index] === "command") index += 1;
	if (words[index] === "env") {
		index += 1;
		while (index < words.length && (words[index].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]))) {
			index += 1;
		}
	}
	return index < words.length ? index : null;
}

function positional(args: string[]): string[] {
	const result: string[] = [];
	let options = true;
	for (const arg of args) {
		if (options && arg === "--") {
			options = false;
			continue;
		}
		if (options && arg.startsWith("-")) continue;
		result.push(arg);
	}
	return result;
}

function sedTargets(args: string[]): string[] {
	let inPlace = false;
	let explicitScript = false;
	let index = 0;
	for (; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--") {
			index += 1;
			break;
		}
		if (!arg.startsWith("-") || arg === "-") break;
		if (arg === "-i") {
			inPlace = true;
			if (args[index + 1] === "") index += 1;
			continue;
		}
		if (arg.startsWith("-i") || arg.startsWith("--in-place")) {
			inPlace = true;
			continue;
		}
		if (arg === "-e" || arg === "-f" || arg === "--expression" || arg === "--file") {
			explicitScript = true;
			index += 1;
			continue;
		}
		if (/^-[A-Za-z]*[ef]/.test(arg)) explicitScript = true;
	}
	if (!inPlace) return [];
	const rest = args.slice(index);
	if (!explicitScript) rest.shift();
	return rest;
}

function perlTargets(args: string[]): string[] {
	let inPlace = false;
	let explicitScript = false;
	let index = 0;
	for (; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--") {
			index += 1;
			break;
		}
		if (!arg.startsWith("-") || arg === "-") break;
		if (arg.startsWith("--in-place") || /^-[A-Za-z]*i/.test(arg)) inPlace = true;
		if (arg === "-e" || arg === "-E") {
			explicitScript = true;
			index += 1;
		} else if (/^-[A-Za-z]*[eE]$/.test(arg)) {
			explicitScript = true;
			index += 1;
		} else if (/^-[eE].+/.test(arg)) {
			explicitScript = true;
		}
	}
	if (!inPlace) return [];
	const rest = args.slice(index);
	if (!explicitScript) rest.shift();
	return rest;
}

/**
 * Conservative bash coverage only: simple output redirections and direct tee/mv/cp/rm/install/sed -i/perl -i.
 * Dynamic paths, aliases/functions, subshells, eval, scripts, and commands after a cwd-changing construct are not parsed.
 */
function bashMutationTargets(command: string, initialCwd: string): BashTarget[] {
	const tokens = lexShell(command);
	if (!tokens) return [];
	const segments: ShellToken[][] = [];
	let segment: ShellToken[] = [];
	for (const token of tokens) {
		if (token.kind === "op" && [";", "&&", "||", "|", "&"].includes(token.value)) {
			segments.push(segment);
			segment = [];
		} else {
			segment.push(token);
		}
	}
	segments.push(segment);

	const targets: BashTarget[] = [];
	let cwdReliable = true;
	for (const part of segments) {
		if (!cwdReliable || part.length === 0) continue;
		const consumed = new Set<number>();
		for (let index = 0; index < part.length; index += 1) {
			const token = part[index];
			if (token.kind !== "op" || ![">", ">>", "&>"].includes(token.value)) continue;
			const target = part[index + 1];
			if (target?.kind === "word") {
				consumed.add(index + 1);
				if (reliableShellPath(target.value) && !isOutputSink(target.value)) {
					targets.push({ path: target.value, cwd: initialCwd });
				}
			}
		}

		const words = part
			.map((token, index) => ({ token, index }))
			.filter(({ token, index }) => token.kind === "word" && !consumed.has(index))
			.map(({ token }) => token.value);
		const position = commandPosition(words);
		if (position === null) continue;
		const commandName = basename(words[position]);
		const args = words.slice(position + 1);
		if (commandName === "cd") {
			cwdReliable = false;
			continue;
		}

		let direct: string[] = [];
		if (commandName === "tee" || commandName === "rm") {
			direct = positional(args);
		} else if (commandName === "mv") {
			direct = positional(args);
		} else if (commandName === "cp") {
			const items = positional(args);
			direct = items.length > 0 ? [items[items.length - 1]] : [];
		} else if (commandName === "install") {
			const items = positional(args);
			direct = args.includes("-d") || args.includes("--directory") ? items : items.slice(-1);
		} else if (commandName === "sed") {
			direct = sedTargets(args);
		} else if (commandName === "perl") {
			direct = perlTargets(args);
		}
		for (const target of direct) {
			if (reliableShellPath(target) && !isOutputSink(target)) targets.push({ path: target, cwd: initialCwd });
		}
	}

	const seen = new Set<string>();
	return targets.filter((target) => {
		const key = `${target.cwd}\0${target.path}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

export default function artifactGuard(pi: ExtensionAPI) {
	let scope: ScopeState | null = null;
	let contract: ContractState | null = null;
	let contractStatus: ContractStatus = "NOT_ESTABLISHED";
	let invalidReason: string | null = null;
	let lastFinalize: FinalizeState = { status: "NEVER" };
	let mutationObserved = false;
	let lastLeaseFindings: LeaseFinding[] = [];

	// No task-boundary heuristics and no persisted rehydration: compaction keeps this closure;
	// reload/resume/fork creates a fresh extension instance and intentionally requires a new contract.
	function clearGuardState(status: ContractStatus = "NOT_ESTABLISHED", reason: string | null = null) {
		contract = null;
		contractStatus = status;
		invalidReason = reason;
		lastFinalize = { status: "NEVER" };
		mutationObserved = false;
		lastLeaseFindings = [];
	}

	function invalidateContract(reason: string) {
		contract = null;
		contractStatus = "INVALID";
		invalidReason = reason;
		lastFinalize = { status: "STALE", reason };
	}

	async function syncScope(ctx: ExtensionContext): Promise<ScopeState> {
		const next = await inspectScope(ctx.cwd);
		if (!scope || scope.identity !== next.identity) clearGuardState();
		scope = next;
		return next;
	}

	async function revalidateContract(activeScope: ScopeState): Promise<boolean> {
		if (contractStatus !== "PASS" || !contract) return false;
		try {
			for (const root of contract.roots) {
				const current = await canonicalizeRoot(root.absolute, activeScope.cwd);
				if (current.canonical !== root.canonical) {
					invalidateContract(`approved root changed identity: ${root.declared}`);
					return false;
				}
			}
			for (const input of contract.immutableInputs) {
				const current = await canonicalizePotential(input.absolute, activeScope.cwd);
				if (current.canonical !== input.canonical || !(await stat(current.canonical)).isFile()) {
					invalidateContract(`immutable input changed identity: ${input.declared}`);
					return false;
				}
				if (input.sha256 && (await hashFile(current.canonical)) !== input.sha256) {
					invalidateContract(`immutable input hash changed: ${input.declared}`);
					return false;
				}
			}
			return true;
		} catch (error) {
			invalidateContract(`scope revalidation failed: ${error instanceof Error ? error.message : String(error)}`);
			return false;
		}
	}

	async function leasesConflict(ctx: ExtensionContext, activeScope: ScopeState): Promise<boolean> {
		if (!contract) return false;
		lastLeaseFindings = await inspectLeases(contract, activeScope, ctx.sessionManager.getSessionId());
		return lastLeaseFindings.some((finding) => finding.status === "conflict");
	}

	function markMutation() {
		mutationObserved = true;
		if (lastFinalize.status === "PASS") lastFinalize = { status: "STALE", reason: "mutation after finalization" };
	}

	async function effectiveWriteRoots(activeScope: ScopeState): Promise<PathRecord[]> {
		const defaults = await loadGuardDefaults();
		const extras = await resolveConfiguredRoots(
			[...(defaults.default_write_roots ?? []), ...(activeScope.config.default_write_roots ?? [])],
			activeScope.cwd,
		);
		const sessionRoot = contract?.sessionRepositoryRoot ? [contract.sessionRepositoryRoot] : [];
		return uniqueRoots([...(contract?.roots ?? []), ...sessionRoot, ...extras]);
	}

	async function gateTargets(ctx: ExtensionContext, targets: BashTarget[]) {
		const activeScope = await syncScope(ctx);
		const valid = await revalidateContract(activeScope);
		if (!valid) {
			if (activeScope.mode === "ENFORCE") return { block: true, reason: NO_CONTRACT_REASON };
			return undefined;
		}
		if (await leasesConflict(ctx, activeScope)) return { block: true, reason: LEASE_CONFLICT_REASON };
		const defaults = await loadGuardDefaults();
		const allowScratch = activeScope.config.allow_scratch ?? defaults.allow_scratch ?? true;
		const scratch = allowScratch ? await scratchRoots() : [];
		const allowed = await effectiveWriteRoots(activeScope);
		for (const target of targets) {
			try {
				const record = await canonicalizePotential(target.path, target.cwd);
				if (allowScratch && isScratchPath(record.canonical, scratch)) continue;
				if (!allowed.some((root) => isWithin(root.canonical, record.canonical))) {
					return { block: true, reason: formatOutsideRootReason(record.canonical, allowed) };
				}
			} catch {
				const unresolved = resolve(target.cwd, target.path);
				return { block: true, reason: formatOutsideRootReason(unresolved, allowed) };
			}
		}
		markMutation();
		return undefined;
	}

	async function contractFailure(activeScope: ScopeState, errors: string[]) {
		contract = null;
		contractStatus = "INVALID";
		invalidReason = errors.join("; ");
		lastFinalize = { status: "STALE", reason: invalidReason };
		return textResult({
			status: "FAIL",
			guard_mode: activeScope.mode,
			errors,
		});
	}

	pi.registerTool({
		name: "contract_check",
		label: "Contract Check",
		description:
			"Validate and establish one in-memory artifact contract for the current session and cwd. Returns machine-readable PASS/FAIL.",
		promptSnippet: "Establish schema ownership, artifact sets, immutable inputs, and approved write roots",
		promptGuidelines: [
			"Use contract_check before mutation in an artifact-guard ENFORCE workspace and before guarded integration/schema/validator/QA work.",
		],
		parameters: contractCheckSchema,
		executionMode: "sequential",
		async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
			const activeScope = await syncScope(ctx);
			const errors: string[] = [];
			try {
				const rootInputs = nonEmptyStrings(input.allowed_write_roots ?? [], "allowed_write_roots", errors);
				if (rootInputs.length === 0) errors.push("allowed_write_roots must be non-empty");
				const roots: PathRecord[] = [];
				for (const rootInput of rootInputs) {
					try {
						roots.push(await canonicalizeRoot(rootInput, activeScope.cwd));
					} catch (error) {
						errors.push(error instanceof Error ? error.message : String(error));
					}
				}
				for (let left = 0; left < roots.length; left += 1) {
					for (let right = left + 1; right < roots.length; right += 1) {
						if (
							isWithin(roots[left].canonical, roots[right].canonical) ||
							isWithin(roots[right].canonical, roots[left].canonical)
						) {
							errors.push(
								`duplicate or overlapping write roots: ${roots[left].declared} and ${roots[right].declared}`,
							);
						}
					}
				}

				const concepts: Array<{ name: string; schema_owner: string }> = [];
				const owners = new Map<string, string>();
				for (const item of input.concepts ?? []) {
					const name = item.name.trim();
					const owner = item.schema_owner.trim();
					if (!name || !owner) {
						errors.push("concept names and schema owners must be non-empty");
						continue;
					}
					const prior = owners.get(name);
					if (prior && prior !== owner) errors.push(`concept ${name} declares multiple schema owners: ${prior}, ${owner}`);
					else if (!prior) {
						owners.set(name, owner);
						concepts.push({ name, schema_owner: owner });
					}
				}

				const requiredInputs = nonEmptyStrings(input.required_outputs ?? [], "required_outputs", errors);
				const forbiddenInputs = nonEmptyStrings(input.forbidden_outputs ?? [], "forbidden_outputs", errors);
				const requiredOutputs = await Promise.all(
					requiredInputs.map((path) => canonicalizePotential(path, activeScope.cwd)),
				);
				const forbiddenOutputs = await Promise.all(
					forbiddenInputs.map((path) => canonicalizePotential(path, activeScope.cwd)),
				);
				const requiredSet = new Set(requiredOutputs.map((item) => item.canonical));
				for (const output of forbiddenOutputs) {
					if (requiredSet.has(output.canonical)) {
						errors.push(`required_outputs and forbidden_outputs intersect at ${output.declared}`);
					}
				}
				for (const output of requiredOutputs) {
					if (!roots.some((root) => isWithin(root.canonical, output.canonical))) {
						errors.push(`required output is outside approved roots: ${output.declared}`);
					}
				}

				const immutableInputs: ImmutableInput[] = [];
				const immutableByPath = new Map<string, string | null>();
				for (const item of input.immutable_inputs ?? []) {
					if (item.sha256 !== undefined && item.sha256 !== null && typeof item.sha256 !== "string") {
						errors.push(`malformed SHA-256 for immutable input: ${item.path}`);
						continue;
					}
					const suppliedHash = typeof item.sha256 === "string" ? item.sha256.toLowerCase() : null;
					if (suppliedHash && !/^[a-f0-9]{64}$/.test(suppliedHash)) {
						errors.push(`malformed SHA-256 for immutable input: ${item.path}`);
						continue;
					}
					const path = await canonicalizePotential(item.path, activeScope.cwd);
					if (!(await stat(path.canonical)).isFile()) {
						errors.push(`immutable input is not a file: ${item.path}`);
						continue;
					}
					if (immutableByPath.has(path.canonical)) {
						const previous = immutableByPath.get(path.canonical);
						errors.push(
							previous === suppliedHash
								? `duplicate immutable input record: ${item.path}`
								: `conflicting immutable input record: ${item.path}`,
						);
						continue;
					}
					if (suppliedHash && (await hashFile(path.canonical)) !== suppliedHash) {
						errors.push(`immutable input hash does not match current bytes: ${item.path}`);
					}
					immutableByPath.set(path.canonical, suppliedHash);
					immutableInputs.push({ ...path, sha256: suppliedHash });
				}

				for (const output of requiredOutputs) {
					if (isInventoryName(output.canonical) && immutableByPath.has(output.canonical)) {
						errors.push(`inventory output would include/hash itself: ${output.declared}`);
					}
				}

				// Artifact-reference cycle detection is deliberately omitted: this flat schema has no reference edges.
				if (errors.length > 0) return contractFailure(activeScope, errors);
				let sessionRepositoryRoot: PathRecord | null = null;
				if (activeScope.repositoryRoot) {
					try {
						sessionRepositoryRoot = await canonicalizeRoot(activeScope.repositoryRoot, activeScope.cwd);
					} catch {
						sessionRepositoryRoot = null;
					}
				}
				const withoutDigest: Omit<ContractState, "digest"> = {
					mode: input.mode,
					concepts,
					roots,
					requiredOutputs,
					forbiddenOutputs,
					immutableInputs,
					behavioralChecks: nonEmptyStrings(input.behavioral_checks ?? [], "behavioral_checks", errors),
					deterministicRegenerationRequired: input.deterministic_regeneration_required ?? false,
					notes: input.notes?.trim() ?? "",
					sessionRepositoryRoot,
				};
				if (errors.length > 0) return contractFailure(activeScope, errors);
				const candidate: ContractState = { ...withoutDigest, digest: stableContractDigest(withoutDigest) };
				const leaseFindings = await inspectLeases(candidate, activeScope, ctx.sessionManager.getSessionId());
				if (leaseFindings.some((finding) => finding.status === "conflict")) {
					lastLeaseFindings = leaseFindings;
					return contractFailure(activeScope, [LEASE_CONFLICT_REASON]);
				}

				contract = candidate;
				contractStatus = "PASS";
				invalidReason = null;
				lastFinalize = { status: "NEVER" };
				mutationObserved = false;
				lastLeaseFindings = leaseFindings;
				const effective = await effectiveWriteRoots(activeScope);
				return textResult({
					status: "PASS",
					guard_mode: activeScope.mode,
					canonical_write_roots: roots.map((root) => root.canonical),
					effective_write_roots: effective.map((root) => root.canonical),
					session_repository_root: sessionRepositoryRoot?.canonical ?? null,
					contract_digest: candidate.digest,
					lease: leaseFindings,
				});
			} catch (error) {
				errors.push(error instanceof Error ? error.message : String(error));
				return contractFailure(activeScope, errors);
			}
		},
	});

	async function commandOutsideRoots(command: string, activeScope: ScopeState): Promise<boolean> {
		if (!contract) return false;
		const defaults = await loadGuardDefaults();
		const allowScratch = activeScope.config.allow_scratch ?? defaults.allow_scratch ?? true;
		const scratch = allowScratch ? await scratchRoots() : [];
		const allowed = await effectiveWriteRoots(activeScope);
		for (const target of bashMutationTargets(command, activeScope.cwd)) {
			const record = await canonicalizePotential(target.path, target.cwd);
			if (allowScratch && isScratchPath(record.canonical, scratch)) continue;
			if (!allowed.some((root) => isWithin(root.canonical, record.canonical))) return true;
		}
		return false;
	}

	async function runCommands(
		kind: "qa" | "negative" | "regeneration",
		commands: string[],
		activeScope: ScopeState,
		signal: AbortSignal | undefined,
		errors: string[],
	) {
		const records: Array<Record<string, unknown>> = [];
		for (const command of commands) {
			if (!command.trim()) {
				errors.push(`${kind} command is empty`);
				continue;
			}
			if (await commandOutsideRoots(command, activeScope)) {
				errors.push(`${kind} command has an obvious out-of-root mutation target`);
				records.push({
					command,
					blocked: true,
					reason: "artifact-guard: write target is outside the approved write roots.",
				});
				continue;
			}
			const result = await pi.exec("/bin/sh", ["-lc", command], { cwd: activeScope.cwd, signal });
			const stdout = bounded(result.stdout);
			const stderr = bounded(result.stderr);
			records.push({
				command,
				exit_code: result.code,
				killed: result.killed,
				stdout: stdout.text,
				stderr: stderr.text,
				output_truncated: stdout.truncated || stderr.truncated,
			});
			if (result.code !== 0 || result.killed) errors.push(`${kind} command exited ${result.code}: ${command}`);
		}
		return records;
	}

	pi.registerTool({
		name: "artifact_finalize",
		label: "Artifact Finalize",
		description:
			"Verify contracted artifacts before and after checks, require all contracted behavioral QA commands, and run only explicitly supplied QA/negative/regeneration commands. PASS is not project acceptance.",
		promptSnippet: "Finalize a guarded artifact contract with explicit behavioral QA",
		promptGuidelines: [
			"Use artifact_finalize before claiming CARD_DONE, implementation complete, or integration complete for a guarded mutation task.",
		],
		parameters: finalizeSchema,
		executionMode: "sequential",
		async execute(_toolCallId, input, signal, _onUpdate, ctx) {
			const activeScope = await syncScope(ctx);
			const errors: string[] = [];
			if (!(await revalidateContract(activeScope)) || !contract) {
				const reason = invalidReason ?? "valid contract_check is required";
				lastFinalize = { status: "FAIL", reason };
				return textResult({ status: "FAIL", errors: [reason], qa: [], negative: [], regeneration: [] });
			}

			let finalRequired: PathRecord[] = [];
			try {
				finalRequired = await Promise.all(
					(input.required_outputs ?? []).map((path) => canonicalizePotential(path, activeScope.cwd)),
				);
				if (!sameSet(finalRequired.map((item) => item.canonical), contract.requiredOutputs.map((item) => item.canonical))) {
					errors.push("artifact_finalize required_outputs drift from the established contract");
				}
			} catch (error) {
				errors.push(`cannot resolve final required outputs: ${error instanceof Error ? error.message : String(error)}`);
			}

			const requiredSet = new Set(contract.requiredOutputs.map((item) => item.canonical));
			for (const forbidden of contract.forbiddenOutputs) {
				if (requiredSet.has(forbidden.canonical)) errors.push(`required/forbidden contradiction: ${forbidden.declared}`);
			}
			await checkRequiredOutputs(contract.requiredOutputs, activeScope.cwd, "before QA", errors);
			for (const forbidden of contract.forbiddenOutputs) {
				if (await exists(forbidden.canonical)) errors.push(`forbidden output exists: ${forbidden.declared}`);
			}

			const suppliedQa = new Set((input.qa_commands ?? []).map((command) => command.trim()));
			for (const command of contract.behavioralChecks) {
				if (!suppliedQa.has(command)) errors.push(`required behavioral QA command not supplied: ${command}`);
			}
			if (errors.length > 0) {
				lastFinalize = { status: "FAIL", reason: errors.join("; ") };
				return textResult({ status: "FAIL", contract_digest: contract.digest, errors, qa: [], negative: [], regeneration: [] });
			}
			const qa = await runCommands("qa", input.qa_commands ?? [], activeScope, signal, errors);
			const negative = await runCommands("negative", input.negative_checks ?? [], activeScope, signal, errors);
			let regeneration: Array<Record<string, unknown>> = [];
			if (input.deterministic_regeneration.required !== contract.deterministicRegenerationRequired) {
				errors.push("deterministic regeneration requirement drifts from the established contract");
			}
			if (contract.deterministicRegenerationRequired) {
				const rawCommand = input.deterministic_regeneration.command;
				const command = typeof rawCommand === "string" ? rawCommand.trim() : "";
				if (!command) {
					errors.push("deterministic regeneration is required but no command was supplied");
				} else {
					const before = new Map<string, string>();
					for (const required of contract.requiredOutputs) {
						try {
							before.set(required.canonical, await hashFile(required.canonical));
						} catch {
							errors.push(`cannot snapshot required output before regeneration: ${required.declared}`);
						}
					}
					regeneration = await runCommands("regeneration", [command], activeScope, signal, errors);
					for (const required of contract.requiredOutputs) {
						try {
							const after = await hashFile(required.canonical);
							if (before.has(required.canonical) && before.get(required.canonical) !== after) {
								errors.push(`deterministic regeneration changed bytes: ${required.declared}`);
							}
						} catch {
							errors.push(`required output missing after regeneration: ${required.declared}`);
						}
					}
				}
			}

			await checkRequiredOutputs(contract.requiredOutputs, activeScope.cwd, "after QA/regeneration", errors);
			for (const forbidden of contract.forbiddenOutputs) {
				if (await exists(forbidden.canonical)) errors.push(`forbidden output exists after QA: ${forbidden.declared}`);
			}
			if (!(await revalidateContract(activeScope))) errors.push(invalidReason ?? "contract became invalid during finalization");

			const result = {
				status: errors.length === 0 ? "PASS" : "FAIL",
				contract_digest: contract?.digest ?? null,
				errors,
				qa,
				negative,
				regeneration,
			};
			if (errors.length === 0 && contract) {
				lastFinalize = { status: "PASS", digest: sha256Bytes(JSON.stringify(result)) };
			} else {
				lastFinalize = { status: "FAIL", reason: errors.join("; ") };
			}
			return textResult(result);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		scope = await inspectScope(ctx.cwd);
		clearGuardState();
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const activeScope = await syncScope(ctx);
		await revalidateContract(activeScope);
		return { systemPrompt: `${event.systemPrompt}\n\n${contractKernel(activeScope.mode)}` };
	});

	pi.on("tool_call", async (event, ctx) => {
		if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
			return gateTargets(ctx, [{ path: event.input.path, cwd: ctx.cwd }]);
		}
		if (isToolCallEventType("bash", event)) {
			const targets = bashMutationTargets(event.input.command, ctx.cwd);
			if (targets.length === 0) return undefined;
			return gateTargets(ctx, targets);
		}
		return undefined;
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant" || !mutationObserved || lastFinalize.status === "PASS") return;
		const content = event.message.content;
		if (!Array.isArray(content)) return;
		const text = content
			.filter((part): part is Extract<(typeof content)[number], { type: "text" }> => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		if (!/\bCARD_DONE\b|\bimplementation (?:is )?complete\b|\bintegration (?:is )?complete\b/i.test(text)) return;
		await syncScope(ctx);
		return {
			message: {
				...event.message,
				content: [...content, { type: "text", text: `\n\n${COMPLETION_WARNING}` }],
			},
		};
	});

	pi.registerCommand("artifact-guard", {
		description: "Show artifact-guard mode and current session state",
		handler: async (_args, ctx) => {
			const activeScope = await syncScope(ctx);
			await revalidateContract(activeScope);
			const effective = await effectiveWriteRoots(activeScope);
			const roots =
				effective.map((root) => root.canonical).join(", ") ||
				contract?.roots.map((root) => root.canonical).join(", ") ||
				"(none)";
			const finalize = [lastFinalize.status, lastFinalize.digest, lastFinalize.reason].filter(Boolean).join(": ");
			const lease =
				lastLeaseFindings.length === 0
					? activeScope.config.lease_markers?.length
						? "ownership_unverified"
						: "disabled"
					: lastLeaseFindings.map((finding) => finding.status).join(", ");
			const lines = [
				`mode: ${activeScope.mode}`,
				"contract-first kernel: ON",
				`contract status: ${contractStatus}${invalidReason ? ` (${invalidReason})` : ""}`,
				`write roots: ${roots}`,
				`contract digest: ${contract?.digest ?? "(none)"}`,
				`last finalize: ${finalize || "NEVER"}`,
				`lease: ${lease}`,
			];
			if (activeScope.configError) lines.push(`marker config: ${activeScope.configError}`);
			ctx.ui.notify(lines.join("\n"), contractStatus === "INVALID" ? "warning" : "info");
		},
	});

	pi.registerCommand("artifact-guard-reset", {
		description: "Clear only the current session artifact-guard contract state",
		handler: async (_args, ctx) => {
			await syncScope(ctx);
			clearGuardState();
			ctx.ui.notify("artifact-guard: current session guard state reset.", "info");
		},
	});
}
