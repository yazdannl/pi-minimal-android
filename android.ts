/**
 * Android host control over the chroot bridge.
 *
 * Everything here talks to Android through `chroot /proc/1/root /system/bin/<bin>`.
 * Native binaries (screencap, input, am, dumpsys, wm, pm) work from the chroot;
 * ART-based ones (uiautomator, app_process, monkey) segfault under the magisk
 * SELinux domain, so elements come from OCR of the framebuffer plus the view
 * hierarchy that `dumpsys activity <pkg>` prints.
 */
import { execFile } from "node:child_process";
import { closeSync, constants, openSync, writeSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";

/** Android root as seen from the chroot. */
const ANDROID_ROOT = process.env.PI_ANDROID_ROOT || "/proc/1/root";
const DEVICE_TMP = "/data/local/tmp";

export type Box = [number, number, number, number]; // left, top, right, bottom

export interface Element {
	text?: string;
	id?: string;
	cls?: string;
	box: Box;
	/** Per-word boxes straight from OCR, so "English" in "English Deutsch" taps the word, not the gap. */
	words?: { text: string; box: Box }[];
}

export interface ScreenState {
	app: string; // package
	activity: string;
	size: [number, number];
	awake: boolean;
}

function run(cmd: string, args: string[], timeout = 30_000): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			cmd,
			args,
			{ timeout, maxBuffer: 32 * 1024 * 1024, encoding: "utf8" },
			(error, stdout, stderr) => {
				if (error) {
					reject(new Error(`${cmd} ${args.join(" ")}: ${(stderr || error.message).trim()}`));
					return;
				}
				resolve(stdout);
			},
		);
	});
}

/** Run a native Android binary directly (no shell, so arguments are safe). */
export function dev(bin: string, ...args: string[]): Promise<string> {
	return run("chroot", [ANDROID_ROOT, `/system/bin/${bin}`, ...args]);
}

/** Run a fixed shell pipeline on the device. Never pass user text into it. */
function devSh(script: string): Promise<string> {
	return run("chroot", [ANDROID_ROOT, "/system/bin/sh", "-c", script]);
}

// ---------------------------------------------------------------- screen state

export function parseFocus(dump: string): { app: string; activity: string } {
	const pattern = /([\w.]+)\/([\w.$]+)/;
	const focus = dump.match(/mCurrentFocus=Window\{[^}]*?\s([\w.]+\/[\w.$]+)/);
	if (focus) {
		const [, app, activity] = focus[1].match(pattern)!;
		return { app, activity: `${app}/${activity}` };
	}
	// Pop-up windows and other transient windows do not name a component; the focused
	// app still does, which is what element lookups need.
	const app = dump.match(/mFocusedApp=ActivityRecord\{[^}]*?\s([\w.]+)\/([\w.$]+)/);
	if (!app) return { app: "", activity: "" };
	return { app: app[1], activity: `${app[1]}/${app[2]}` };
}

export function parseAwake(dump: string): boolean {
	if (/mDreamingLockscreen=true/.test(dump)) return false;
	const awake = dump.match(/mAwake=(\w+)/);
	return awake ? awake[1] === "true" : true;
}

export function parseSize(out: string): [number, number] {
	const m = out.match(/(\d+)x(\d+)/);
	return m ? [Number(m[1]), Number(m[2])] : [0, 0];
}

let cachedSize: [number, number] | null = null;

export async function screenState(): Promise<ScreenState> {
	const [dump, sizeOut] = await Promise.all([
		devSh(
			"dumpsys window 2>/dev/null | grep -m1 mCurrentFocus; dumpsys window 2>/dev/null | grep -m1 mFocusedApp; dumpsys window 2>/dev/null | grep -m1 -E 'mAwake=|mDreamingLockscreen=true'",
		),
		cachedSize ? Promise.resolve("") : dev("wm", "size"),
	]);
	if (!cachedSize) cachedSize = parseSize(sizeOut);
	return { ...parseFocus(dump), size: cachedSize, awake: parseAwake(dump) };
}

// ------------------------------------------------------------------- elements

const NODE_LINE = /^(\s*)([A-Za-z0-9_.$]+)\{(.*)\}$/;

export function parseNodeDump(dump: string): Element[] {
	const elements: Element[] = [];
	for (const raw of dump.split("\n")) {
		const match = raw.match(NODE_LINE);
		if (!match) continue;
		const [, , cls, body] = match;
		const box = body.match(/(-?\d+),(-?\d+)-(-?\d+),(-?\d+)/);
		if (!box) continue;
		const left = Number(box[1]);
		const top = Number(box[2]);
		const right = Number(box[3]);
		const bottom = Number(box[4]);
		if (right <= left || bottom <= top) continue;
		const id = body.match(/#\d+\s+([\w.]+:id\/[\w]+)/)?.[1] ?? body.match(/([\w.]+:id\/[\w]+)/)?.[1];
		if (!id) continue;
		if ((right - left) * (bottom - top) < 3000) continue;
		elements.push({ id, cls, box: [left, top, right, bottom] });
	}
	return elements;
}

export function parseOcrTsv(tsv: string): Element[] {
	const lines = new Map<
		string,
		{ text: string; words: { text: string; box: Box }[]; box: Box; conf: number; n: number }
	>();
	const rows = tsv.split("\n").slice(1);
	for (const row of rows) {
		const cols = row.split("\t");
		if (cols.length < 12 || cols[0] !== "5") continue;
		const conf = Number(cols[10]);
		const word = cols.slice(11).join(" ").trim();
		if (!word || !Number.isFinite(conf) || conf < 40) continue;
		const key = `${cols[2]}:${cols[3]}:${cols[4]}`;
		const left = Number(cols[6]);
		const top = Number(cols[7]);
		const right = left + Number(cols[8]);
		const bottom = top + Number(cols[9]);
		const line = lines.get(key);
		if (!line) {
			lines.set(key, {
				text: word,
				words: [{ text: word, box: [left, top, right, bottom] }],
				box: [left, top, right, bottom],
				conf,
				n: 1,
			});
			continue;
		}
		line.text = `${line.text} ${word}`;
		line.words.push({ text: word, box: [left, top, right, bottom] });
		line.box = [
			Math.min(line.box[0], left),
			Math.min(line.box[1], top),
			Math.max(line.box[2], right),
			Math.max(line.box[3], bottom),
		];
		line.conf += conf;
		line.n += 1;
	}
	return [...lines.values()].map((line) => ({ text: line.text, box: line.box, words: line.words }));
}

function contains(box: [number, number, number, number], x: number, y: number): boolean {
	return x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3];
}

function area(box: [number, number, number, number]): number {
	return (box[2] - box[0]) * (box[3] - box[1]);
}

/** Merge OCR text with view-hierarchy ids so every element carries text and/or an id. */
export function mergeElements(texts: Element[], nodes: Element[]): Element[] {
	const used = new Set<Element>();
	const merged = texts.map((element) => {
		const [left, top, right, bottom] = element.box;
		const cx = (left + right) / 2;
		const cy = (top + bottom) / 2;
		let holder: Element | undefined;
		for (const node of nodes) {
			if (!contains(node.box, cx, cy)) continue;
			if (area(node.box) > area(element.box) * 12) continue; // a scroll container says nothing about one line
			if (!holder || area(node.box) < area(holder.box)) holder = node;
		}
		if (!holder) return element;
		used.add(holder);
		return { ...element, id: holder.id, cls: holder.cls };
	});
	const extras = nodes
		.filter((node) => !used.has(node))
		.filter((node, index, all) => all.findIndex((other) => other.id === node.id && other.box.join() === node.box.join()) === index)
		// container ids are layout noise; keep only views that hold nothing else
		.filter((node) => {
			const holders = [...merged, ...nodes];
			return !holders.some(
				(other) =>
					other !== node &&
					contains(node.box, (other.box[0] + other.box[2]) / 2, (other.box[1] + other.box[3]) / 2) &&
					area(node.box) > area(other.box),
			);
		});
	for (const extra of extras) {
		const [left, top, right, bottom] = extra.box;
		if (right - left < 60 || bottom - top < 40) continue;
		merged.push(extra);
	}
	return merged.sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]);
}

export function describeElement(element: Element, index: number, scale = imageScale()): string {
	const [left, top, right, bottom] = element.box;
	const [x, y] = deviceToImage(Math.round((left + right) / 2), Math.round((top + bottom) / 2), scale);
	const center = `${x},${y}`;
	const text = element.text ? `"${element.text}"` : "";
	const id = element.id ? `#${element.id}` : "";
	const cls = element.text && element.id ? (element.cls ?? "") : element.cls && !element.text ? element.cls : "";
	return [`[${index}]`, `tap=${center}`, text, id, cls].filter(Boolean).join(" ");
}

// --------------------------------------------------------- coordinate spaces

/**
 * Agents read coordinates off the image they were given, and that image is downscaled.
 * Every coordinate this module prints or accepts therefore lives in the image space of the
 * last screenshot, and is converted to device pixels only right before a gesture. That
 * keeps "what I see" and "what I can tap" the same thing.
 */
export interface ShotSpace {
	scale: number;
	image: [number, number];
	device: [number, number];
}

let shotSpaceState: ShotSpace | null = null;

/** Record the geometry of the image handed to the agent (called by optimizeShot). */
export function setShotSpace(space: ShotSpace | null): void {
	shotSpaceState = space;
}

export function shotSpace(): ShotSpace | null {
	return shotSpaceState;
}

/** Shrink factor of the last image; 1 means image pixels are device pixels. */
export function imageScale(): number {
	return shotSpaceState?.scale ?? 1;
}

/** Device pixels -> pixels of the image the agent is looking at. */
export function deviceToImage(x: number, y: number, scale = imageScale()): [number, number] {
	return [Math.round(x * scale), Math.round(y * scale)];
}

/** Pixels of the image the agent is looking at -> device pixels. */
export function imageToDevice(x: number, y: number, scale = imageScale()): [number, number] {
	return [Math.round(x / scale), Math.round(y / scale)];
}

export type CoordSpace = "auto" | "image" | "device";

export interface ResolvedPoint {
	/** Device pixels, safe to hand to a gesture. */
	x: number;
	y: number;
	space: "image" | "device";
	note?: string;
}

/**
 * Turn hand-typed x,y into device pixels. With "auto", a value that cannot fit the image
 * but does fit the screen is read as device pixels - the classic double-scale mistake -
 * instead of landing off-target.
 */
export function resolveCoords(x: number, y: number, space: CoordSpace = "auto"): ResolvedPoint {
	const scale = imageScale();
	if (space === "device" || scale === 1) {
		return { x: Math.round(x), y: Math.round(y), space: "device" };
	}
	const image = shotSpaceState!.image;
	if (space === "auto" && (x > image[0] || y > image[1])) {
		return {
			x: Math.round(x),
			y: Math.round(y),
			space: "device",
			note: `outside image ${image[0]}x${image[1]}, read as device pixels`,
		};
	}
	const [dx, dy] = imageToDevice(x, y, scale);
	return { x: dx, y: dy, space: "image" };
}

function unionBox(boxes: Box[]): Box {
	return boxes.reduce<Box>(
		(acc, box) => [Math.min(acc[0], box[0]), Math.min(acc[1], box[1]), Math.max(acc[2], box[2]), Math.max(acc[3], box[3])],
		[Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, 0, 0],
	);
}

/**
 * Box of the matched words inside an OCR line. "English" in "English Deutsch" then taps the
 * English word instead of the middle of the line, which is the gap between the two links.
 */
export function wordBox(element: Element, needle: string): Box {
	const wanted = needle.trim().toLowerCase();
	const words = element.words;
	if (!words?.length || !wanted || wanted === element.text?.trim().toLowerCase()) return element.box;
	for (let start = 0; start < words.length; start += 1) {
		let text = "";
		for (let end = start; end < words.length; end += 1) {
			text = text ? `${text} ${words[end].text}` : words[end].text;
			const lower = text.toLowerCase();
			if (lower === wanted) return unionBox(words.slice(start, end + 1).map((word) => word.box));
			if (!wanted.startsWith(lower)) break;
		}
	}
	const single = words.find((word) => word.text.toLowerCase() === wanted);
	return single ? single.box : element.box;
}

export interface UiSnapshot {
	state: ScreenState;
	elements: Element[];
	truncated: number;
}

let lastSnapshot: UiSnapshot | null = null;

/**
 * Screenshot the framebuffer. The device file name is unique per call so a stale
 * capture from an earlier call can never be mistaken for the current screen.
 *
 * The returned PNG is full resolution because OCR needs it; use `optimizeShot` before
 * handing an image to the model.
 */
export async function capture(): Promise<Buffer> {
	const path = `${DEVICE_TMP}/pi-android-${process.pid}-${Date.now()}.png`;
	try {
		await dev("screencap", "-p", path);
		return await readFile(`${ANDROID_ROOT}${path}`);
	} finally {
		await rm(`${ANDROID_ROOT}${path}`, { force: true });
	}
}

// ------------------------------------------------------------ image shrinking

export type ShotFormat = "png" | "jpeg" | "webp";

export interface ShotOptions {
	/** Fraction of the framebuffer to keep (0.1-1, default 0.5). */
	scale?: number;
	format?: ShotFormat;
	/** Encoder quality for jpeg/webp (1-100, default 80). */
	quality?: number;
	/** Palette size for png (2-256, default 128). */
	colors?: number;
}

export interface Shot {
	data: Buffer;
	mimeType: string;
	width: number;
	height: number;
	bytes: number;
	originalBytes: number;
	format: ShotFormat;
	/** Framebuffer size the image was cut from. */
	device: [number, number];
	/** Image pixels per device pixel. */
	scale: number;
}

const MIME: Record<ShotFormat, string> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };

/** Width and height from the PNG IHDR chunk (no subprocess needed). */
export function pngSize(png: Buffer): [number, number] {
	if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47) return [0, 0];
	return [png.readUInt32BE(16), png.readUInt32BE(20)];
}

export function shotScale(scale?: number): number {
	if (!Number.isFinite(scale) || !scale) return 0.5;
	return Math.min(1, Math.max(0.1, scale));
}

/** ImageMagick arguments that downscale and re-encode a screenshot for the model. */
export function shotArgs(
	source: string,
	target: string,
	options: ShotOptions = {},
	size: [number, number],
): string[] {
	const scale = shotScale(options.scale);
	const format = options.format ?? "png";
	const quality = Math.min(100, Math.max(1, Math.round(options.quality ?? 80)));
	const colors = Math.min(256, Math.max(2, Math.round(options.colors ?? 128)));
	const width = Math.max(1, Math.round(size[0] * scale));
	const args = [source, "-resize", `${width}x`, "-strip"];
	if (format === "png") {
		args.push("-colors", String(colors), "-define", "png:compression-level=9");
	} else if (format === "jpeg") {
		args.push("-quality", String(quality), "-sampling-factor", "4:2:0", "-interlace", "JPEG");
	} else {
		args.push("-quality", String(quality));
	}
	args.push(target);
	return args;
}

/**
 * Shrink a screenshot before it goes back to the agent. Pixel count drives image
 * tokens, and a 128-colour PNG keeps UI text sharp at a fraction of the bytes.
 */
export async function optimizeShot(png: Buffer, options: ShotOptions = {}): Promise<Shot> {
	const format = options.format ?? "png";
	const size = pngSize(png);
	const scale = shotScale(options.scale);
	const width = Math.max(1, Math.round(size[0] * scale));
	const height = Math.max(1, Math.round(size[1] * scale));
	const ext = format === "jpeg" ? "jpg" : format;
	const source = `/tmp/pi-android-${process.pid}-${Date.now()}.png`;
	const target = `/tmp/pi-android-${process.pid}-${Date.now()}-out.${ext}`;
	await writeFile(source, png);
	try {
		await run("convert", [...shotArgs(source, target, { ...options, format }, size)], 60_000).catch(
			(error: Error) => {
				throw new Error(/ENOENT/.test(error.message) ? "ImageMagick is not installed: apt-get install -y imagemagick" : error.message);
			},
		);
		const data = await readFile(target);
		setShotSpace({ scale, image: [width, height], device: [size[0], size[1]] });
		return {
			data,
			mimeType: MIME[format],
			width,
			height,
			bytes: data.length,
			originalBytes: png.length,
			format,
			device: [size[0], size[1]],
			scale,
		};
	} finally {
		await rm(source, { force: true });
		await rm(target, { force: true });
	}
}

export async function readUi(options: { nodes?: boolean; max?: number } = {}): Promise<UiSnapshot> {
	const max = options.max ?? 60;
	const [state, png] = await Promise.all([screenState(), capture()]);
	const tsv = await ocrPng(png);
	const texts = parseOcrTsv(tsv);
	let nodes: Element[] = [];
	if (options.nodes !== false && state.app) {
		nodes = parseNodeDump(await dev("dumpsys", "activity", state.app));
	}
	const all = mergeElements(texts, nodes);
	const elements = all.slice(0, max);
	lastSnapshot = { state, elements, truncated: all.length - elements.length };
	return lastSnapshot;
}

/** Resolve a tap target from the last android_ui snapshot. */
export function resolveTarget(target: string | number, options: { space?: CoordSpace } = {}): ResolvedPoint & { label: string } {
	const snapshot = lastSnapshot;
	const coords = String(target).match(/^\s*(\d+)\s*,\s*(\d+)\s*$/);
	if (coords) {
		const point = resolveCoords(Number(coords[1]), Number(coords[2]), options.space);
		const where = point.note ? `${point.space} (${point.note})` : `${point.space} pixels`;
		return { ...point, label: `coords ${coords[1]},${coords[2]} -> device ${point.x},${point.y} [${where}]` };
	}
	const center = (box: Box) => ({
		x: Math.round((box[0] + box[2]) / 2),
		y: Math.round((box[1] + box[3]) / 2),
	});
	const index = Number(target);
	if (Number.isInteger(index) && index > 0) {
		const element = snapshot?.elements[index - 1];
		if (!element) throw new Error(`No element [${index}]. Call android_ui first; valid range is 1..${snapshot?.elements.length ?? 0}.`);
		return { ...center(element.box), space: "device", label: describeElement(element, index) };
	}
	const needle = String(target).trim().toLowerCase();
	if (!snapshot) throw new Error("No element list yet. Call android_ui first, or pass x,y coordinates.");
	const hits = snapshot.elements.filter((element) => element.text?.toLowerCase().includes(needle));
	const exact = hits.filter((element) => element.text?.trim().toLowerCase() === needle);
	const chosen = exact.length ? exact : hits;
	if (!chosen.length) throw new Error(`No element matching "${target}". Call android_ui to see the current list.`);
	if (chosen.length > 1) {
		const list = chosen.map((element) => describeElement(element, snapshot.elements.indexOf(element) + 1)).join("; ");
		throw new Error(`"${target}" is ambiguous: ${list}. Tap by index instead.`);
	}
	const element = chosen[0];
	const box = wordBox(element, needle);
	const point = center(box);
	const [imageX, imageY] = deviceToImage(point.x, point.y);
	const where = box === element.box ? "" : ` [word at image ${imageX},${imageY}]`;
	return {
		...point,
		space: "device",
		label: `${describeElement(element, snapshot.elements.indexOf(element) + 1)}${where} -> device ${point.x},${point.y}`,
	};
}

export async function ocrPng(png: Buffer): Promise<string> {
	const path = `/tmp/pi-android-${process.pid}-${Date.now()}.png`;
	await writeFile(path, png);
	try {
		return await run("tesseract", [path, "stdout", "tsv", "--psm", "11"], 120_000).catch((error: Error) => {
			throw new Error(
				/ENOENT/.test(error.message)
					? "tesseract is not installed: apt-get install -y tesseract-ocr (the element list needs it)"
					: error.message,
			);
		});
	} finally {
		await rm(path, { force: true });
	}
}

// --------------------------------------------------------------------- actions

/**
 * Gestures are injected as raw multi-touch events on the real touchscreen device
 * node (/dev/input/eventN), so they are indistinguishable from a finger. The
 * `input` binary only goes through InputManager, where windows that block
 * untrusted touches (any targetSdk 32+ app, e.g. Firefox) silently drop the event.
 * `input` stays as a fallback when the device node cannot be opened.
 */

/** Touchscreen input device with its hardware coordinate range. */
export interface TouchDevice {
	/** Node path as seen from the chroot, e.g. /proc/1/root/dev/input/event2. */
	path: string;
	name: string;
	xMax: number;
	yMax: number;
}

const EV_SYN = 0;
const EV_KEY = 1;
const EV_ABS = 3;
const ABS_MT_SLOT = 0x2f;
const ABS_MT_TOUCH_MAJOR = 0x30;
const ABS_MT_POSITION_X = 0x35;
const ABS_MT_POSITION_Y = 0x36;
const ABS_MT_TRACKING_ID = 0x39;
const ABS_MT_PRESSURE = 0x3a;
const BTN_TOUCH = 0x14a;

/** Parse `getevent -pl`: a touchscreen is a device exposing both MT position axes. */
export function parseTouchDevices(dump: string): TouchDevice[] {
	const devices: TouchDevice[] = [];
	for (const block of dump.split(/^add device /m).slice(1)) {
		const path = block.match(/^\d+:\s*(\/dev\/input\/\S+)/m)?.[1];
		if (!path) continue;
		const axis = (label: "X" | "Y") =>
			block.match(new RegExp(`ABS_MT_POSITION_${label}\\s*:\\s*value -?\\d+, min -?\\d+, max (-?\\d+)`));
		const x = axis("X");
		const y = axis("Y");
		if (!x || !y) continue;
		devices.push({
			path: `${ANDROID_ROOT}${path}`,
			name: block.match(/name:\s*"([^"]*)"/)?.[1] ?? "",
			xMax: Number(x[1]),
			yMax: Number(y[1]),
		});
	}
	return devices;
}

/** One Linux input_event record (64-bit timeval + type + code + value = 24 bytes). */
export function encodeInputEvent(type: number, code: number, value: number): Buffer {
	const buffer = Buffer.alloc(24);
	buffer.writeBigInt64LE(0n, 0);
	buffer.writeBigInt64LE(0n, 8);
	buffer.writeUInt16LE(type, 16);
	buffer.writeUInt16LE(code, 18);
	buffer.writeInt32LE(value, 20);
	return buffer;
}

export interface TouchWriter {
	down(x: number, y: number): void;
	move(x: number, y: number): void;
	up(): void;
	close(): void;
}

/** Open the device node and map screen pixels onto its hardware coordinate range. */
export function openTouch(device: TouchDevice, size: [number, number]): TouchWriter {
	const width = Math.max(1, size[0]);
	const height = Math.max(1, size[1]);
	const fd = openSync(device.path, constants.O_WRONLY);
	let trackingId = 1000 + Math.floor(Math.random() * 1000);
	const emit = (type: number, code: number, value: number) => writeSync(fd, encodeInputEvent(type, code, value));
	const toX = (x: number) => Math.round((x * device.xMax) / width);
	const toY = (y: number) => Math.round((y * device.yMax) / height);
	return {
		down(x, y) {
			emit(EV_ABS, ABS_MT_SLOT, 0);
			emit(EV_ABS, ABS_MT_TRACKING_ID, ++trackingId);
			emit(EV_ABS, ABS_MT_POSITION_X, toX(x));
			emit(EV_ABS, ABS_MT_POSITION_Y, toY(y));
			emit(EV_ABS, ABS_MT_TOUCH_MAJOR, 40);
			emit(EV_ABS, ABS_MT_PRESSURE, 60);
			emit(EV_KEY, BTN_TOUCH, 1);
			emit(EV_SYN, 0, 0);
		},
		move(x, y) {
			emit(EV_ABS, ABS_MT_SLOT, 0);
			emit(EV_ABS, ABS_MT_POSITION_X, toX(x));
			emit(EV_ABS, ABS_MT_POSITION_Y, toY(y));
			emit(EV_SYN, 0, 0);
		},
		up() {
			emit(EV_ABS, ABS_MT_SLOT, 0);
			emit(EV_ABS, ABS_MT_TRACKING_ID, -1);
			emit(EV_KEY, BTN_TOUCH, 0);
			emit(EV_SYN, 0, 0);
		},
		close() {
			closeSync(fd);
		},
	};
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let cachedTouch: TouchDevice[] | null = null;

/** The panel that reports MT positions (prefers a real touchscreen over sensors). */
export async function touchDevice(): Promise<TouchDevice | null> {
	if (!cachedTouch) {
		const dump = await dev("getevent", "-pl").catch(() => "");
		const devices = parseTouchDevices(dump);
		const real = devices.find((device) => /touchscreen|touch|-ts$|sec_touch/i.test(device.name));
		cachedTouch = real ? [real, ...devices.filter((device) => device !== real)] : devices;
	}
	return cachedTouch[0] ?? null;
}

/** Run one gesture on the raw device; resolves false when raw injection is unavailable. */
async function withTouch(gesture: (touch: TouchWriter) => Promise<void>): Promise<boolean> {
	const device = await touchDevice();
	if (!device) return false;
	if (!cachedSize) cachedSize = parseSize(await dev("wm", "size"));
	let touch: TouchWriter;
	try {
		touch = openTouch(device, cachedSize);
	} catch {
		cachedTouch = null; // no permission on this device: fall back and stop probing
		return false;
	}
	try {
		await gesture(touch);
	} catch (error) {
		try {
			touch.up();
		} catch {}
		throw error;
	} finally {
		touch.close();
	}
	return true;
}

export async function tap(x: number, y: number): Promise<void> {
	const done = await withTouch(async (touch) => {
		touch.down(x, y);
		await sleep(60);
		touch.up();
	});
	if (!done) await dev("input", "tap", String(x), String(y));
}

export async function longPress(x: number, y: number): Promise<void> {
	const done = await withTouch(async (touch) => {
		touch.down(x, y);
		await sleep(600);
		touch.up();
	});
	if (!done) await dev("input", "swipe", String(x), String(y), String(x), String(y), "600");
}

export async function swipe(x1: number, y1: number, x2: number, y2: number, duration = 300): Promise<void> {
	const done = await withTouch(async (touch) => {
		const steps = Math.max(6, Math.min(60, Math.round(duration / 12)));
		touch.down(x1, y1);
		const start = Date.now();
		for (let step = 1; step <= steps; step += 1) {
			const progress = step / steps;
			touch.move(x1 + (x2 - x1) * progress, y1 + (y2 - y1) * progress);
			const due = start + duration * progress - Date.now();
			if (due > 0) await sleep(due);
		}
		touch.up();
	});
	if (!done) await dev("input", "swipe", String(x1), String(y1), String(x2), String(y2), String(duration));
}

export async function scroll(direction: "up" | "down" | "left" | "right"): Promise<void> {
	const [width, height] = cachedSize ?? parseSize(await dev("wm", "size"));
	cachedSize = [width, height];
	if (direction === "down" || direction === "up") {
		const cx = Math.round(width / 2);
		const from = Math.round(height * (direction === "down" ? 0.72 : 0.32));
		const to = Math.round(height * (direction === "down" ? 0.32 : 0.72));
		await swipe(cx, from, cx, to, 260);
		return;
	}
	const cy = Math.round(height / 2);
	const from = Math.round(width * (direction === "right" ? 0.8 : 0.2));
	const to = Math.round(width * (direction === "right" ? 0.2 : 0.8));
	await swipe(from, cy, to, cy, 260);
}

export async function key(name: string): Promise<string> {
	const code = /^[0-9]+$/.test(name) ? name : `KEYCODE_${name.replace(/^KEYCODE_/i, "").replace(/[\s-]+/g, "_").toUpperCase()}`;
	await dev("input", "keyevent", code);
	return code;
}

/**
 * `input text` rewrites "%s" to a space and leaves every other "%" alone (verified on the
 * device: "50%%" arrives as "50%%"), so only spaces need escaping.
 */
export function escapeText(text: string): string {
	return text.replace(/ /g, "%s");
}

export async function typeText(text: string): Promise<void> {
	await dev("input", "text", escapeText(text));
}

/**
 * Type a string that must not appear in any process argument list (vault secrets).
 *
 * `input text <value>` would put the value into /proc/<pid>/cmdline where another
 * local process can read it, so the text is staged in a 0600 device file and read
 * by the shell inside the device instead. The file is removed in every outcome.
 */
export async function typeTextFromFile(text: string, label = "text"): Promise<number> {
	if (/%s/i.test(text)) throw new Error('value contains "%s", which `input text` turns into a space; store a different value');
	const remote = `${DEVICE_TMP}/pi-android-${label}-${process.pid}-${Date.now()}.txt`;
	const hostPath = `${ANDROID_ROOT}${remote}`;
	await writeFile(hostPath, escapeText(text), { mode: 0o600 });
	try {
		await devSh(`/system/bin/input text "$(cat ${remote})"`);
	} finally {
		await rm(hostPath, { force: true });
	}
	return text.length;
}

export async function resolveActivity(app: string): Promise<string> {
	const brief = await dev("cmd", "package", "resolve-activity", "--brief", "-c", "android.intent.category.LAUNCHER", app);
	const component = brief.trim().split("\n").pop()?.trim() ?? "";
	if (!component.includes("/")) throw new Error(`No launcher activity for "${app}".`);
	return component;
}

export async function launch(app: string): Promise<string> {
	if (/^https?:\/\//i.test(app)) {
		return dev("am", "start", "-a", "android.intent.action.VIEW", "-d", app);
	}
	let pkg = app;
	if (!/^[a-z][\w]*(\.[\w]+)+$/i.test(pkg)) {
		const packages = (await dev("pm", "list", "packages")).split("\n").map((line) => line.replace("package:", "").trim());
		const exact = packages.find((name) => name.toLowerCase() === pkg.toLowerCase());
		const hits = exact
			? [exact]
			: packages
					.filter((name) => name.toLowerCase().includes(pkg.toLowerCase()))
					.filter((name) => !name.includes("auto_generated_rro"));
		if (hits.length !== 1) {
			throw new Error(
				hits.length
					? `"${app}" is ambiguous: ${hits.slice(0, 8).join(", ")}`
					: `No installed package matches "${app}". Use android_ui or pm list packages.`,
			);
		}
		pkg = hits[0];
	}
	const component = await resolveActivity(pkg);
	const out = await dev("am", "start", "-W", "-n", component);
	if (/Error|Exception/.test(out)) throw new Error(out.trim());
	return `launched ${component}`;
}

export async function forceStop(app: string): Promise<string> {
	const target = /^browser$/i.test(app) ? await defaultBrowser() : app;
	await dev("am", "force-stop", target);
	return `stopped ${target}`;
}

/** Package name of the current default `VIEW https://` handler, so callers never hardcode a browser. */
export async function defaultBrowser(): Promise<string> {
	const out = await dev("cmd", "package", "resolve-activity", "--brief", "-a", "android.intent.action.VIEW", "-d", "https://example.com");
	const pkg = parseResolvedPackage(out);
	if (!pkg) throw new Error(`No default browser resolved: ${out.trim() || "(no output)"}`);
	return pkg;
}

/** Pull `pkg/activity` out of `cmd package resolve-activity --brief` output (last matching line). */
export function parseResolvedPackage(out: string): string | null {
	const lines = out
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => /^[A-Za-z][\w]*(\.[\w]+)+\//.test(line));
	const last = lines.pop();
	return last ? (last.split("/")[0] ?? null) : null;
}

export function resetCache() {
	cachedSize = null;
	cachedTouch = null;
	lastSnapshot = null;
	shotSpaceState = null;
}

// -------------------------------------------------------------------- browsing

/** Add a scheme to bare hosts/words; keep everything that already looks like a URL. */
export function normalizeUrl(input: string): string {
	const trimmed = input.trim();
	if (!trimmed) throw new Error("browse needs a URL");
	if (/^[a-z][\w+.-]*:\/\//i.test(trimmed)) return trimmed;
	if (/^(about|data|file|mailto|sms|tel):/i.test(trimmed)) return trimmed;
	return `https://${trimmed}`;
}

/** Visible text lines of the current screen (OCR only, no tap points). */
export async function readText(): Promise<string[]> {
	const png = await capture();
	const lines = parseOcrTsv(await ocrPng(png));
	return lines.map((line) => (line.text ?? "").trim()).filter(Boolean);
}

export interface PageSnapshot {
	app: string;
	activity: string;
	lines: string[];
}

/**
 * Open a URL in the default browser and wait until the screen text stops changing,
 * so the returned lines describe the loaded page rather than the previous one.
 */
export async function browse(
	url: string,
	options: { settleMs?: number; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<PageSnapshot> {
	if (options.signal?.aborted) throw new Error("android browse cancelled");
	const target = normalizeUrl(url);
	const out = await dev("am", "start", "-W", "-a", "android.intent.action.VIEW", "-d", target);
	if (/Error|Exception/.test(out)) throw new Error(out.trim());
	const settleMs = options.settleMs ?? 700;
	const deadline = Date.now() + (options.timeoutMs ?? 20_000);
	let state = await screenState();
	let previousState = state;
	let previous = "";
	let lines: string[] = [];
	let stable = 0;
	while (Date.now() < deadline) {
		if (options.signal?.aborted) throw new Error("android browse cancelled");
		await sleep(settleMs);
		state = await screenState();
		if (!state.activity) state = previousState.activity ? previousState : state;
		previousState = state;
		lines = await readText();
		const signature = lines.join("\n");
		if (signature && signature === previous) {
			stable += 1;
			if (stable >= 1) break;
		} else {
			stable = 0;
		}
		previous = signature;
	}
	return { app: state.app, activity: state.activity, lines };
}

