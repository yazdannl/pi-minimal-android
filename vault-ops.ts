/**
 * Cancellable, policy-scoped vault operations for the android_task subagent.
 *
 * Vault secrets only ever move from the encrypted file into a focused Android field.
 * This module keeps that true while adding two things the subagent needs:
 *
 *  - cancellation checks after every await and immediately before each side effect,
 *    so a cancelled task cannot type a password or persist a rotation afterwards;
 *  - a per-task policy (label allowlist + explicit write permission) enforced in code,
 *    not in the prompt.
 *
 * SDK-free on purpose: `node --test` drives it with injected dependencies.
 */
import { find, listing, remove as removeEntry, upsert, type EntryInfo, type NewEntry, type VaultEntry } from "./vault.ts";
import { CancelledError } from "./android-task.ts";

export interface VaultDeps {
	load(): Promise<VaultEntry[]>;
	save(entries: VaultEntry[]): Promise<void>;
	/** Types a secret into the focused device field (never returns it). */
	type(value: string): Promise<unknown>;
	pressKey(name: string): Promise<unknown>;
	signal?: AbortSignal;
	/** Called right after an effect commits, even if a later step fails. */
	onCommit?(effect: { op: "fill" | "submit" | "generate" | "rotate" | "remove"; label: string }): void;
}

export interface VaultPolicy {
	/** Labels this task may fill. Empty/undefined = fills are refused. */
	labels?: readonly string[];
	/** Allow creating, rotating and deleting entries. */
	allowWrite?: boolean;
}

export type VaultOp = "list" | "fill" | "generate" | "remove";

/** Pure policy check. Never inspects secrets, only the label and the operation. */
export function authorizeVault(policy: VaultPolicy, op: VaultOp, label?: string): void {
	if (op === "list") return;
	if (!label?.trim()) throw new Error(`vault ${op} needs a label`);
	if (op === "fill") {
		const labels = (policy.labels ?? []).map((each) => each.trim().toLowerCase()).filter(Boolean);
		if (labels.length === 0) throw new Error("this android_task is not authorized to fill any vault entry (pass vaultLabels)");
		if (!labels.includes(label.trim().toLowerCase())) {
			throw new Error(`this android_task is not authorized for vault entry "${label}" (authorized: ${labels.join(", ")})`);
		}
		return;
	}
	if (!policy.allowWrite) {
		throw new Error(`this android_task is not authorized to ${op} vault entries (the caller must set allowVaultWrite)`);
	}
	if (op === "remove" || op === "generate") {
		const labels = (policy.labels ?? []).map((each) => each.trim().toLowerCase()).filter(Boolean);
		if (labels.length > 0 && !labels.includes(label.trim().toLowerCase())) {
			throw new Error(`this android_task is not authorized for vault entry "${label}" (authorized: ${labels.join(", ")})`);
		}
	}
}

export interface VaultOps {
	list(): Promise<EntryInfo[]>;
	fill(label: string, field: "password" | "username", submit: boolean): Promise<{ label: string; field: "password" | "username" }>;
	generate(input: NewEntry): Promise<{ label: string; created: boolean }>;
	remove(label: string): Promise<{ label: string; remaining: number }>;
}

export function createVaultOps(deps: VaultDeps, policy: VaultPolicy): VaultOps {
	const active = () => {
		if (deps.signal?.aborted) throw new CancelledError();
	};

	return {
		async list() {
			authorizeVault(policy, "list");
			active();
			const entries = await deps.load();
			active();
			return listing(entries);
		},

		async fill(label, field, submit) {
			authorizeVault(policy, "fill", label);
			active();
			const entries = await deps.load();
			active();
			const entry = find(entries, label);
			const value = field === "username" ? entry.username : entry.password;
			if (!value) throw new Error(`${entry.label} has no ${field} stored`);
			active();
			await deps.type(value);
			deps.onCommit?.({ op: "fill", label: entry.label });
			if (submit) {
				// Cancelled between typing and submitting: keep the fill, skip the submit.
				active();
				await deps.pressKey("enter");
				deps.onCommit?.({ op: "submit", label: entry.label });
			}
			return { label: entry.label, field };
		},

		async generate(input: NewEntry) {
			authorizeVault(policy, "generate", input.label);
			active();
			const entries = await deps.load();
			active();
			const next = upsert(entries, input);
			active();
			await deps.save(next.entries);
			deps.onCommit?.({ op: next.created ? "generate" : "rotate", label: next.entry.label });
			return { label: next.entry.label, created: next.created };
		},

		async remove(label: string) {
			authorizeVault(policy, "remove", label);
			active();
			const entries = await deps.load();
			active();
			const next = removeEntry(entries, label);
			active();
			await deps.save(next.entries);
			deps.onCommit?.({ op: "remove", label: next.entry.label });
			return { label: next.entry.label, remaining: next.entries.length };
		},
	};
}
