import assert from "node:assert/strict";
import { test } from "node:test";
import {
	capture,
	describeElement,
	encodeInputEvent,
	escapeText,
	mergeElements,
	deviceToImage,
	imageToDevice,
	normalizeUrl,
	optimizeShot,
	parseAwake,
	parseFocus,
	parseNodeDump,
	parseOcrTsv,
	parseResolvedPackage,
	parseSize,
	parseTouchDevices,
	pngSize,
	readUi,
	resolveCoords,
	resetCache,
	resolveTarget,
	screenState,
	setShotSpace,
	shotArgs,
	shotSpace,
	shotScale,
	touchDevice,
	wordBox,
} from "./android.ts";

const FOCUS_LINE =
	"  mCurrentFocus=Window{b67d217 u0 com.android.settings/com.android.settings.homepage.SettingsHomepageActivity}";

test("parseResolvedPackage reads the default handler from resolve-activity output", () => {
	const out = [
		"priority=0 preferredOrder=0 match=0x208000 specificIndex=-1 isDefault=true",
		"de.baumann.browser/.activity.BrowserActivity",
	].join("\n");
	assert.equal(parseResolvedPackage(out), "de.baumann.browser");
	assert.equal(parseResolvedPackage("No activity found"), null);
});

test("parseFocus lifts package and activity", () => {
	assert.deepEqual(parseFocus(FOCUS_LINE), {
		app: "com.android.settings",
		activity: "com.android.settings/com.android.settings.homepage.SettingsHomepageActivity",
	});
	assert.deepEqual(parseFocus("  mCurrentFocus=null"), { app: "", activity: "" });
	assert.deepEqual(
		parseFocus(
			[
				"  mCurrentFocus=Window{b33ae80 u0 Pop-up window}",
				"  mFocusedApp=ActivityRecord{113559262 u0 org.mozilla.fennec_fdroid/org.mozilla.fenix.HomeActivity t91}",
			].join("\n"),
		),
		{ app: "org.mozilla.fennec_fdroid", activity: "org.mozilla.fennec_fdroid/org.mozilla.fenix.HomeActivity" },
		"pop-up windows fall back to the focused app",
	);
});

test("parseAwake reads awake and lockscreen flags", () => {
	assert.equal(parseAwake("mAwake=true mScreenOnFully=true"), true);
	assert.equal(parseAwake("mAwake=false"), false);
	assert.equal(parseAwake("mDreamingLockscreen=true"), false);
});

test("parseSize reads wm size", () => {
	assert.deepEqual(parseSize("Physical size: 1440x3200"), [1440, 3200]);
	assert.deepEqual(parseSize("garbage"), [0, 0]);
});

test("parseNodeDump keeps sized, id-bearing views only", () => {
	const dump = [
		"    View Hierarchy:",
		"\tandroid.widget.FrameLayout{77d7de4 V.E...... ........ 0,0-1440,3200 #1020002 android:id/content}",
		"\t\tandroid.widget.TextView{abc1234 V.E...... ........ 64,64-400,120}",
		"\t\tandroid.widget.Button{def5678 V.E...... ........ 40,200-1400,260 #7f0a035f app:id/primary_button}",
		"\t\tandroid.view.View{aabbcc1 G.E...... ......I. 0,0-0,0 #7f0a9999 app:id/hidden}",
	].join("\n");
	assert.deepEqual(parseNodeDump(dump), [
		{ id: "android:id/content", cls: "android.widget.FrameLayout", box: [0, 0, 1440, 3200] },
		{ id: "app:id/primary_button", cls: "android.widget.Button", box: [40, 200, 1400, 260] },
	]);
});

test("parseOcrTsv groups words into lines and drops noise", () => {
	const header = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext";
	const rows = [
		header,
		"5\t1\t1\t1\t1\t1\t341\t605\t109\t47\t96.2\tNetwork",
		"5\t1\t1\t1\t1\t2\t556\t605\t281\t76\t91.5\tand",
		"5\t1\t1\t1\t1\t3\t900\t600\t200\t50\t88.0\tInternet",
		"5\t1\t1\t1\t2\t1\t340\t692\t179\t47\t91.0\tWi-Fi",
		"5\t1\t1\t1\t3\t1\t10\t10\t50\t20\t12.0\tnoise",
		"4\t1\t1\t1\t1\t1\t0\t0\t1\t1\t100\tparagraph",
	];
	const lines = parseOcrTsv(rows.join("\n"));
	assert.deepEqual(
		lines.map((line) => ({ text: line.text, box: line.box })),
		[
			{ text: "Network and Internet", box: [341, 600, 1100, 681] },
			{ text: "Wi-Fi", box: [340, 692, 519, 739] },
		],
	);
	assert.deepEqual(lines[0].words, [
		{ text: "Network", box: [341, 605, 450, 652] },
		{ text: "and", box: [556, 605, 837, 681] },
		{ text: "Internet", box: [900, 600, 1100, 650] },
	], "word boxes are kept for precise text targets");
});

test("wordBox taps the matched word, not the middle of the line", () => {
	const line = {
		text: "English Deutsch",
		box: [183, 1082, 1255, 1153] as [number, number, number, number],
		words: [
			{ text: "English", box: [183, 1082, 470, 1153] as [number, number, number, number] },
			{ text: "Deutsch", box: [560, 1082, 900, 1153] as [number, number, number, number] },
		],
	};
	assert.deepEqual(wordBox(line, "english"), [183, 1082, 470, 1153], "the word, not the line gap");
	assert.deepEqual(wordBox(line, "deutsch"), [560, 1082, 900, 1153]);
	assert.deepEqual(wordBox(line, "English Deutsch"), line.box, "full text keeps the whole line");
	assert.deepEqual(wordBox(line, "missing"), line.box, "unknown text falls back to the line");
});

test("coordinates convert between image and device space", () => {
	resetCache();
	setShotSpace({ scale: 0.5, image: [720, 1600], device: [1440, 3200] });
	assert.deepEqual(deviceToImage(600, 900), [300, 450]);
	assert.deepEqual(imageToDevice(300, 450), [600, 900]);

	assert.deepEqual(resolveCoords(300, 450, "image"), { x: 600, y: 900, space: "image" });
	assert.deepEqual(resolveCoords(600, 900, "device"), { x: 600, y: 900, space: "device" });
	assert.deepEqual(resolveCoords(300, 450), { x: 600, y: 900, space: "image" }, "auto keeps in-image coordinates");
	const deviceLike = resolveCoords(1100, 2500);
	assert.equal(deviceLike.x, 1100, "x=1100 cannot fit a 720 wide image");
	assert.equal(deviceLike.y, 2500);
	assert.equal(deviceLike.space, "device", "out-of-image values are read as device pixels");
	assert.ok(deviceLike.note);

	resetCache();
	assert.deepEqual(resolveCoords(600, 900), { x: 600, y: 900, space: "device" }, "without a shot image space is device space");
});

test("mergeElements labels text with the smallest containing view id", () => {
	resetCache();
	const texts = [{ text: "Search settings", box: [300, 280, 900, 360] }];
	const nodes = [
		{ id: "app:id/page", cls: "FrameLayout", box: [0, 0, 1440, 3200] as [number, number, number, number] },
		{ id: "app:id/search", cls: "EditText", box: [200, 260, 1200, 380] as [number, number, number, number] },
		{ id: "app:id/unused", cls: "ImageButton", box: [1200, 260, 1400, 380] as [number, number, number, number] },
	];
	const merged = mergeElements(texts, nodes);
	const search = merged.find((element) => element.text === "Search settings");
	assert.equal(search?.id, "app:id/search");
	assert.equal(search?.cls, "EditText");
	assert.deepEqual(
		merged.map((element) => element.id),
		["app:id/unused", "app:id/search"],
		"container ids are dropped, leaf ids kept",
	);
	assert.match(describeElement(search!, 1), /^\[1\] tap=600,320 "Search settings" #app:id\/search EditText$/);
});

test("escapeText survives input text escaping", () => {
	assert.equal(escapeText("hello world"), "hello%sworld");
	assert.equal(escapeText("50%"), "50%");
	assert.equal(escapeText("a b%"), "a%sb%");
});

test("parseTouchDevices picks devices with both MT position axes", () => {
	const dump = [
		"add device 4: /dev/input/event2",
		'  name:     "sec_touchscreen"',
		"  events:",
		"    KEY (0001): KEY_WAKEUP            BTN_TOUCH",
		"    ABS (0003): ABS_MT_SLOT           : value 0, min 0, max 9, fuzz 0, flat 0, resolution 0",
		"                ABS_MT_POSITION_X     : value 0, min 0, max 4095, fuzz 0, flat 0, resolution 0",
		"                ABS_MT_POSITION_Y     : value 0, min 0, max 4095, fuzz 0, flat 0, resolution 0",
		"add device 5: /dev/input/event3",
		'  name:     "sec_touchproximity"',
		"  events:",
		"    ABS (0003): 003e                  : value 0, min 0, max -1, fuzz 0, flat 0, resolution 0",
		"add device 6: /dev/input/event1",
		'  name:     "gpio_keys"',
	].join("\n");
	assert.deepEqual(parseTouchDevices(dump), [
		{ path: "/proc/1/root/dev/input/event2", name: "sec_touchscreen", xMax: 4095, yMax: 4095 },
	]);
	assert.deepEqual(parseTouchDevices("garbage"), []);
});

test("encodeInputEvent writes a 24 byte arm64 input_event", () => {
	const event = encodeInputEvent(3, 0x35, 4095);
	assert.equal(event.length, 24);
	assert.equal(event.readUInt16LE(16), 3, "type at offset 16");
	assert.equal(event.readUInt16LE(18), 0x35, "code at offset 18");
	assert.equal(event.readInt32LE(20), 4095, "value at offset 20");
	const release = encodeInputEvent(3, 0x39, -1);
	assert.equal(release.readInt32LE(20), -1, "release tracking id is signed");
});

test("normalizeUrl keeps schemes and upgrades bare hosts", () => {
	assert.equal(normalizeUrl("https://example.com"), "https://example.com");
	assert.equal(normalizeUrl("example.com/page"), "https://example.com/page");
	assert.equal(normalizeUrl("about:config"), "about:config");
	assert.equal(normalizeUrl("localhost:8000"), "https://localhost:8000", "host:port is not a scheme");
	assert.throws(() => normalizeUrl("   "));
});

test("pngSize reads IHDR dimensions", () => {
	const png = Buffer.alloc(33);
	png.writeUInt32BE(0x89504e47, 0);
	png.writeUInt32BE(1440, 16);
	png.writeUInt32BE(3200, 20);
	assert.deepEqual(pngSize(png), [1440, 3200]);
	assert.deepEqual(pngSize(Buffer.from("not a png")), [0, 0]);
});

test("shotArgs downscales and picks the encoder flags", () => {
	const size: [number, number] = [1440, 3200];

	const palette = shotArgs("in.png", "out.png", {}, size);
	assert.deepEqual(palette.slice(0, 4), ["in.png", "-resize", "720x", "-strip"], "default keeps half the width");
	assert.ok(palette.includes("-colors") && palette.includes("128"), "palette png by default");
	assert.equal(palette[palette.length - 1], "out.png");

	const jpeg = shotArgs("in.png", "out.jpg", { scale: 1, format: "jpeg", quality: 70 }, size);
	assert.deepEqual(jpeg.slice(1, 3), ["-resize", "1440x"], "scale 1 keeps the framebuffer size");
	assert.ok(jpeg.includes("70") && !jpeg.includes("-colors"));

	const webp = shotArgs("in.png", "out.webp", { format: "webp", scale: 0.3 }, size);
	assert.deepEqual(webp.slice(1, 3), ["-resize", "432x"]);

	assert.deepEqual([shotScale(undefined), shotScale(2), shotScale(0.01)], [0.5, 1, 0.1]);
});

const LIVE = process.env.PI_ANDROID_LIVE === "1";

test("live device round-trip", { skip: !LIVE }, async () => {
	resetCache();
	const png = await capture();
	assert.equal(png.subarray(1, 4).toString(), "PNG", "screencap returns PNG");

	const state = await screenState();
	assert.match(state.app, /^[\w.]+$/);
	assert.ok(state.size[0] > 0 && state.size[1] > 0);

	const device = await touchDevice();
	assert.ok(device, "raw touch injection device is available");
	assert.match(device!.path, /\/dev\/input\/event\d+$/);

	// shots shrink before they go to the model, and lose bytes while doing it
	const shot = await optimizeShot(png);
	assert.equal(shot.mimeType, "image/png");
	assert.equal(shot.format, "png");
	assert.deepEqual([shot.width, shot.height], [Math.round(state.size[0] / 2), Math.round(state.size[1] / 2)]);
	assert.ok(shot.bytes < png.length, `compressed ${shot.bytes} < raw ${png.length}`);
	// the space recorded by the shot is the space the agent reads coordinates in
	const space = shotSpace();
	assert.ok(space, "shot space is recorded");
	assert.equal(space!.scale, 0.5);
	assert.deepEqual(space!.image, [Math.round(state.size[0] / 2), Math.round(state.size[1] / 2)]);

	const jpeg = await optimizeShot(png, { format: "jpeg", scale: 0.3, quality: 70 });
	assert.equal(jpeg.mimeType, "image/jpeg");
	assert.equal(jpeg.data.subarray(0, 2).toString("hex"), "ffd8", "jpeg magic");
	assert.deepEqual([jpeg.width, jpeg.height], [Math.round(state.size[0] * 0.3), Math.round(state.size[1] * 0.3)]);

	const snapshot = await readUi({});
	assert.ok(snapshot.elements.length > 0, "element list is not empty");
	assert.ok(snapshot.elements.some((element) => element.text), "element list has text");

	const first = snapshot.elements[0];
	const target = resolveTarget(1);
	const [left, , right] = first.box;
	const [, top, , bottom] = first.box;
	assert.equal(target.x, Math.round((left + right) / 2));
	assert.equal(target.y, Math.round((top + bottom) / 2));

	// a coordinate read off the image taps the same place as the element list says
	await optimizeShot(png);
	const [imageX, imageY] = deviceToImage(target.x, target.y);
	const back = resolveCoords(imageX, imageY, "image");
	assert.ok(Math.abs(back.x - target.x) <= 1 && Math.abs(back.y - target.y) <= 1, `${back.x},${back.y} ~ ${target.x},${target.y}`);
	assert.match(describeElement(first, 1), new RegExp(`tap=${imageX},${imageY}`), "element list prints image pixels");

	// tap the clock area (harmless) and confirm the element list still reads
	await import("./android.ts").then((ad) => ad.tap(Math.round(state.size[0] / 2), 20));
});
