import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	describe,
	find,
	generatePassword,
	info,
	listing,
	open,
	readKey,
	readVaultFile,
	remove,
	seal,
	upsert,
	writeVaultFile,
	type VaultEntry,
} from "./vault.ts";

const KEY = Buffer.alloc(32, 7);

async function tmpDir(t: { after: (fn: () => Promise<void>) => void }, prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

async function tmpVault(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
	return join(await tmpDir(t, "pi-vault-test-"), "vault.enc");
}

test("generatePassword honours length and pools", () => {
	for (const length of [12, 20, 64]) {
		const password = generatePassword(length);
		assert.equal(password.length, length);
		assert.match(password, /[a-z]/);
		assert.match(password, /[A-Z]/);
		assert.match(password, /[0-9]/);
		assert.match(password, /[-_.!@#%+=]/, "symbols are on by default");
		assert.doesNotMatch(password, /[^A-Za-z0-9\-_.!@#%+=]/, "no characters that `input text` mangles");
	}
	const plain = generatePassword(24, false);
	assert.doesNotMatch(plain, /[-_.!@#%+=]/);
	assert.equal(generatePassword(999).length, 64, "length is clamped to 64");
});

test("seal/open round-trips entries and hides the secret from the ciphertext", () => {
	const { entries } = upsert([], { label: "reddit-orca_cad", site: "reddit.com", username: "orca_cad" });
	const raw = seal(entries, KEY);
	assert.doesNotMatch(raw, /orca_cad/);
	assert.doesNotMatch(raw, /reddit/);
	assert.doesNotMatch(raw, new RegExp(entries[0].password.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.deepEqual(open(raw, KEY), entries);
});

test("a wrong key fails without leaking the payload", () => {
	const { entries } = upsert([], { label: "mail", site: "nesfi.app", username: "agent@nesfi.app" });
	const raw = seal(entries, KEY);
	assert.throws(() => open(raw, Buffer.alloc(32, 9)), /cannot decrypt the vault/);
	assert.throws(() => open("not json", KEY), /not valid JSON/);
});

test("upsert creates, then rotates by label case-insensitively", () => {
	const first = upsert([], { label: "GitHub-Agent", site: "github.com", username: "yazdannl", length: 32 }, new Date("2026-10-22T10:00:00Z"));
	assert.equal(first.created, true);
	assert.equal(first.entries.length, 1);
	assert.equal(first.entry.password.length, 32);
	const second = upsert(first.entries, { label: "github-agent", site: "github.com" }, new Date("2026-10-23T10:00:00Z"));
	assert.equal(second.created, false);
	assert.equal(second.entries.length, 1);
	assert.notEqual(second.entry.password, first.entry.password, "rotating replaces the secret");
	assert.equal(second.entry.label, "github-agent");
	assert.equal(second.entry.username, "yazdannl", "an omitted username keeps the old one");
	assert.equal(second.entry.createdAt, first.entry.createdAt);
	assert.notEqual(second.entry.updatedAt, first.entry.updatedAt);
});

test("labels must be usable identifiers", () => {
	assert.throws(() => upsert([], { label: "" }), /label is required/);
	assert.throws(() => upsert([], { label: "has space" }), /label must be/);
	assert.throws(() => upsert([], { label: "x".repeat(80) }), /label must be/);
});

test("listing and describe never expose the password", () => {
	const { entries } = upsert([], { label: "bank", site: "bank.example", username: "acct" });
	const rows = listing(entries);
	assert.equal(rows.length, 1);
	assert.ok(!("password" in rows[0]));
	const text = `${JSON.stringify(rows)} ${describe(rows[0])}`;
	assert.doesNotMatch(text, new RegExp(entries[0].password.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.equal(info(entries[0]).username, "acct");
});

test("find resolves by label or id and reports available labels", () => {
	const { entries } = upsert([], { label: "one" });
	const withTwo = upsert(entries, { label: "two" }).entries;
	assert.equal(find(withTwo, "TWO").label, "two");
	assert.equal(find(withTwo, withTwo[0].id).label, "one");
	assert.throws(() => find(withTwo, "three"), /no vault entry "three" \(labels: .*one.*two/);
});

test("remove drops exactly one entry", () => {
	const a = upsert([], { label: "alpha" }).entries;
	const b = upsert(a, { label: "beta" }).entries;
	const { entries, entry } = remove(b, "alpha");
	assert.equal(entry.label, "alpha");
	assert.deepEqual(
		entries.map((each: VaultEntry) => each.label),
		["beta"],
	);
	assert.throws(() => remove(entries, "alpha"), /no vault entry/);
});

test("readKey creates a 32-byte 0600 key once and reuses it", async (t) => {
	const path = join(await tmpDir(t, "pi-vault-key-"), "vault.key");
	const first = await readKey(path);
	assert.equal(first.length, 32);
	assert.equal((await stat(path)).mode & 0o777, 0o600);
	assert.deepEqual(await readKey(path), first);
	await writeFile(path, "short", { mode: 0o600 });
	await assert.rejects(() => readKey(path), /is not 32 bytes/);
});

test("file helpers write 0600 atomically and report a missing vault as null", async (t) => {
	const path = await tmpVault(t);
	assert.equal(await readVaultFile(path), null);
	const { entries } = upsert([], { label: "phone", site: "android", username: "agent" });
	await writeVaultFile(seal(entries, KEY), path);
	assert.equal((await stat(path)).mode & 0o777, 0o600);
	assert.deepEqual(open(await readFile(path, "utf8"), KEY), entries);
	await writeVaultFile(seal([], KEY), path);
	assert.deepEqual(open(await readFile(path, "utf8"), KEY), []);
	await writeFile(path, "broken", { mode: 0o600 });
	assert.throws(() => open("broken", KEY), /not valid JSON/);
});
