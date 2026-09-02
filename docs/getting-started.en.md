# Getting Started

> Goal: start with a computer where `claude` already works, run Claude Chat Mobile, and send the first message from your phone.

[中文](getting-started.md) · [Back to README](../README.en.md)

## What you will have

- A Claude Chat Mobile server running only on your computer.
- A phone entrypoint protected by `AUTH_TOKEN`, a workspace allowlist, and device approval.
- A Web UI that shares configuration, tools, and persisted session history with your local `claude` CLI.

This guide covers a first installation. If the desktop app or a terminal `npm start` is already running, do not start a second server. Restart from the desktop menu, or in the same terminal for headless.

## 1. Check the prerequisites

```bash
node --version
which claude
claude --version
claude auth status
```

You need:

- Node.js 20 or newer.
- A local `claude` command that `which` can find.
- `claude auth status` showing a signed-in account, or a CLI that can start a normal terminal conversation.
- macOS or Linux. Native Windows is experimental; WSL2 is recommended.

The project does not bundle, install, or sign in to Claude for you.

### Claude subscriptions and third-party gateways

- Claude subscription: make sure the local account that will start the server is already signed in to `claude`; no extra API key is needed.
- Third-party gateway: export the required `ANTHROPIC_*` values in the **shell that will start the server**, then start the project.
- Do not put `ANTHROPIC_*` in the project config file. Startup strips those values so a project file cannot override the CLI/provider environment.

## 2. Get the code and install dependencies

```bash
git clone https://github.com/Ike-li/claude-chat-mobile.git
cd claude-chat-mobile
npm install --omit=dev
```

`--omit=dev` installs only runtime dependencies and does not download Playwright browsers. Use a full `npm install` when you need to develop or run tests.

## 3. Create local configuration

### Interactive wizard

Run this in a real terminal:

```bash
npm run setup
```

The wizard:

1. Creates a random `AUTH_TOKEN`, writes it to `ccm.config.json`, and sets mode `0600`.
2. Asks which project folder should open on your phone. It must be an absolute (or `~/`) path; an empty answer or your home directory itself is rejected. After the first one you can keep adding more folders (press Enter to finish) — they are all written to the `WORKDIRS` array, with the first as the default `WORK_DIR`. To add or remove workspaces later, edit `WORKDIRS` in the config; it hot-reloads on save.
3. Asks how your phone will reach this machine (LAN only / Cloudflare / encrypted tunnel VPN / reverse proxy and hosted tunnels / direct public exposure). Press Enter to skip; if you pick one it is stored as `ACCESS_PROFILE`, `doctor` and the phone security check tailor their checks to it, and the wizard ends with the matching docs pointer.
4. Asks whether to enable the phone file editor's direct writes (the only write path that bypasses the Agent tool-approval chain). Enter keeps the default on; answering `n` writes `FILE_EDIT=off`.
5. On macOS, asks whether to compile the [desktop console](#optional-macos-desktop-console). Not compiled by
   default — it needs the Xcode Command Line Tools.
6. Asks whether to install the CLI hooks bridge. Installation is the default, but it writes `~/.claude/settings.json` only after you confirm.

If a config file already exists, the wizard does not overwrite it by default.

### The config file

All configuration lives in `ccm.config.json` at the project root — one JSON file:

```json
{
  "$schemaVersion": 1,
  "AUTH_TOKEN": "…",
  "WORK_DIR": "/Users/you/code/project-a",
  "PORT": 3000,
  "WEB_STATUSLINE": false
}
```

Toggles are real `true` / `false` and ports are numbers — no more `KEY=value` quoting and escaping rules.

Legacy `.env` is still supported: **`ccm.config.json` wins when present, otherwise the loader falls
back to `.env`**, so existing deployments need no changes. (The wizard only generates the new
format; deployments that already have a `.env` keep working, and `node scripts/config.js schema`
lists every setting at any time.)

Environment variables always beat the config file — `PORT=4000 npm start` overrides the file.

Keys the project does not know about **are still passed through** (into `process.env`, which the claude
subprocess inherits) — third-party variables like `HTTPS_PROXY` or `CLAUDE_CONFIG_DIR` work fine here.
Startup logs one line per unregistered key, which also helps you spot a typo in a key name.

### Upgrading from a legacy `.env`

**It runs without migrating.** After pulling new code, your existing `.env` is still read, including
unregistered keys such as `HTTPS_PROXY`. The step below is optional — the new format is simply nicer
to work with.

```bash
npm run config:migrate      # = node scripts/config.js migrate
```

Migration reads the `.env`, inlines an external `workdirs.json` alongside it into `ccm.config.json`,
and **keeps your existing `AUTH_TOKEN`**. The old `.env` is not deleted, but is no longer read (the
new file wins).

> ⚠️ **Do not "upgrade" with `npm run setup --force`.** `--force` is a clean reinstall and mints a
> new `AUTH_TOKEN` — every approved device stops working and each phone has to be approved again.
> When a config already exists, setup refuses and points at `migrate`; do what it says.

On a legacy deployment the desktop console shows a banner and a "Migrate" button at the top of the
config window, so you never have to go back to a terminal.

### Editing config from the command line

With no GUI (server deployments), every setting is readable and writable from the shell:

```bash
node scripts/config.js init              # create the config file (with a random AUTH_TOKEN) without the wizard
node scripts/config.js schema            # list every setting and what it does (generated from the schema)
node scripts/config.js get               # current config (secrets redacted unless --reveal)
node scripts/config.js set PORT=4100 WEB_STATUSLINE=false
node scripts/config.js set 'WORKDIRS=["/path/a","/path/b"]'   # array settings need a JSON literal, not a comma list
node scripts/config.js unset PORT
node scripts/config.js check             # validate the current config
node scripts/config.js migrate           # legacy .env → ccm.config.json (inlines workdirs)
```

`set` reports which changes need a server restart and which are hot-reloaded (effective
immediately). Toggles accept `true/false`, `on/off`, `yes/no`, or `1/0`. Invalid values reject
the whole batch (never a half-written config), using the same validation as the phone settings
panel. Like setup, `init` refuses to overwrite an existing config file unless you pass `--force`.

### Non-interactive mode

A coding agent, CI shell, or any environment without a TTY must be explicit:

```bash
node scripts/setup.js \
  --yes \
  --work-dir=/absolute/path/to/project \
  --hooks=off
```

- `--work-dir` is required and never silently falls back to `$HOME`.
- `--hooks` accepts only `on` or `off`; `on` changes user-level Claude hooks configuration.
- `--desktop` accepts only `on` or `off` and defaults to `off`; `on` runs `swiftc`. On a
  non-macOS host, an explicit `--desktop=on` is rejected with a reason rather than ignored.
- `--access-profile` accepts only `cloudflare` / `vpn` / `reverse-proxy` / `direct` / `lan` and defaults to unset (undeclared; everything falls back to inferring from `CF_ACCESS_*`); invalid values are rejected instead of guessed.
- If a config file exists, the command refuses to overwrite it. Add `--force` only after deciding to replace its current token and configuration.
- Use `--config <path>` to place the config file elsewhere. That path is independent of any existing project-root config — a repo that already has `ccm.config.json` will not block it.

For multiple workspaces, add a `WORKDIRS` array to `ccm.config.json`. Each entry is an absolute path or `{path, sessionLimit}`:

```json
{
  "WORK_DIR": "/Users/you/code/project-a",
  "WORKDIRS": [
    "/Users/you/code/project-a",
    {
      "path": "/Users/you/code/project-b",
      "sessionLimit": 10
    }
  ]
}
```

`WORKDIRS` **hot-reloads** — edits take effect immediately, no restart. Which settings hot-reload is
decided by the `reload` flag in the schema; `node scripts/config.js schema` marks them on each entry
(only `WORKDIRS` when this was written — trust the schema output, not this sentence).
A git worktree must also be listed as its own absolute path; the project never discovers or authorizes it implicitly.

The legacy `WORK_DIRS` (comma-separated) and `WORK_DIRS_FILE=workdirs.json` (external file) still work.
Priority: shell `WORK_DIRS` > shell `WORK_DIRS_FILE` > config-file inline `WORKDIRS`.
When neither env var is set, the config-file `WORKDIRS` is used (the production path).

## 4. Run the preflight checks

```bash
node scripts/doctor.js
```

The doctor checks the token, CLI path, workspaces, port, gateway environment, file permissions, bridge state, and documentation/front-end consistency.
It does not run the unit-test coverage suite by default (that means a full unit run, about a minute); CI guards that threshold, and maintainers can pass `--full` to see it locally.
If it says port 3000 is held by the desktop app, do not run `npm start` next — restart from the desktop menu.

For permission-only repairs:

```bash
node scripts/doctor.js --fix
```

`--fix` tightens permissions on the config file and control-plane JSON files. Read the diagnosis before deciding to use it.

## 5. Start the server

For a first local trial:

```bash
npm start
```

The default port is `3000`. The startup log should show:

- that the server is listening;
- a redacted token status;
- a LAN URL that can be opened on your phone;
- bridge and pending-device status.

The health endpoint requires authentication too (`AUTH_TOKEN` is a startup prerequisite, so the server always has one):

```bash
curl -sS "http://127.0.0.1:3000/health?token=<AUTH_TOKEN>"
```

The server is ready when it returns JSON containing `status`, `versions`, `buildNonce`, and `timestamp`. Treat `AUTH_TOKEN` as a key to your local shell: never paste the real value into issues, chat logs, or screenshots.

If the desktop app or an existing `npm start` already holds port 3000, do not start another. Restart from the desktop menu, or in the same terminal for headless. See the [operations quick reference](deployment.md#运维速查).

## 6. Open it on your phone

### Same Wi-Fi

Open the address printed at startup:

```text
http://<lan-ip>:3000/#token=<AUTH_TOKEN>
```

After the first load, the browser stores the token in `localStorage` and removes it from the address bar.

### Temporary HTTPS

PWA installation and Web Push require HTTPS. For a temporary trial, run this in another terminal:

```bash
cloudflared tunnel --url http://localhost:3000
```

Then open:

```text
https://<random>.trycloudflare.com/#token=<AUTH_TOKEN>
```

A quick tunnel is for testing: its hostname may change on every start and it has no Cloudflare Access layer, so device approval still applies. For a fixed domain and Access 2FA, see the [deployment guide](deployment.md).

## 7. Approve the phone

The first non-local connection waits for device approval. Pick any of four routes:

**Menu bar app (macOS)** — a "🔐 N 台新设备等待批准" entry appears at the top of the menu; expand that row and click "✓ 准入". Each row reads "device type · short ID · source IP", the full ID is in the tooltip, and approving asks for confirmation.

**Another signed-in device** — any already-trusted device shows a pending-device card; tap Approve, no computer needed.

**The headless terminal** — press Enter in the terminal running `npm start` to approve the latest device, or type `deny` to reject it. This one needs a TTY; the launchd-managed server behind the menu bar app has none, so use the routes above there.

**Command line** (works in every mode):

```bash
node scripts/device.js list
node scripts/device.js approve <ID>
```

Check the pending device ID before approving it. The page unlocks immediately afterward; the token does not need to be entered again.

If push is subscribed, a "🔐 新设备请求接入" notification also arrives. It carries no device ID or IP — push is a plaintext channel, so verification always happens inside the app — and repeats at most once per 5 minutes.

To revoke a mistaken approval or a lost device:

```bash
node scripts/device.js deny <ID>
```

Only two things skip device approval: a connection already validated by Cloudflare Access JWT, or a **genuine local connection** — the peer is loopback **and** the Host header is `localhost` / `127.0.0.1` / `::1` (an empty Host does not count).
Requests arriving through cloudflared / nginx / an SSH reverse proxy also have `127.0.0.1` as their peer, but their Host is a public domain, so they **still need approval**. Normal LAN access and temporary quick tunnels do not skip it either. The rule lives in `shouldBypassDeviceApproval` in `src/auth/rate-limiter.js`.

## 8. Complete the first-run check

On the phone, verify:

1. The expected workspace appears on the home screen.
2. A new session can send a harmless prompt such as “Reply with OK only.”
3. The response streams and reaches a finished-turn state.
4. Settings show model, permission mode, effort, and service status.
5. If Web Push is enabled, use “Send a test push” now instead of discovering a broken path during a real approval.

The minimum path is now complete. Both bridges below are optional enhancements and are not required for Web-originated sessions.

## Optional: CLI statusline bridge

Web-driven sessions have an SDK status line out of the box. Install this bridge only if you also want a **read-only view of a terminal-driven session** to show the CLI model, effort, context, cost, and quota.

```bash
npm run statusline:status
npm run statusline:install
```

- `status` is read-only and does not modify `~/.claude`.
- `install` is explicit opt-in and wraps an existing Claude CLI statusline command. The installer refuses when no statusline is configured.
- Reopen the terminal Claude CLI and restart the persistent server after installation.
- `npm run statusline:uninstall` restores the original command from its manifest and refuses to overwrite drifted configuration.

## Optional: CLI hooks bridge

Without hooks, the server still polls the transcript every 2.5 seconds, but terminal Stop / Notification events cannot proactively wake the phone. With the bridge, the CLI writes those events to a private file inbox that the server consumes immediately and routes through notification settings.

```bash
npm run hooks:status
npm run hooks:install
npm run hooks:verify
npm run hooks:uninstall
```

- `status` is read-only.
- `install` appends only its own hook entries, preserves existing hooks, and performs a loopback verification.
- Open a new terminal Claude CLI session after installation; an existing process does not reload hooks.
- If the server is offline, the hook writes its file and exits quietly without blocking the CLI.
- Set `CLI_HOOKS_BRIDGE: false` in the config file to pause server consumption without removing global configuration.

The phone UI can also install or remove the bridge explicitly under Settings → Service status → Terminal session notifications.

## Optional: macOS desktop console

macOS only, and entirely optional — the phone UI and the command line already cover every feature.

The setup wizard offers to compile it; you can also do it yourself at any time:

```bash
npm run app:install    # first build, installed into /Applications — this is the macOS entry
                       # Spotlight / Launchpad / Dock can find it
                       # once installed, upgrades need no terminal: pick 「更新桌面端（重新编译）」 in the menu

# try-run without installing into /Applications:
npm run app:build && open desktop/build/CCM.app
```

**It needs the Xcode Command Line Tools, not the full Xcode** (1–2GB versus 12GB+). Any machine
that has used `git` or `cc` most likely already has them. Otherwise:

```bash
xcode-select --install
```

A menu bar icon shows service status. **The desktop app is self-contained and never opens a
terminal** — installing, diagnosing, reading logs, and editing configuration all happen inside it:

- **「配置…」 (Configure…)**: a form whose contents come from `config.js schema`. It drives the same CLI, so
  **you can still edit configuration while the server is down** — precisely when you most need to.
  Secrets render masked and are not submitted unless changed. On a legacy `.env` deployment, a
  banner with a "Migrate" button appears at the top of the window.
- **「查看日志」 (View logs)**: an embedded scrolling view with a dropdown to switch between the server / tunnel /
  logrotate logs (any `~/Library/Logs/ccm-*.log` shows up as a source), refreshed every 2 seconds,
  reading only the tail of the file (so a multi-hundred-MB log does not freeze it).
- **First-run wizard / doctor / install and uninstall service**: run step by step in an embedded task
  window with live output. A failing step stops there and shows its exit code.
- **「更新桌面端（重新编译）」 (Update desktop app)**: after pulling new code this one item is enough —
  it rebuilds from the current repo, installs into `/Applications`, and relaunches into the new build.
  The dimmed line above it is this app's identity (version · build time · git commit · install path):
  two bundles share a version number, so the last two segments are what tell them apart.
  **「重启应用」 (Relaunch)** next to it only relaunches without rebuilding — for when the app itself
  misbehaves.

**「打开控制台…」 (Open Console…)** in the menu is the main window: service status, individual units,
and every action on one screen.

Checking 「开机自启（菜单栏）」 (Start at login) only brings the menu-bar icon back at login (via a LaunchAgent).
Headless keeps using `npm start` in a terminal. Do not let both occupy port 3000.

### Why there is no prebuilt app to download

An app you compile yourself carries **no quarantine attribute** and opens on a double-click. An app
downloaded from a web page always gets one, and the first launch hits Gatekeeper's "cannot verify the
developer". Fixing that properly means an Apple Developer account for notarization ($99/year), which
is out of proportion for a self-hosted tool. Telling you to `xattr -d` around it would be telling you
to disable a security mechanism.

Compiling also has a side benefit: the binary matches exactly the source you are holding, and you do
not have to trust anyone else's build.

### When the notch hides the menu bar icon

The MacBook Pro notch squeezes out menu bar icons on the right. This app has no Dock icon and does not
appear in Cmd+Tab by default, so once the icon is pushed out there is **no entry point left** (running
`open CCM.app` again only activates the instance that is already running).

The console window has a "Show icon in Dock" toggle. With it on, a Dock icon appears and clicking it
brings the console back. **Turn it on while you can still find the icon.**

If the icon is already gone, recover once from the command line and reopen the app:

```bash
defaults write com.ccm.menubar CCMShowDockIcon -bool true
```

<details>
<summary>Delegate first installation to a coding agent</summary>

Give the following prompt to Claude Code, Codex CLI, or another local coding agent from the repository directory:

```text
Install and start claude-chat-mobile for the first time. It connects my local claude CLI to a phone Web UI.
This is a clean first installation, not a restart of a desktop app or npm start that is already running.

Follow these steps in order and verify each result before continuing:
1. Check that node --version is at least 20, which claude finds the command, and claude auth status shows a login.
   Stop and tell me if any check fails; do not install or sign in to claude yourself.
2. Run npm install --omit=dev.
3. Ask me for the absolute WORK_DIR and whether to install the CLI hooks bridge.
   Do not use my whole home directory. hooks=on changes ~/.claude/settings.json.
4. Your shell has no TTY, so do not run the interactive wizard. First unset AUTH_TOKEN WORK_DIR PORT
   CCM_DATA_DIR WORK_DIRS WORK_DIRS_FILE CF_ACCESS_HOSTNAME CF_ACCESS_TEAM CF_ACCESS_AUD LOG_TERMINAL
   so inherited values cannot override the file you are about to write. Then:
   node scripts/setup.js --yes --work-dir=<confirmed absolute path> --hooks=<on or off>
   If a config file already exists, stop instead of adding --force yourself.
5. Run node scripts/doctor.js. Use --fix only when its output calls for a safe permission repair. Do not pass --full unless I ask.
6. Confirm port 3000 is not held by the desktop app or another npm start, then start with `npm start` (headless).
   Verify authenticated /health JSON; do not rely only on the process existing.
7. Give me the LAN phone URL from startup logs, but never write AUTH_TOKEN into any file or report that may leave
   this machine.
8. After my phone connects, run node scripts/device.js list. Let me verify the device before running approve.
Public access is in docs/deployment.md. The only start entries are npm start or the macOS desktop app. Do not change system services on your own.
```

</details>

## Uninstall

```bash
npm run uninstall -- --dry-run   # preview every action without touching anything
npm run uninstall -- --yes       # remove the install surface: managed launchd units, any leftover menu bar app process, CCM.app, defaults domain, both CLI bridges and ~/.claude/ccm
npm run uninstall -- --purge --yes  # additionally delete the data dir (known files only), ccm.config.json/.env, managed-unit logs
```

It only removes what this product installed or produced: launchd units outside the service
manifest (for example a hand-installed cloudflared tunnel), `~/.claude/projects`, `~/.cloudflared`,
and anything in settings.json beyond the two bridge entries are never touched. Per-workdir
`.ccm-uploads/` is reported but never deleted (attachment previews in old transcripts read from it).
Unrecognized files in the data dir (manual backups etc.) are kept and listed. Browser/phone-side
site data and the installed PWA must be cleared manually.

## Troubleshooting

| Symptom | Check |
|---|---|
| The server refuses to start, saying `AUTH_TOKEN` is missing | The token is a startup prerequisite; it no longer degrades to a loopback bind. Run `npm run setup` to generate one, then restart |
| Startup logs list only the local URL, no phone URL | `BIND_MODE=loopback` binds `127.0.0.1` only, so nothing is listening on those LAN addresses. Switch back to the default or `lan` for direct phone access |
| An agent ran setup but wrote nothing | Interactive mode was used without a TTY; setup now refuses. Use `--yes --work-dir=... --hooks=...` |
| doctor / the server reads the old config | Inherited `AUTH_TOKEN` / `WORK_DIR` / `CF_ACCESS_*` in the current shell override the file; `unset` them first |
| `EADDRINUSE :3000` | The desktop app or another npm start owns the port; do not blindly start another |
| The phone stays on device approval | Run `device.js list`, verify the ID, and approve the correct device |
| After one wrong token, even the correct one returns `{"status":"rate_limited"}` / HTTP 429 | Brute-force backoff is working, not a broken server. The first failure arms a 0.5s lock, then backs off exponentially (1s → 2s → 4s…). **Wait a few seconds and retry** — a correct token recovers on its own; hammering keeps you inside the lock. The 15-minute lockout needs 8 consecutive failures that each wait out the backoff |
| You typed the token correctly but rate limiting still blocks you | Limiting buckets by source, and failures inside one bucket add up. **IPv6 clients are bucketed by /64**, so another device on your subnet typing it wrong will affect you; behind a reverse proxy terminating on loopback, all public clients share a single bucket (see the [deployment guide](deployment.md#换掉入口后ccm-侧的四处连带变化)). Wait out the lockout window, or restart the server to clear it immediately |
| A third-party gateway is ignored | `ANTHROPIC_*` must come from the server's startup shell, not the config file |
| CLI session status or notifications are missing | Check the statusline and hooks bridges separately; they solve different problems |
| Android installs only a browser shortcut | Cloudflare Access may block PWA icons; see the [deployment guide](deployment.md#2b-android-pwa图标必须对匿名可达) |
| Startup logs "read as number/boolean" conversion notes | `ccm.config.json` has numbers or toggles written as strings; use `3000` / `true`, not `"3000"` / `"true"` |
| The desktop menu bar icon is gone | The notch pushed it out; see [the section above](#when-the-notch-hides-the-menu-bar-icon) for the one-line `defaults write` recovery |

## Next steps

- Long-term public access: [Deployment and operations](deployment.md) (Chinese)
- Understand the Web/CLI paths: [Architecture](architecture.en.md)
- Understand model, effort, and statusline sources: [Display contracts](display-contracts.md) (Chinese)
- Maintainers — n=1 hard rules and the technical-debt index: [hard-rules.md](hard-rules.md) (Chinese)
- Review every setting and what it does: `node scripts/config.js schema` (generated from the schema, never drifts from the code)
