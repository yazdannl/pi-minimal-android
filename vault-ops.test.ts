import assert from "node:assert/strict";
import { test } from "node:test";
import { CancelledError } from "./android-task.ts";
import { authorizeVault, createVaultOps, type VaultDeps } from "./vault-ops.ts";
import type { VaultEntry } from "./vault.ts";

function entry(label: string, password = `secret-${label}`): VaultEntry {
	return {
		id: `id-${label}`,
		label,
		site: "example.com",
		username: `${label}@example.com`,
		password,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
}

function makeDeps(entries: VaultEntry[], options: { signal?: AbortSignal; onLoad?: () => void | Promise<void> } = {}) {
	const calls = { load: 0, save: 0, type: 0, pressKey: 0, typed: [] as string[], commits: [] as string[], saved: [] as VaultEntry[] };
	let stored = [...entries];
	const deps: VaultDeps = {
		async load() {
			calls.load += 1;
			await options.onLoad?.();
			return stored;
		},
		async save(next) {
			calls.save += 1;
			calls.saved.push(next);
			stored = [...next];
		},
		async type(value) {
			calls.type += 1;
			calls.typed.push(value);
		},
		async pressKey() {
			calls.pressKey += 1;
		},
		signal: options.signal,
		onCommit: (effect) => calls.commits.push(`${effect.op} ${effect.label}`),
	};
	return { deps, calls };
}

test("policy: list is free, fill needs an authorized label, writes need the flag", () => {
	assert.doesNotThrow(() => authorizeVault({}, "list"));
	assert.throws(() => authorizeVault({}, "fill", "reddit"), /not authorized to fill/);
	assert.throws(() => authorizeVault({ labels: [] }, "fill", "reddit"), /not authorized to fill/);
	assert.throws(() => authorizeVault({ labels: ["other"] }, "fill", "reddit"), /not authorized for vault entry "reddit"/);
	assert.doesNotThrow(() => authorizeVault({ labels: ["REDDIT"] }, "fill", "reddit"));
	assert.throws(() => authorizeVault({ labels: ["reddit"] }, "generate", "reddit"), /not authorized to generate/);
	assert.throws(() => authorizeVault({ labels: ["reddit"], allowWrite: true }, "generate", "other"), /not authorized for vault entry "other"/);
	assert.doesNotThrow(() => authorizeVault({ labels: ["reddit"], allowWrite: true }, "generate", "reddit"));
	assert.throws(() => authorizeVault({ allowWrite: false }, "remove", "reddit"), /not authorized to remove/);
	assert.doesNotThrow(() => authorizeVault({ allowWrite: true }, "remove", "reddit"));
});

test("fill types the secret and never records it", async () => {
	const { deps, calls } = makeDeps([entry("reddit")]);
	const ops = createVaultOps(deps, { labels: ["reddit"] });
	const result = await ops.fill("reddit", "password", true);
	assert.deepEqual(result, { label: "reddit", field: "password" });
	assert.equal(calls.type, 1);
	assert.equal(calls.typed[0], "secret-reddit");
	assert.equal(calls.pressKey, 1);
	assert.deepEqual(calls.commits, ["fill reddit", "submit reddit"]);
	assert.ok(!calls.commits.join(" ").includes("secret-reddit"));
});

test("cancellation during the vault read prevents typing", async () => {
	const controller = new AbortController();
	const { deps, calls } = makeDeps([entry("reddit")], {
		signal: controller.signal,
		onLoad: () => controller.abort(),
	});
	const ops = createVaultOps(deps, { labels: ["reddit"] });
	await assert.rejects(ops.fill("reddit", "password", false), CancelledError);
	assert.equal(calls.type, 0);
	assert.equal(calls.pressKey, 0);
	assert.deepEqual(calls.commits, []);
});

test("cancellation after typing keeps the fill but skips the submit", async () => {
	const controller = new AbortController();
	const { deps, calls } = makeDeps([entry("reddit")], { signal: controller.signal });
	deps.type = async (value) => {
		calls.type += 1;
		calls.typed.push(value);
		controller.abort();
	};
	const ops = createVaultOps(deps, { labels: ["reddit"] });
	await assert.rejects(ops.fill("reddit", "password", true), CancelledError);
	assert.equal(calls.type, 1);
	assert.equal(calls.pressKey, 0);
	assert.deepEqual(calls.commits, ["fill reddit"]);
});

test("cancellation before persistence prevents rotation and removal", async () => {
	for (const operation of ["generate", "remove"] as const) {
		const controller = new AbortController();
		const { deps, calls } = makeDeps([entry("reddit")], {
			signal: controller.signal,
			onLoad: () => controller.abort(),
		});
		const ops = createVaultOps(deps, { allowWrite: true });
		await assert.rejects(
			operation === "generate" ? ops.generate({ label: "reddit" }) : ops.remove("reddit"),
			CancelledError,
		);
		assert.equal(calls.save, 0, `${operation} must not persist after cancellation`);
		assert.deepEqual(calls.commits, []);
	}
});

test("generate and remove record their commit and metadata only", async () => {
	const { deps, calls } = makeDeps([entry("reddit")]);
	const ops = createVaultOps(deps, { allowWrite: true });

	const created = await ops.generate({ label: "github", site: "github.com" });
	assert.deepEqual(created, { label: "github", created: true });
	assert.equal(calls.save, 1);
	assert.deepEqual(calls.commits, ["generate github"]);

	const rotated = await ops.generate({ label: "reddit" });
	assert.deepEqual(rotated, { label: "reddit", created: false });
	assert.deepEqual(calls.commits, ["generate github", "rotate reddit"]);

	const removed = await ops.remove("reddit");
	assert.equal(removed.label, "reddit");
	assert.equal(removed.remaining, 1);
	assert.deepEqual(calls.commits, ["generate github", "rotate reddit", "remove reddit"]);

	for (const saved of calls.saved) {
		for (const each of saved) assert.ok(each.password.length > 0);
	}
	// Nothing the parent sees may contain a secret.
	assert.ok(!JSON.stringify(calls.commits).includes("secret-"));
});

test("fill refuses a label the policy did not authorize, before reading the vault", async () => {
	const { deps, calls } = makeDeps([entry("reddit")]);
	const ops = createVaultOps(deps, { labels: ["github"] });
	await assert.rejects(ops.fill("reddit", "password", false), /not authorized for vault entry/);
	assert.equal(calls.load, 0);
	assert.equal(calls.type, 0);
});

test("list returns metadata without secrets", async () => {
	const { deps } = makeDeps([entry("reddit"), entry("github")]);
	const listed = await createVaultOps(deps, {}).list();
	assert.deepEqual(listed.map((each) => each.label), ["github", "reddit"]);
	for (const each of listed) assert.equal("password" in each, false);
});
