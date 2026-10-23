/**
 * Small encrypted password vault for agent-usable credentials.
 *
 * Threat model: the *agent* (the model) must never receive a stored secret. Every
 * function here is written so that secrets flow only one way - from the encrypted
 * file into an Android input field. Nothing returns a password: listings carry
 * label/site/username only, and generation returns metadata about the entry.
 *
 * At rest the vault is a single JSON document encrypted with AES-256-GCM under a
 * 32-byte key kept in a sibling 0600 file, so there is nothing to unlock: the
 * extension reads the key on demand. That protects the secrets from ending up in
 * prompts, transcripts, backups and memory files (the point), not from someone who
 * can already read root-owned files on this box.
 */
import { createCipheriv, createDecipheriv, randomBytes, randomInt } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";

export interface VaultEntry {
	id: string;
	/** Unique, human label the agent uses: "reddit-orca_cad". */
	label: string;
	/** Website or app the credential belongs to. */
	site: string;
	username: string;
	password: string;
	createdAt: string;
	updatedAt: string;
}

/** Entry shape that is safe to show the agent: everything but the secret. */
export type EntryInfo = Omit<VaultEntry, "password">;

export interface NewEntry {
	label: string;
	site?: string;
	username?: string;
	password?: string;
	length?: number;
	symbols?: boolean;
}

interface VaultFile {
	v: 2;
	cipher: "aes-256-gcm";
	iv: string;
	tag: string;
	data: string;
}

export const DEFAULT_VAULT_PATH = process.env.PI_VAULT_PATH || `${homedir()}/.pi/agent/android-vault.enc`;
export const DEFAULT_KEY_PATH = process.env.PI_VAULT_KEY_PATH || `${homedir()}/.pi/agent/android-vault.key`;

const KEY_LEN = 32;
const AAD = Buffer.from("pi-android-vault-v2");

// Alphabet avoids look-alikes (l/I/1, O/0) and characters that `input text` mangles
// (space, quotes, backslash, shell-significant characters are all absent).
const LOWER = "abcdefghijkmnopqrstuvwxyz";
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGITS = "23456789";
const SYMBOLS = "-_.!@#%+=";

export function generatePassword(length = 20, symbols = true): string {
	const size = Math.min(64, Math.max(12, Math.round(length || 20)));
	const pools = [LOWER, UPPER, DIGITS, ...(symbols ? [SYMBOLS] : [])];
	const all = pools.join("");
	const pick = (pool: string) => pool[randomInt(pool.length)];
	const chars = pools.map(pick);
	while (chars.length < size) chars.push(pick(all));
	for (let i = chars.length - 1; i > 0; i--) {
		const j = randomInt(i + 1);
		[chars[i], chars[j]] = [chars[j], chars[i]];
	}
	return chars.slice(0, size).join("");
}

// ------------------------------------------------------------------------ crypto

/** Read the vault key, creating it once with 0600 permissions. */
export async function readKey(path = DEFAULT_KEY_PATH): Promise<Buffer> {
	try {
		const raw = (await readFile(path, "utf8")).trim();
		const key = Buffer.from(raw, "base64");
		if (key.length !== KEY_LEN) throw new Error(`vault key at ${path} is not ${KEY_LEN} bytes`);
		return key;
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
	}
	await mkdir(dirname(path), { recursive: true });
	const key = randomBytes(KEY_LEN);
	await writeFile(path, `${key.toString("base64")}\n`, { mode: 0o600 });
	return key;
}

/** Encrypt the entry list into the on-disk JSON document. */
export function seal(entries: VaultEntry[], key: Buffer): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	cipher.setAAD(AAD);
	const data = Buffer.concat([cipher.update(JSON.stringify({ entries }), "utf8"), cipher.final()]);
	const doc: VaultFile = {
		v: 2,
		cipher: "aes-256-gcm",
		iv: iv.toString("base64"),
		tag: cipher.getAuthTag().toString("base64"),
		data: data.toString("base64"),
	};
	return JSON.stringify(doc, null, 2);
}

/** Decrypt the on-disk document. Throws when the key does not match the file. */
export function open(raw: string, key: Buffer): VaultEntry[] {
	let doc: VaultFile;
	try {
		doc = JSON.parse(raw);
	} catch {
		throw new Error("vault file is not valid JSON");
	}
	if (doc?.v !== 2) throw new Error("unsupported vault version");
	try {
		const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(doc.iv, "base64"));
		decipher.setAAD(AAD);
		decipher.setAuthTag(Buffer.from(doc.tag, "base64"));
		const plain = Buffer.concat([decipher.update(Buffer.from(doc.data, "base64")), decipher.final()]).toString("utf8");
		const parsed = JSON.parse(plain);
		if (!Array.isArray(parsed?.entries)) throw new Error("vault payload is malformed");
		return parsed.entries as VaultEntry[];
	} catch (cause) {
		if (cause instanceof Error && cause.message === "vault payload is malformed") throw cause;
		throw new Error(`cannot decrypt the vault: the key does not match ${DEFAULT_VAULT_PATH}`);
	}
}

// ----------------------------------------------------------------------- storage

export async function readVaultFile(path = DEFAULT_VAULT_PATH): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw cause;
	}
}

/** Write the vault atomically with 0600 permissions. */
export async function writeVaultFile(raw: string, path = DEFAULT_VAULT_PATH): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}`;
	await writeFile(tmp, raw, { mode: 0o600 });
	await rename(tmp, path);
}

// --------------------------------------------------------------------- operations

export function makeId(): string {
	return randomBytes(6).toString("hex");
}

export function info(entry: VaultEntry): EntryInfo {
	const { password: _password, ...rest } = entry;
	return rest;
}

export function listing(entries: VaultEntry[]): EntryInfo[] {
	return entries.map(info).sort((a, b) => a.label.localeCompare(b.label));
}

/** Find one entry by id or label (case-insensitive). */
export function find(entries: VaultEntry[], key: string): VaultEntry {
	const needle = key.trim().toLowerCase();
	const entry = entries.find((each) => each.id === key) ?? entries.find((each) => each.label.toLowerCase() === needle);
	if (!entry) {
		const labels = entries.map((each) => each.label).join(", ") || "none";
		throw new Error(`no vault entry "${key}" (labels: ${labels})`);
	}
	return entry;
}

/**
 * Create or rotate an entry. The secret is generated here (or taken from the caller
 * only when it already holds one the user typed) and never returned.
 */
export function upsert(entries: VaultEntry[], input: NewEntry, now = new Date()): { entries: VaultEntry[]; entry: VaultEntry; created: boolean } {
	const label = input.label?.trim();
	if (!label) throw new Error("label is required");
	if (!/^[a-z0-9][a-z0-9._@-]{1,63}$/i.test(label)) throw new Error('label must be 2-64 chars of letters, digits, ".", "_", "@" or "-"');
	const stamp = now.toISOString();
	const password = input.password ?? generatePassword(input.length, input.symbols);
	const existing = entries.find((each) => each.label.toLowerCase() === label.toLowerCase());
	if (existing) {
		const updated: VaultEntry = {
			...existing,
			label,
			site: input.site?.trim() || existing.site,
			username: input.username?.trim() || existing.username,
			password,
			updatedAt: stamp,
		};
		return { entries: entries.map((each) => (each.id === existing.id ? updated : each)), entry: updated, created: false };
	}
	const entry: VaultEntry = {
		id: makeId(),
		label,
		site: input.site?.trim() || "",
		username: input.username?.trim() || "",
		password,
		createdAt: stamp,
		updatedAt: stamp,
	};
	return { entries: [...entries, entry], entry, created: true };
}

export function remove(entries: VaultEntry[], key: string): { entries: VaultEntry[]; entry: VaultEntry } {
	const entry = find(entries, key);
	return { entries: entries.filter((each) => each.id !== entry.id), entry };
}

/** One line describing an entry without its secret. */
export function describe(entry: EntryInfo): string {
	const parts = [`${entry.label}`, entry.site || "no site", entry.username || "no username", `updated ${entry.updatedAt.slice(0, 10)}`];
	return parts.join(" · ");
}
