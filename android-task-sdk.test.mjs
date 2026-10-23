/**
 * SDK-backed checks for the android_task subagent. No network and no device access:
 * a stub provider answers, and the only tools are test tools.
 *
 * The extension is imported from a staging copy so its bare imports resolve against
 * the installed Pi SDK, the same trick the old load check used.
 */
import assert from "node:assert/strict";
import { access, cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const EXTENSION_DIR = new URL(".", import.meta.url).pathname;
const SDK_DIR = process.env.PI_SDK_DIR ?? "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent";
const AGENTS_MARKER = "PLANTED-AGENTS-MARKER-DO-NOT-LEAK";

async function sdkAvailable() {
	try {
		await access(join(SDK_DIR, "dist", "index.js"));
		return true;
	} catch {
		return false;
	}
}

const available = await sdkAvailable();
const skip = available ? false : `Pi SDK not found at ${SDK_DIR}`;

async function stage() {
	const dir = await mkdtemp(join(tmpdir(), "pi-android-task-"));
	for (const file of ["pi-android.ts", "android.ts", "android-task.ts", "vault.ts", "vault-ops.ts"]) {
		await cp(join(EXTENSION_DIR, file), join(dir, file));
	}
	await mkdir(join(dir, "node_modules", "@earendil-works"), { recursive: true });
	await symlink(SDK_DIR, join(dir, "node_modules", "@earendil-works", "pi-coding-agent"));
	await symlink(
		join(SDK_DIR, "node_modules", "@earendil-works", "pi-tui"),
		join(dir, "node_modules", "@earendil-works", "pi-tui"),
	);
	await symlink(join(SDK_DIR, "node_modules", "typebox"), join(dir, "node_modules", "typebox"));
	await writeFile(join(dir, "AGENTS.md"), `# Project rules\n\n${AGENTS_MARKER}\n`);
	await mkdir(join(dir, "agent"), { recursive: true });
	return dir;
}

async function fakeModelRuntime(toolsReply) {
	const piAi = await import(pathToFileURL(join(SDK_DIR, "node_modules", "@earendil-works", "pi-ai", "dist", "index.js")).href);
	const sdk = await import(pathToFileURL(join(SDK_DIR, "dist", "index.js")).href);
	const model = {
		id: "stub-1",
		name: "Stub",
		api: "openai-completions",
		provider: "stub",
		baseUrl: "http://127.0.0.1:9",
		input: ["text"],
		reasoning: false,
		contextWindow: 10_000,
		maxTokens: 1_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	let turn = 0;
	const provider = piAi.createProvider({
		id: "stub",
		models: [model],
		auth: {
			apiKey: {
				name: "Stub API key",
				resolve: async () => ({ auth: { apiKey: "stub" } }),
			},
		},
		api: {
			stream: () => fakeStream(turn++ === 0 ? toolsReply() : finalReply()),
			streamSimple: () => fakeStream(turn++ === 0 ? toolsReply() : finalReply()),
		},
	});
	const runtime = await sdk.ModelRuntime.create({ allowModelNetwork: false });
	runtime.registerNativeProvider(provider);
	return { runtime, model };
}

function fakeStream(message) {
	return {
		async result() {
			return message;
		},
		async *[Symbol.asyncIterator]() {
			yield { type: "done", reason: "toolUse", message };
		},
	};
}

function assistantMessage(content, stopReason) {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "stub",
		model: "stub-1",
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

const toolsReply = () => assistantMessage([{ type: "toolCall", id: "call-1", name: "hanging", arguments: {} }], "toolUse");
const finalReply = () => assistantMessage([{ type: "text", text: "finished" }], "stop");

function hangingTool(started, released) {
	return {
		name: "hanging",
		label: "Hanging",
		description: "test tool that never cooperates with cancellation",
		parameters: { type: "object", properties: {} },
		async execute() {
			started();
			await released;
			return { content: [{ type: "text", text: "ok" }] };
		},
	};
}

test("parent registers android_task and android_shot only", { skip }, async () => {
	const dir = await stage();
	try {
		const mod = await import(pathToFileURL(join(dir, "pi-android.ts")).href);
		const tools = [];
		const commands = [];
		mod.default({
			registerTool(tool) {
				tools.push(tool);
			},
			registerCommand(name) {
				commands.push(name);
			},
		});
		assert.deepEqual(tools.map((tool) => tool.name).sort(), ["android_shot", "android_task"]);
		assert.deepEqual(commands, ["vault"]);

		const task = tools.find((tool) => tool.name === "android_task");
		const ctx = { cwd: dir, model: undefined };
		await assert.rejects(task.execute("id", { task: "   " }, undefined, undefined, ctx), /needs a task/);
		await assert.rejects(
			task.execute("id", { task: "x".repeat(8001) }, undefined, undefined, ctx),
			/too long/,
		);
		await assert.rejects(
			task.execute("id", { task: "do something" }, undefined, undefined, ctx),
			/needs an active model/,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("the child session has exactly the nine operator tools, our prompt and no project context", { skip }, async () => {
	const dir = await stage();
	try {
		const mod = await import(pathToFileURL(join(dir, "pi-android.ts")).href);
		const helpers = await import(pathToFileURL(join(dir, "android-task.ts")).href);
		const gate = helpers.createDeviceGate();
		const lease = await gate.beginTask();
		const definitions = mod.childToolDefinitions(gate, lease, helpers.createEffectLog(), {});
		const model = {
			id: "stub-1",
			name: "Stub",
			api: "openai-completions",
			provider: "stub",
			baseUrl: "http://127.0.0.1:9",
			input: ["text"],
			reasoning: false,
			contextWindow: 10_000,
			maxTokens: 1_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		const session = await mod.createAndroidSubagentSession({
			cwd: dir,
			agentDir: join(dir, "agent"),
			model,
			thinkingLevel: "medium",
			tools: definitions,
		});
		try {
			assert.deepEqual(session.getActiveToolNames().sort(), [
				"android_act",
				"android_browse",
				"android_read",
				"android_shot",
				"android_ui",
				"vault_fill",
				"vault_generate",
				"vault_list",
				"vault_remove",
			]);
			for (const builtin of ["bash", "read", "write", "edit", "android_task", "codemode"]) {
				assert.equal(session.getActiveToolNames().includes(builtin), false, `${builtin} must not be active`);
			}
			assert.match(session.systemPrompt, /operates one Android phone for another agent/);
			assert.match(session.systemPrompt, /untrusted data/);
			assert.match(session.systemPrompt, /Never reveal vault values/);
			assert.equal(session.systemPrompt.includes(AGENTS_MARKER), false, "project AGENTS.md leaked into the child prompt");
			assert.deepEqual(session.messages, []);
		} finally {
			session.dispose();
			gate.endTask(lease);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

async function runWithStubTool({ rejectAbort }) {
	const dir = await stage();
	const mod = await import(pathToFileURL(join(dir, "pi-android.ts")).href);
	const helpers = await import(pathToFileURL(join(dir, "android-task.ts")).href);
	let startedResolve;
	const started = new Promise((resolve) => {
		startedResolve = resolve;
	});
	let releaseTool;
	const released = new Promise((resolve) => {
		releaseTool = resolve;
	});
	const { runtime, model } = await fakeModelRuntime(toolsReply);
	const gate = helpers.createDeviceGate();
	const lease = await gate.beginTask();
	const session = await mod.createAndroidSubagentSession({
		cwd: dir,
		agentDir: join(dir, "agent"),
		model,
		modelRuntime: runtime,
		thinkingLevel: "off",
		tools: [hangingTool(startedResolve, released)],
	});
	if (rejectAbort) session.abort = async () => Promise.reject(new Error("abort failed"));

	const calls = { reset: 0, release: 0, dispose: 0, late: 0 };
	const run = helpers.runAndroidSubagent(session, "run the tool", {
		timeoutMs: 50,
		settleBudgetMs: 50,
		resetState: () => calls.reset++,
		release: () => {
			calls.release++;
			gate.endTask(lease);
		},
		dispose: () => {
			calls.dispose++;
			session.dispose();
		},
		onLate: () => calls.late++,
	});
	await started;
	assert.equal(session.isIdle, false, "the tool must still be running");
	const result = await run;
	assert.equal(result.report.pending, true);
	assert.deepEqual(calls, { reset: 0, release: 0, dispose: 0, late: 0 }, "ownership must be held while a tool is active");
	assert.equal(session.isIdle, false);

	releaseTool();
	await result.late;
	assert.equal(session.isIdle, true);
	assert.deepEqual(calls, { reset: 1, release: 1, dispose: 1, late: 1 });
	await rm(dir, { recursive: true, force: true });
}

test("a real session with a tool that ignores cancellation keeps ownership until idle", { skip }, async () => {
	await runWithStubTool({ rejectAbort: false });
});

test("a rejecting abort() does not count as a confirmed stop", { skip }, async () => {
	await runWithStubTool({ rejectAbort: true });
});
