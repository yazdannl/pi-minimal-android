# pi-android

Pi extension that drives the Android host from inside the Debian chroot on the phone box `agent`.

The calling agent only gets two tools:

```
android_task    delegate a whole task to an isolated Android operator subagent
android_shot    screenshot (so the caller can look before/after delegating)
/vault          the user-facing password vault command
```

The subagent started by `android_task` gets every other tool of this extension and nothing
else:

```
android_ui      list elements: every visible text line with its tap point, plus view ids
android_shot    screenshot as a compressed image (half size, palette PNG by default)
android_act     tap / longpress / swipe / scroll / type / key / launch / stop (single or batched `steps`)
android_close   close an app fully (force-stop, verified), defaulting to the app on screen
android_browse  open a URL in the browser and return the loaded page text
android_read    plain text of the current screen (no coordinates)
vault_list      stored logins: label, site, username (never the password)
vault_generate  create/rotate a login with a generated password (returns metadata only)
vault_fill      type a stored password into the focused field on the phone
vault_remove    delete a stored login
```

## How it works

Everything runs through the chroot bridge: `chroot /proc/1/root /system/bin/<bin>`. The
chroot shell is already `uid=0` in `u:r:magisk:s0`, so no `su` is needed.

- state: `dumpsys window` (`mCurrentFocus`, `mAwake`), `wm size`
- screenshot: `screencap -p /data/local/tmp/pi-android-<pid>-<ts>.png` (unique per call, deleted after reading; kept at full resolution for OCR and shrunk by `optimizeShot` before it reaches the model)
- text: `tesseract --psm 11 tsv` on the screenshot (Debian side), grouped into lines with boxes
- structure: `dumpsys activity <pkg>` prints a live view hierarchy (class, bounds, resource id)
- touch: raw `input_event` records written to the touchscreen node (`/dev/input/eventN`)
- keys/text: `input keyevent`, `input text`
- apps: `cmd package resolve-activity` + `am start -W -n`, `am force-stop`

`uiautomator dump` and every other `app_process` program (ART) segfaults in the magisk
SELinux domain on this device, so the accessibility tree is not available. OCR of the
framebuffer is the text source, and the view hierarchy supplies ids where they exist.

### Why raw touch instead of `input tap`

`input tap|swipe` goes through InputManager, where any window that blocks untrusted touches
(`touchOcclusionMode=BLOCK_UNTRUSTED`, the default for targetSdk 32+ apps such as Firefox)
silently drops the event: the app keeps working for keys, but taps and swipes do nothing.
The extension therefore finds the panel with `getevent -pl` (the device with both
`ABS_MT_POSITION_X/Y` axes), maps screen pixels onto its hardware range, and writes protocol-B
multitouch records directly to the node: down, interpolated moves, release. That is
indistinguishable from a finger and works in every app. If the node cannot be opened, the
gesture falls back to the `input` binary.

## Tools (inside the subagent)

```text
android_ui({ nodes?, max? })
  app=com.android.settings/.SettingsHomepageActivity screen=1440x3200
  [1] tap=182,85 "15:49" #android:id/title android.widget.TextView
  [6] tap=533,762 "Notifications"

android_shot({ scale?, format?, quality?, colors? })   # image content, compressed for the model

android_act({ action: "tap", target: "Notifications" })   # text, index, or "x,y"
android_act({ action: "tap", target: "6" })
android_act({ action: "longpress", target: "6" })
android_act({ action: "scroll", direction: "down" })
android_act({ action: "swipe", x: 700, y: 2000, x2: 700, y2: 900 })
android_act({ action: "type", text: "hello world" })
android_act({ action: "key", key: "back" })
android_act({ action: "launch", app: "dialer" })   # package, unique fragment, or URL
android_act({ action: "stop", app: "com.android.dialer" })

# Batch: the same operations as `steps`, run in order in one call (max 20).
android_act({ steps: [
  { action: "launch", app: "settings", delay: 800 },   # delay = ms to wait after the step
  { action: "tap", target: "Search" },
  { action: "type", text: "battery" },
  { action: "key", key: "enter" },
]})

android_browse({ url: "example.com", maxChars?, timeout? })
  -> focused activity + OCR text of the page, after waiting for the text to settle
android_read({ maxChars? })   # text only, cheap way to read a long page
```

`target` resolves against the last `android_ui` call: a number is an element index, text is a
case-insensitive match that must be unique, `x,y` is raw coordinates.

`android_close({})` closes whatever is in front, which is the cleanup step at the end of a task;
`android_close({ app: "browser" })` closes the current default browser, and any package name or
unambiguous fragment works too. It force-stops the process, verifies with `pidof` that the app is
really gone (and says so when it is not), reports the new foreground app, and refuses to close the
home screen or system UI. `android_act` still has a `stop` action for batched sequences; the rule
is that cleanup is an `android_close` call, not a step in the middle of a flow.

## Delegating: android_task

```text
android_task({ task, timeoutSeconds?, model?, vaultLabels?, allowVaultWrite? })
```

One task per call, phrased as a complete goal: the operator cannot ask questions, so include
the app, the account/label, the expected screen and what to report. The phone keeps its state
between calls, so a follow-up task can continue from the current screen even though each
operator starts fresh.

```text
android_task({ task: "Open Settings > Battery and tell me which apps used the most battery today." })
android_task({ task: "Log in to reddit.com as orca_cad and open the saved posts page.", vaultLabels: ["reddit-orca_cad"] })
android_task({ task: "Search the web for the current Klipper release notes and summarise them.", timeoutSeconds: 300 })
```

The result contains the operator's own report, token/cost usage, a sanitized action log (tool
names and safe fields only) and any side effects it recorded. **It is a report, not proof:** the
caller verifies with `android_shot`, because a normal finish only means the child stopped.

- **Short tasks.** Delegate one goal with a handful of actions at a time: a long flow is
  several tasks, each starting from the screen the previous one left. Inside a task the
  operator is told to batch every action it already knows into one `android_act` call (up to
  20 steps, stopping at the first failure) instead of one call per tap, and to finish in as
  few actions as possible.
- **Isolation.** The child is a separate Pi session with its own system prompt. It gets none of
  the parent's tools, no `AGENTS.md`/project context, no skills, prompt templates, themes or
  other extensions, and its session is in-memory (nothing is written to the session picker).
  It cannot start another android_task. This is context isolation, not a process boundary:
  one process, one device, shared module state.
- **Cancellation.** The timeout (default 600 s, clamped 30-1800) and the parent's abort
  cooperatively cancel the child: actions check the signal between steps, delays and browse
  polling are interruptible, and vault writes check after every await. Ownership of the device
  is only released after the session is confirmed idle; until then other calls fail fast and
  the `android-task-late` entry + the next call's report carry the late outcome.
- **Model.** Defaults to the caller's model but always runs at thinking level `low`: phone
  work is short mechanical sequences, and extra reasoning mostly buys turns and cost (models
  without reasoning support clamp it to `off`, and a model that cannot do `low` shows the
  level it actually used in the result notes). The model must be visible to a fresh Pi
  runtime (built-in providers and `models.json`; provider extensions and request hooks are
  not loaded), authenticated, and ideally image-capable - a text-only model gets screenshots
  as placeholders and works from OCR text. Use `model: "provider/model-id"` to override.
- **Vault.** Fill is denied unless `vaultLabels` names the entry, and generate/rotate/remove
  additionally need `allowVaultWrite: true`. These checks are in code; destination
  authenticity for a fill is **not** verified in code (only the task and the operator's
  instructions guard it), so authorize a label only for a task you trust. No vault tool ever
  returns a password.
- **Cost.** It is a real model session with images in context; keep tasks focused and reuse
  `android_shot` in the parent instead of delegating a "look at the screen" task.

## Coordinates (why taps used to miss)

Agents read coordinates off the image they were given, but that image is downscaled - so
hand-typed device pixels were off by the scale factor (a tap at image 300,450 landed at device
300,450 instead of 600,900). Now there is exactly one coordinate space:

- **image pixels of the last `android_shot`** - the numbers the agent can actually see. Every
  printed coordinate is in this space, and `android_act` x/y plus `swipe` consume it
  (converted to device pixels right before the gesture, via `setShotSpace`/`resolveCoords`).
- `android_ui` states both sizes in its header (`device=1440x3200 image=720x1600 (tap points
  below are image pixels)`) and prints element tap points in image space.
- `android_shot` says `coordinates are pixels OF THIS IMAGE: tap x,y here directly`.
- `space: "device"` opts out when raw framebuffer pixels are really meant; with the default
  `space: "auto"`, a value too large for the image is read as device pixels instead of
  landing off-target, and every action echoes the device pixels it used
  (`coords 300,450 -> device 600,900 [image pixels]`) so a misread is visible immediately.
- Text targets tap the **matched word**, not the line centre: in `"English Deutsch"`,
  `target: "english"` hits the English word instead of the gap between the two links.

The most reliable call is still by index or text - `android_act({action:"tap", target:"3"})`
needs no arithmetic at all; type coordinates only for canvas-like surfaces where OCR finds
nothing.

## Browser notes

The default `VIEW https://` handler is the system-WebView browser (currently FOSS Browser,
`de.baumann.browser`, set via `cmd role add-role-holder android.app.role.BROWSER`).
`android_browse` fires that intent, so it follows whatever browser holds the role; nothing in
the extension hardcodes a package. `android_act({action:"stop", app:"browser"})` resolves the
current default handler and force-stops it.

Why a WebView browser: Fennec/Fennec-Fenix runs Gecko and spawns a content process per tab
(~200 MB each on this box), while a WebView browser keeps every tab in one renderer against
the already-installed `com.android.webview` (measured: 265 MB with one page, 341 MB with
three). Closing tabs and force-stopping the browser when a browsing task ends is still the
cheapest way to give memory back to the box.

## Password vault

`vault.ts` keeps logins (label, site, username, password) in one AES-256-GCM file,
`~/.pi/agent/android-vault.enc`, encrypted with a 32-byte key kept in
`~/.pi/agent/android-vault.key` (both 0600; `PI_VAULT_PATH` / `PI_VAULT_KEY_PATH` override
the paths). There is nothing to unlock: the key is read on demand, so the vault works in
every session and from scripts.

The point is not protecting the file from root - it is keeping secrets out of the places
that leak them: the model context, session transcripts, memory files and backups of text.
So **no tool returns a password.** `vault_list` shows label, site, username and the last
change date; `vault_generate` creates or rotates an entry and reports only its label and
length; `vault_fill` types the secret into the focused field.

```
/vault list            entries, labels and metadata
/vault add one-label   prompts site, username, password (empty = generate one)
/vault show one-label  show the secret to the *user* in the TUI (never to the agent)
/vault remove <label>
```

`vault_fill` stages the value in a 0600 file inside `/data/local/tmp` and lets the device
shell read it, so the plaintext never appears in a process argument list (`ps`), and the
file is removed in every outcome, including failures. Generated passwords draw from a
65-character alphabet (no look-alikes like l/I/1 or O/0, no spaces, nothing `input text`
mangles), are 20 characters by default and 12-64 configurable.

The vault tools live in the android_task subagent, not in the calling agent. Each task gets
its own scope: fills only for the labels in `vaultLabels`, writes only with
`allowVaultWrite: true`; anything else is refused before the vault file is even read
(`vault-ops.ts`). Every vault step re-checks cancellation, so a cancelled task cannot type
a password or persist a rotation. Filling still trusts the operator to check *where* it is
typing: destination authenticity is not verified, so only authorize a label for a task you
trust, and prefer a task that states the expected site or app.

New tools and the `/vault` command appear after the extension reloads (`/reload` or a new
session).

## Limits

- `type` is ASCII only (`input text` cannot send unicode); spaces and `%` are escaped.
- A value containing `%s` cannot be typed: `input text` rewrites it to a space, so it is refused.
- Screen must be awake and unlocked; `android_act({action:"key", key:"wakeup"})` wakes it.
- OCR misses pure icon buttons and misreads low-contrast text; the view ids cover the gap.
- Raw touch needs write access to `/dev/input/eventN` (root, magisk domain is permissive).
- `android_browse` reads the page through OCR: exact wording of small text can be wrong; prefer
  the rendered screenshot when precision matters.

## Screenshot compression

`android_shot` never hands the raw framebuffer to the model. The capture stays full resolution
for OCR, then ImageMagick downscales and re-encodes it (`optimizeShot`):

- default `scale 0.5` + palette PNG (`-colors 128`) - keeps UI text sharp at half the pixels
- `format: "webp"` for the smallest file, `format: "jpeg"` for photos
- `scale: 1` with `format: "jpeg"` when small text must stay legible in the image

Measured on a 1440x3200 screen: raw PNG 363 KB -> default 64 KB (720x1600), scale 1 palette
119 KB, webp 58 KB. Pixel count is what costs image tokens, so the default halves both
dimensions (about 4x fewer tokens) as well as the bytes. The tool reports
`widthxheight format KB (raw KB)` so the agent can see what it got.

## Test

```bash
npm test                                                     # parsers, vault crypto, gate/settle logic, vault-ops, SDK isolation
PI_ANDROID_LIVE=1 node --test android.test.ts                # also screenshots, lists the live screen, finds the touch device
node --test android-task-sdk.test.mjs                        # skips if the installed Pi SDK is not found
```

The SDK test stages a copy of the extension in a temp dir with `node_modules` symlinks, so it
exercises the real `createAgentSession` path: exact parent/child tool sets, no inherited
`AGENTS.md`, and ownership retention while a real session has a tool in flight (including a
rejecting `abort()`).
