# Getting Started

> Goal: prepare your computer, install Claude Chat Mobile, and send the first message from your phone.

[中文](getting-started.md) · [Back to README](../README.en.md)

> **Scope**: this English guide covers the essential install path only. Some optional topics
> are documented in Chinese only — most notably **Web Push setup** (VAPID keys, and the ntfy
> alternative for networks where Google's push infrastructure is unreachable). For those, see
> [首次使用指南](getting-started.md), which is the authoritative and complete version.
>
> The rule for what may be left out: **anything that can make a configuration fail silently, or
> mislead a security decision, must be translated; setup steps for purely optional features may
> point at the Chinese version.**

## What you will have

- A Claude Chat Mobile server running only on your computer.
- A phone entrypoint protected by `AUTH_TOKEN`, connected project folders, and device approval.
- A Web UI that shares configuration, tools, and session history saved on your computer with your local `claude` CLI.

Follow steps 1–8 for a first installation; notifications, terminal sync, and the desktop console are optional. Run commands on your computer, and use the project directory from step 3 onward.

For public access, continue with [Cloudflare setup from account registration onward](deployment.md#从零搭建) (Chinese). To delegate installation, use the [coding-agent prompt](#delegate-installation-to-a-model).

For a free domain, follow [registration and Cloudflare DNS setup](cloudflare-free-domain.md) (Chinese), then continue with the deployment guide.

On macOS, run commands in Terminal. Replace `<…>` placeholders before running a command. Resolve an error in the current step before moving on.

If CCM is already running, restart it through its existing entrypoint: the desktop server menu, or the terminal that started it.

## 1. Check the prerequisites

Install any missing tools first; skip tools that already work.

| Tool | First installation | Check |
|---|---|---|
| Node.js, including npm | Open [Node.js downloads](https://nodejs.org/en/download), select the current LTS and your OS. On macOS, open the `.pkg` installer and follow its prompts; on Linux, follow the page's instructions | In a new terminal, `node --version` is at least 20 and `npm --version` prints a version |
| Claude Code CLI | Follow the [official terminal installation guide](https://code.claude.com/docs/en/setup#install-claude-code). On macOS / Linux, you can run the command below | In a new terminal, `claude --version` prints a version |

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

Run `claude`. Subscription users complete the browser sign-in; API key / gateway users configure their provider as described below. Complete one normal conversation in the project folder you intend to connect, then continue here. Installing CCM does not provide a model account, subscription, or API credit.

If a new terminal still reports `claude: command not found`, follow the official [PATH checks](https://code.claude.com/docs/en/troubleshoot-install#verify-your-path) before installing CCM.

Confirm the prerequisites:

```bash
node --version
which claude
claude --version
```

You need:

- Node.js 20 or newer.
- A local `claude` command that `which` can find.
- Claude subscription users: `claude auth status` shows a signed-in account.
- API key or third-party gateway users: `claude` can complete a conversation in the target project. A subscription login is not required.
- macOS or Linux. Native Windows is experimental; WSL2 is recommended.

The CCM setup wizard configures CCM only. Install Node and Claude and complete account sign-in first.

### Claude subscriptions and third-party gateways

For a Claude subscription, sign in to `claude` on this computer; no extra API key is needed. API keys and gateways are configured in the Claude CLI. CCM loads its settings for the target project.

Put gateway variables in the `env` block of either file:

- `.claude/settings.local.json` in the project: applies to that project; make sure it is in `.gitignore`.
- `~/.claude/settings.json`: defaults for all projects.

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://gw.example.com",
    "ANTHROPIC_AUTH_TOKEN": "…",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "<model supported by your gateway>",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "<model supported by your gateway>"
  }
}
```

Start `claude` in the target project and accept the directory trust prompt. File-based settings also work with the macOS background service.

Alternatively, `export ANTHROPIC_…` and run `npm start` in the **same terminal**. The desktop service does not inherit variables exported in another terminal. If both are configured, gateway values from CLI settings take precedence.

**Do not put `ANTHROPIC_*` in `ccm.config.json` or `.env`**: CCM ignores them and logs a notice. For a worktree, use its own `.claude/settings.local.json` or the user-level settings file; CCM excludes gateway values found only in the main checkout.

On the phone, Settings & status → Diagnostics → Security check includes `MODEL_SETTINGS`. It checks configuration consistency, not whether the gateway supports a model. Verify that with an actual reply.

## 2. Get the code and install dependencies

There are two ways to get the code; pick one.

### Option A: source archive (you just want to run it)

```bash
curl -fsSL -o ccm-master.tar.gz https://github.com/Ike-li/claude-chat-mobile/archive/refs/heads/master.tar.gz \
  && tar xzf ccm-master.tar.gz \
  && cd claude-chat-mobile-master \
  && npm ci --omit=dev
```

Extraction and installation run only after a successful download. `master` tracks the latest release. To select a version, use `/archive/refs/tags/vX.Y.Z.tar.gz` and enter the matching `claude-chat-mobile-X.Y.Z` directory.

The archive includes runtime and setup tools, but no tests. Choose option B to change code or run checks.

### Option B: full repository (you want to change code or run tests)

```bash
git clone https://github.com/Ike-li/claude-chat-mobile.git
cd claude-chat-mobile
npm ci --omit=dev
```

Both paths use `npm ci --omit=dev`: it reproduces the dependency tree from `package-lock.json` exactly without rewriting the lock, and installs only runtime dependencies, so no Playwright browsers are downloaded. To run the tests in the full repository, run `npm ci` once more without that flag.

## 3. Create local configuration

### Interactive wizard

Run this in a real terminal:

```bash
npm run setup
```

The wizard:

1. Creates a random `AUTH_TOKEN`, writes it to `ccm.config.json`, and sets mode `0600`.
2. Asks which project folder should open on your phone. Give an absolute (or `~/`) path; your home directory itself is rejected. **Press Enter to skip** — it works with no folders connected at all; pick one from your phone when you start a session, or just use "No folder". After the first one you can keep adding more folders (press Enter to finish) — they are all written to the `WORKDIRS` array, and **the first entry is the one your phone opens by default**. To add or remove workspaces later, edit `WORKDIRS` in the config; it hot-reloads on save.
3. Asks how your phone will reach this machine (LAN only / Cloudflare / encrypted tunnel VPN / reverse proxy and hosted tunnels / direct public exposure). Press Enter to skip; if you pick one it is stored as `ACCESS_PROFILE`, `doctor` and the phone security check tailor their checks to it, and the wizard ends with the matching docs pointer.
4. Asks whether to enable the phone file editor's direct writes (the only write path that bypasses the Agent tool-approval chain). Enter keeps the default on; answering `n` writes `FILE_EDIT=off`.
5. On macOS, asks whether to compile the [desktop console](#optional-macos-desktop-console). Not compiled by
   default — it needs the Xcode Command Line Tools.
6. Asks whether to install the CLI hooks bridge. Installation is the default, but it writes `~/.claude/settings.json` only after you confirm.

If a config file already exists, the wizard does not overwrite it by default.

**Choosing Cloudflare only records the access profile.** The wizard does not create a tunnel, DNS record, or Access application, and does not fill in `CF_ACCESS_HOSTNAME/TEAM/AUD`. Complete the local startup and health check first, then follow the [deployment guide's installation sequence](deployment.md).

### Pin the Claude CLI path

In the project directory, from a terminal where `claude` works, run:

```bash
node scripts/config.js set CLAUDE_BIN="$(command -v claude)"
```

This saves the CLI's absolute path. A successful `which claude` in your terminal does not guarantee that a macOS background service can find it. The service uses `zsh -lc`, which reads `.zprofile` but not `.zshrc`; adding `~/.local/bin` only to `.zshrc` can cause this difference. If the CLI moves, update this setting and restart the server.

### The config file

Configuration lives in `ccm.config.json` at the project root. This is a format example: keep the generated token and use your own directory path.

```json
{
  "$schemaVersion": 1,
  "AUTH_TOKEN": "…",
  "WORKDIRS": ["/Users/you/code/project-a"],
  "PORT": 3000
}
```

Toggles are real `true` / `false` and ports are numbers — no more `KEY=value` quoting and escaping rules.

<details>
<summary>More configuration: manual edits, multiple folders, and legacy migration</summary>

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

> **Upgrade with `npm run config:migrate`; do not overwrite the configuration by rerunning setup.** Overwriting creates a new `AUTH_TOKEN`, requiring devices to sign in and be approved again. Interactive setup asks before overwriting; non-interactive setup requires `--force`.

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

- `--work-dir` is optional: leave it out and no folder is connected (pick one from your phone when you start a session); if given, it must be an absolute path and not your home directory itself. It never falls back to `$HOME`, and an explicitly empty value (`--work-dir=`, usually an unexpanded variable) is rejected.
- `--hooks` accepts only `on` or `off`; `on` changes user-level Claude hooks configuration.
- `--desktop` accepts only `on` or `off` and defaults to `off`; `on` runs `swiftc`. On a
  non-macOS host, an explicit `--desktop=on` is rejected with a reason rather than ignored.
- `--access-profile` accepts only `cloudflare` / `vpn` / `reverse-proxy` / `direct` / `lan` and defaults to unset (undeclared; everything falls back to inferring from `CF_ACCESS_*`); invalid values are rejected instead of guessed.
- If a config file exists, the command refuses to overwrite it. Add `--force` only after deciding to replace its current token and configuration.
- Use `--config <path>` to place the config file elsewhere. That path is independent of any existing project-root config — a repo that already has `ccm.config.json` will not block it.

For multiple workspaces, add a `WORKDIRS` array to `ccm.config.json`. Each entry is an absolute path or `{path, sessionLimit}`. **The first entry is the one your phone opens by default** (before 2026-09-08 a separate `WORK_DIR` key held the same path; it has been merged — an old config's `WORK_DIR` line is still recognised, folded into the first slot, and reported as safe to delete):

```json
{
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

`WORKDIRS` is your list of **connected folders**, with the same meaning as the folder list the Claude desktop app opens up to your phone:

- **Subfolders just work**: once `~/code` is connected, a session in `~/code/app` needs no separate entry; each subfolder that has sessions gets its own section in the drawer. When connected folders nest, the deepest one owns the path.
- **git worktrees follow their repository**: worktrees inside a connected repository (such as the managed ones under `.claude/worktrees/`) are usable, and their sessions are folded into the repository's list. Sibling worktrees outside the repository (`../repo-<branch>`) don't follow it — as in the official desktop app, such a worktree is just another folder: connect it on its own ("+ Choose a folder" on the phone works) and it gets its own section. If its parent folder is connected, it is already in scope and still folds into the repository. Ownership is verified from the repository's side in both directions (the worktree's `.git` pointer and the repository's back-link must agree), and git is never executed to decide it.
- **Can't be connected**: your home folder itself and the disk root (the config file rejects them too). `~/.claude` and this app's own data directory can't be added from the phone, and connecting a parent (say `~/code`, with this app inside it) doesn't turn them into session directories — unless you list them in `WORKDIRS` explicitly in the config file. A worktree under a repository's `.claude/worktrees/` can't be added on its own; add the repository it belongs to.
- **Pick and disconnect folders from the phone**: tap the folder chip on the new-session page, or "＋ Choose a folder" at the top of the drawer — it browses folder names inside your home folder only, and greys out the ones that can't be added with the reason. "Start a session here" connects the folder first (one that is already connected isn't added twice), and a folder you create there is connected and opened right away. The "⋯" next to a connected folder in the drawer disconnects it: it just stops showing up and you can't start new sessions in it — its files and session history stay untouched, and sessions already open keep running. Adding and disconnecting both write back into `WORKDIRS` in the config file and take effect immediately. Two cases can't be changed from the phone: the folder list comes from environment variables (the two legacy keys below), or there is no `ccm.config.json` (legacy `.env` only) — run `npm run config:migrate` on the computer to create one (it keeps your token; see [Upgrading from a legacy `.env`](#upgrading-from-a-legacy-env)).
- **No folder**: a new session can also live outside every folder, in a throwaway directory the app creates (on macOS under `~/Library/Application Support/claude-chat-mobile/scratch-workspaces`, on Linux under `${XDG_DATA_HOME:-~/.local/share}/claude-chat-mobile/scratch-workspaces`). It is created when the first message is sent and deleted together with the session (kept if other sessions still use it).

The legacy `WORK_DIRS` (comma-separated) and `WORK_DIRS_FILE=workdirs.json` (external file) still work.
Priority: shell `WORK_DIRS` > shell `WORK_DIRS_FILE` > config-file inline `WORKDIRS`.
When neither env var is set, the config-file `WORKDIRS` is used (the production path).

</details>

## 4. Run the preflight checks

```bash
node scripts/doctor.js
```

The check covers the token, Claude path, project folders, port, and configuration permissions. Resolve failed checks first; unconfigured optional features can wait.
If you selected Cloudflare before configuring public access, the `ACCESS_PROFILE` warning about incomplete `CF_ACCESS_*` is a pending setup step. Continue with local startup and health checks, then complete the deployment guide and resolve this warning before public-access acceptance.
If it says port 3000 is held by the desktop app, do not run `npm start` next — restart from the desktop menu.

For permission-only repairs:

```bash
node scripts/doctor.js --fix
```

`--fix` tightens permissions on the config file and control-plane JSON files. Read the diagnosis before deciding to use it.

## 5. Start the server

Start the server from the project directory and leave this terminal open:

```bash
npm start
```

The default port is `3000`. The startup log should show:

- that the server is listening;
- a redacted token status;
- a LAN URL that can be opened on your phone;
- bridge and pending-device status.

**Open another terminal and enter the same project directory**, then check the server:

```bash
node scripts/service.js health --json
```

The command reads the token from local configuration and sends an authenticated request to `/health`. The server is ready when it returns `ok: true`, `health.status: "ok"`, and server, SDK, and CLI versions in `health.versions`. Treat `AUTH_TOKEN` as a key to your local shell: never paste the real value into issues, chat logs, or screenshots.

If the desktop app or an existing `npm start` already holds port 3000, do not start another. Restart from the desktop menu, or in the same terminal for headless. See the [operations quick reference](deployment.md#运维速查).

## 6. Open it on your phone

### Same Wi-Fi

Generate a QR code in the project directory on your computer, then scan it with a phone on the same Wi-Fi:

```bash
node scripts/qr.js
```

The code needs a terminal about 90 columns by 45 rows; enlarge the window if needed.

For manual entry, view the token locally with `node scripts/config.js get AUTH_TOKEN --reveal` and fill in the address below. Use the LAN IP from the startup log; a redacted token will not work.

```text
http://<lan-ip>:3000/#token=<AUTH_TOKEN>
```

The browser saves the token and removes it from the address bar after login. **The QR code and full address contain your access token: do not share them or display them during screen sharing.**

### Temporary HTTPS

PWA installation and Web Push require HTTPS. For a temporary trial, run this in another terminal:

```bash
cloudflared tunnel --url http://localhost:3000
```

Then open:

```text
https://<random>.trycloudflare.com/#token=<AUTH_TOKEN>
```

A quick tunnel is for testing: its hostname may change on every start and it has no Cloudflare Access layer, so device approval still applies. For a fixed domain and the Access layer, see the [deployment guide](deployment.md) (Chinese) — if you do not yet have a Cloudflare account or a domain, start from [prerequisites](deployment.md#0-前置条件-cf-账号与域名), which also covers getting a free domain; to keep traffic off Cloudflare, see the next section.

### Tailscale (the recommended path off Cloudflare)

If you would rather not route traffic through Cloudflare or buy a domain, Tailscale is an option. Follow the [official quickstart](https://tailscale.com/docs/how-to/quickstart) to create an account and sign in on your computer and phone, then run on your computer:

```bash
tailscale serve --bg 3000
```

Then open `https://<machine>.<tailnet>.ts.net/#token=<AUTH_TOKEN>` on your phone (the TAILSCALE line of `node scripts/doctor.js` prints the exact address).
Tailscale issues the HTTPS certificate for you, so PWA installation and Web Push both work; only devices in your tailnet can reach it, and device approval still applies.
Full steps and the "do not turn on Funnel by accident" note are in the [deployment guide](deployment.md) (Chinese), section "Tailscale 五分钟配方".

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

By default, direct local connections and connections verified by Cloudflare Access skip device approval. LAN phones and quick tunnels normally require it. With `DEVICE_APPROVAL_SCOPE=all`, every connection requires approval.

Local detection checks both the source address and Host header. See the [deployment guide](deployment.md#架构) for SSH/frp TCP forwarding, and `shouldBypassDeviceApproval` in `app/src/auth/rate-limiter.js` for the implementation.

## 8. Complete the first-run check

For a fixed domain using Cloudflare, first complete the deployment guide's [layer-by-layer checks](deployment.md#3b-逐层验收): **local health → tunnel routing → Access login → live connection**. A healthy tunnel or an Access login page is insufficient: after signing in, CCM must load and establish its live connection.

Opening CCM proves connectivity. **Complete installation by receiving a model reply:**

1. Pick the target project folder, or use “No folder”.
2. Start a session and send “Reply with OK only.” Confirm that the reply streams and the turn finishes.
3. For `Not logged in · Please run /login`, sign in to Claude on the computer. For gateway 401, connection, or unknown-model errors, check the [CLI gateway settings](#claude-subscriptions-and-third-party-gateways). Get `claude` working in the same project directory, then retry on the phone.
4. Check model, permissions, and effort below the composer. If Web Push is configured, send a test notification too.

A CLI error proves that the request reached the CLI, **but installation is not verified until the error is resolved and a normal reply arrives**. Service details are under Settings & status → Host → Service status.

The features below are optional for Web-originated sessions.

## Optional: phone notifications

For Web Push setup, platform requirements, and ntfy, see the [Chinese guide](getting-started.md#可选手机推送通知).

## Optional: CLI statusline bridge

Web-driven sessions have an SDK status line out of the box. Install this bridge only if you also want a **read-only view of a terminal-driven session** to show the CLI model, effort, context, cost, and quota.

```bash
npm run statusline:status
npm run statusline:install
```

- `status` is read-only and does not modify `~/.claude`.
- Run `install` to enable the bridge. It wraps an existing Claude CLI statusline command. The installer refuses when no statusline is configured.
- Reopen the terminal Claude CLI and restart the persistent server after installation.
- `npm run statusline:uninstall` restores the original command from its manifest and refuses to overwrite drifted configuration. It also removes `~/.claude/ccm/statusline-v1` (including snapshots), and `~/.claude/ccm` itself once it is empty.

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
- `uninstall` removes its own hook entries per the manifest and deletes `~/.claude/ccm/hooks-v1` (the inbox and receipts), plus `~/.claude/ccm` once it is empty. Neither install nor uninstall needs a server restart.

The phone UI can also install or remove the bridge explicitly under Settings → 🖥 Host → Terminal session
alerts — a sibling of the "📊 Service status" button on that page, **not** something inside the service status panel.

## Optional: macOS desktop console

macOS only, and entirely optional — the phone UI and the command line already cover every feature.

Run `xcode-select -p` to check the build tools first. If they are missing, run the command below and finish installation in the system dialog before continuing. You need Xcode Command Line Tools; the full Xcode app is unnecessary. See [Apple's installation instructions](https://developer.apple.com/documentation/xcode/installing-the-command-line-tools/).

```bash
xcode-select --install
```

Install the desktop console:

```bash
npm run app:install    # first build, installed into /Applications — this is the macOS entry
                       # Spotlight / Launchpad / Dock can find it
                       # once installed, upgrades need no terminal: pick 「更新桌面端（重新编译）」 in the menu

# try-run without installing into /Applications:
npm run app:build && open desktop/build/CCM.app
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

### When the desktop app misbehaves, the terminal is the way out

The desktop app is a GUI process, and it has a class of failures the command line structurally cannot
hit — a window sinking behind another one so you cannot click it, the notch squeezing the menu bar icon
out, or a GUI process inheriting a different `PATH` than your terminal. The first two may affect only
the console; a PATH difference can also prevent the server from finding Claude and starting. Check the
service itself before drawing a conclusion from the menu-bar icon.

So when a menu item "does nothing", check the service itself from a terminal first. Neither of these
goes through the app:

```bash
npm run service:status     # real run state of each unit (the menu bar reads this too)
node scripts/doctor.js     # startup self-check
```

If the service is healthy, the problem is in the app layer: **「重启应用」 (Relaunch)** in the menu
(relaunch without rebuilding) usually clears it; if the icon is gone entirely, see
[the section below](#when-the-notch-hides-the-menu-bar-icon).

**The desktop app holds no exclusive capability** — it drives the same CLIs under `scripts/`
(`service.js` / `doctor.js` / `config.js`), so you can always bypass it and run them directly instead
of waiting for the app to recover.

### Why there is no prebuilt app to download

Building locally keeps the app aligned with your source version and avoids the quarantine attribute applied to downloaded apps. The project does not currently provide an Apple-notarized prebuilt installer.

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

## Delegate installation to a model

The model needs tools to read and write project files and run commands on this computer. A chat-only model can provide instructions. You complete account sign-in, verification codes, and payment details.

Give a local coding agent the project directory and the prompt below. The source archive includes this guide too; the agent need not rely on finding `AGENTS.md`. For public access, continue with the [Cloudflare prompt](deployment.md#把-cloudflare-配置交给模型) (Chinese).

<details>
<summary>Copy the local first-install prompt</summary>

```text
Install and start claude-chat-mobile for the first time. It connects my local claude CLI to a phone Web UI.
This is a clean first installation, not a restart of a desktop app or npm start that is already running.

Follow these steps in order and verify each result before continuing:
1. Check node --version is at least 20 and which claude finds the command. For a subscription, check claude auth status.
   For an API key or gateway, check the existing CLI configuration; a subscription login is not required.
   For missing tools, help install them using docs/getting-started.en.md §1. Give concrete steps for user sign-in
   or system authorization, then continue when completed. Do not reinstall tools that already work.
2. Run npm ci --omit=dev.
3. Ask me whether to connect a project folder now (if so, confirm its absolute path; skipping is fine,
   I can pick one from my phone later) and whether to install the CLI hooks bridge.
   Do not use my whole home directory. hooks=on changes ~/.claude/settings.json.
4. Your shell has no TTY, so do not run the interactive wizard. First unset AUTH_TOKEN WORK_DIR WORK_DIRS PORT
   CCM_DATA_DIR WORK_DIRS_FILE CF_ACCESS_HOSTNAME CF_ACCESS_TEAM CF_ACCESS_AUD LOG_TERMINAL
   so inherited values cannot override the file you are about to write. Then:
   node scripts/setup.js --yes --work-dir=<confirmed absolute path> --hooks=<on or off>
   (Drop --work-dir if no folder is being connected.) If a config file already exists, stop instead of adding --force yourself.
5. Save the CLI path with node scripts/config.js set CLAUDE_BIN="$(command -v claude)".
   Run node scripts/doctor.js. Use --fix only for a reported permission repair.
6. Confirm port 3000 is not held by the desktop app or another npm start, then start with `npm start` (headless).
   In another terminal, enter the same project directory and run node scripts/service.js health --json.
7. Give me the LAN phone URL from startup logs, but never write AUTH_TOKEN into any file or report that may leave
   this machine.
8. After my phone connects, run node scripts/device.js list. Let me verify the device before running approve.
Public access is in docs/deployment.md. The only start entries are npm start or the macOS desktop app. Do not change system services on your own.
```

</details>

## Command reference

Everything you will reach for after installation. **Every CLI prints its own usage when run without a
subcommand**, and those printouts are the authority on flags — this reference lists names and purposes
only, never a second copy of the flags (a second copy drifts from the code):

```bash
node scripts/config.js       # prints usage when given no subcommand; same for the next three
node scripts/device.js
node scripts/service.js
node scripts/qr.js --help
npm run setup -- --help
```

> What `npm run` lists is **not** the full set: `service.js` has `start` / `stop` / `copy-token`
> subcommands with no npm alias — reach them with `node scripts/service.js <subcommand>`.

### Starting and configuring

| Command | Purpose |
|---|---|
| `npm start` | Start the server (port 3000 by default) |
| `npm run dev` | Same, restarting on source changes |
| `npm run setup` | Interactive setup wizard |
| `node scripts/config.js schema` | **List every setting and what it does**, generated from the schema so it never drifts |
| `node scripts/config.js get\|set\|unset` | Read and write individual settings; secrets need an explicit `--reveal` to print |
| `npm run config:check` | Validate the current configuration |
| `npm run config:migrate` | Legacy `.env` → `ccm.config.json` |
| `node scripts/doctor.js` | Preflight self-check. `--fix` tightens config file permissions to 0600; `--env=<file>` diagnoses that specific file |
| `node scripts/perf-report.js` | Summarise the phone performance records reported into the server log (startup, opening a session, returning to foreground, dropped frames, tap latency) as n·p50·p90·max per device / network / cache; `--since 7d` limits the window. Read-only |

### Devices and connecting

| Command | Purpose |
|---|---|
| `node scripts/device.js list` | List pending and trusted devices (`--json` for machine output) |
| `node scripts/device.js approve\|deny <ID>` | Approve or reject a device |
| `node scripts/qr.js` | Render the address + token as a terminal QR code, so you do not type 64 hex characters |
| `node scripts/service.js copy-token` | Copy the token to the clipboard **without printing it** |

> Both of the last two move the token out of the config file — run them when you need them, and keep
> them out of scripts and logs. `qr.js --public` resolves your public address; a hostname behind
> Cloudflare Access **carries no token** (that path only accepts a JWT).

### The two CLI bridges (optional, they write to `~/.claude`)

| Command | Purpose |
|---|---|
| `npm run statusline:install\|status\|uninstall` | Terminal session status bridge |
| `npm run hooks:install\|status\|verify\|uninstall` | Terminal session notification bridge |

They serve different purposes — see [their two sections above](#optional-cli-statusline-bridge).

### macOS desktop app and managed services

| Command | Purpose |
|---|---|
| `npm run app:install` / `npm run app:build` | Build and install into `/Applications` / build only into `desktop/build/` |
| `npm run service:status` | Run state and ownership of each unit (`--json` is what the menu bar reads) |
| `npm run service:health` | The only command that hits `/health` |
| `npm run service:install\|restart\|logs\|uninstall` | Managed service operations |
| `npm run service:adopt` | Adopt a hand-installed unit — writes the manifest only, never touches the plist |
| `node scripts/service.js start\|stop <unit>` | Start or stop a single unit (no npm alias) |

You rarely need to type these — the desktop menu covers them. They are the same CLI the menu drives,
which is what makes them usable when the app itself is stuck.

### Updating and uninstalling

See the [Updating](#updating) and [Uninstall](#uninstall) sections below.

> **These only work in a full repository**: `npm test`, `npm run check`, `npm run lint`, and every
> `test:*` / `playground:*` / `mutate*`. They reference the test tree and the gates, which the source
> archive strips out (why: [Option A](#option-a-source-archive-you-just-want-to-run-it); to run them,
> use [Option B](#option-b-full-repository-you-want-to-change-code-or-run-tests)).

## Updating

**Update it the same way you got it** — whichever option you picked in step 2 is the one to follow here.

### Option A: overwrite in place (installed from the archive)

Go back to the directory you originally unpacked into (the parent of `claude-chat-mobile-master/`), download the archive to a file first, and only unpack it once the download has succeeded:

```bash
curl -fsSL -o ccm-master.tar.gz https://github.com/Ike-li/claude-chat-mobile/archive/refs/heads/master.tar.gz \
  && tar xzf ccm-master.tar.gz && rm ccm-master.tar.gz
cd claude-chat-mobile-master
npm ci --omit=dev
node -p "require('./package.json').version"
```

**The version printed by the last line must match the [latest release](https://github.com/Ike-li/claude-chat-mobile/releases/latest)**; if it has not changed, the update did not land.
This deliberately avoids the install-time `curl … | tar xz`: when the download fails, the tar that ships with macOS
gets empty input and still exits successfully without replacing a single file, `npm ci` runs anyway, and everything
looks updated; a download cut off halfway can replace only some of the files. If your connection to GitHub is
unreliable, give curl a proxy (`https_proxy=…`) and try again.

**Overwriting does not touch your config or your data.** `ccm.config.json` and `data/` are both in `.gitignore`,
and the archive is exactly what GitHub's on-the-fly `git archive` produces — it only packs files git tracks, so
those two are not in the archive at all and `tar` has nothing to overwrite. Read positions, device approvals, the
audit log, and uploaded attachments all stay where they are.

To pin a version instead of following `master`, swap the URL for `/archive/refs/tags/vX.Y.Z.tar.gz`; it unpacks
into `claude-chat-mobile-X.Y.Z`, which is a different directory — see "moving to a new directory" below.

### Option B: `git pull` (cloned)

```bash
git pull
npm ci --omit=dev
```

`master` only moves on release, so what you pull is the latest release.

### After either one

Restart the server: from the desktop menu, the "Restart" on the server row; headless, restart that `npm start`
process. It is worth re-running the checks afterwards:

```bash
node scripts/doctor.js
```

**On macOS there is one more step**: click "Update desktop app (rebuild)" in the menu. CCM.app is a compiled
Swift artifact and does not follow the source — without that click the menu bar still runs the old bundle.

### Two things to watch out for

**1. `tar` merges, it does not replace.** Files deleted upstream stay behind in your directory. That does not
affect anything at runtime (a `.js` nobody imports is just dead code), but if you want a clean tree, unpack into
a new directory and move `ccm.config.json` and `data/` across.

**2. A new directory means reinstalling both CLI bridges.** The statusline and hooks bridges write the absolute
path **as of install time** into `~/.claude/settings.json`, pointing at the runner in the old directory.
Overwriting in place is fine (the path did not change, so new code takes effect on its own); after a move, the
old path either points at stale code or does not exist — and the failure is **silent**: the status line stops
refreshing and hook-triggered pushes stop arriving, with nothing in any error pointing here. Reinstall with:

```bash
npm run statusline:install
npm run hooks:install
```

### Upgrading from v1.13.0: connected folders

In v1.13.0 and earlier, `WORKDIRS` was an exact allowlist: a session directory had to be exactly one of the
entries (plus the managed worktrees under its `.claude/worktrees/`). The new version replaces it with "connected
folders"; the meaning is described at the end of [step 3](#3-create-local-configuration). **No data migration is
needed, and your existing `WORKDIRS` keeps working**; what changes is that the same list now lets more through,
and a few places that used to quietly correct a request now reject it.

**The scope is wider, so review the list before upgrading.** Subfolders now just work, and when connected folders
nest, the deepest one owns the path. If your list connects a broad parent such as `~/code`, after the upgrade the
whole subtree can host sessions, and sessions you opened from a terminal anywhere in it show up in the drawer, one
section per subfolder that has sessions. If you only meant to expose a few projects, replace the parent with
those. `~/.claude` and this app's data directory are still off limits; connecting their parent doesn't bring them
along.

**The hooks bridge pushes more.** With the CLI hooks bridge installed, "needs you" and turn-finished events from
terminal sessions in subfolders now reach your phone too; before, only the listed directories themselves did.

**Adding folders from the phone needs the list in `WORKDIRS` in `ccm.config.json`**; otherwise tapping it only
tells you it can't be changed. Both fixes below are only picked up at startup, so do them before restarting the
server:

- Still on `.env` (including a `workdirs.json` that `WORK_DIRS_FILE` points to): run `npm run config:migrate`.
  It inlines the list and keeps your existing `AUTH_TOKEN` (see
  [Upgrading from a legacy `.env`](#upgrading-from-a-legacy-env)). If your `ccm.config.json` itself contains
  `WORK_DIRS_FILE`, edit the file directly: put that list into `WORKDIRS` and delete `WORK_DIRS_FILE`.
- `WORK_DIRS` or `WORK_DIRS_FILE` exported in your shell: remove them. Environment variables beat the config
  file, and while they are set the phone can only view the list, not add to it.

**Sibling worktrees still have to be connected explicitly.** A `../repo-<branch>` outside the repository doesn't
follow the repository, same as before: one you listed keeps working after the upgrade in its own section, and one
you didn't list won't appear on its own. One case gets a new hint: a worktree entry that already sits inside
another connected folder (say its parent is connected as a whole) still gets its own section, and
`node scripts/doctor.js` points out that the entry can go; remove it and its sessions fold back into the
repository's section.

**Out-of-scope requests are now rejected.** Before, a directory that wasn't on the list was quietly swapped for the
one you were viewing; now the request is refused. You're most likely to notice this in the offline queue: a queued
message that would open a session in a folder removed from the list before it went out now stops with a "stopped
retrying" notice instead of landing in another folder. Resend it by hand if you still want it.

**When a session leaves the scope mid-run, the phone doesn't follow.** If a session started from the phone moves
into a directory outside the connected folders while it runs (most often `EnterWorktree` into a sibling worktree
that isn't connected), the phone stays where it was and the session shows a notice. Switch away at that point and
you won't find the session again; to keep using it on the phone, connect that folder first.

**Finally, reload the page on the phone once.** After the server restarts, a page that was already open on the
phone is still running the old front end; reload it once to get the folder picker (the folder chip on the
new-session page and "＋ Choose a folder" at the top of the drawer). If you opened it from a home-screen icon, close it
fully and open it again.

### Checking whether there is a new version

The product never checks upstream on its own. Look yourself:

```bash
git ls-remote --tags --refs --sort=-v:refname https://github.com/Ike-li/claude-chat-mobile.git | head -1
```

That does not require a local git repository (it asks the remote directly), so it works for archive installs too.
Keep `--sort=-v:refname`: the remote lists tags in dictionary order, so taking the last line without sorting gives `v1.9.1`,
and every release from `v1.10.0` on sorts before it.
Your local version:

```bash
node -p "require('./package.json').version"
```

Once the server is up, `versions.server` in `/health` reports the same value, while `versions.cli` and
`versions.sdk` give your local `claude` and Agent SDK versions — the easiest post-upgrade sanity check.

## Uninstall

```bash
npm run uninstall -- --dry-run   # preview every action without touching anything
npm run uninstall -- --yes       # remove the install surface: managed launchd units, any leftover menu bar app process, CCM.app, defaults domain, both CLI bridges and ~/.claude/ccm
npm run uninstall -- --purge --yes  # additionally delete the data dir (known files only), ccm.config.json/.env, managed-unit logs
```

It only removes what this product installed or produced: launchd units outside the service
manifest (for example a hand-installed cloudflared tunnel), `~/.claude/projects`, `~/.cloudflared`,
and anything in settings.json beyond the two bridge entries are never touched. Per-workdir
both attachment directories are reported but never deleted, because previews in old transcripts read
from them: `uploads/` in the data dir (the current location — `--purge` leaves it alone too) and
per-workdir `.ccm-uploads/` (left over from before the 2026-09-06 move). Other unrecognized files in
the data dir (manual backups etc.) are kept and listed as well. Run `node scripts/doctor.js` to see
how much each one holds. Browser/phone-side
site data and the installed PWA must be cleared manually.

## Troubleshooting

| Symptom | Check |
|---|---|
| The server refuses to start, saying `AUTH_TOKEN` is missing | The token is a startup prerequisite; it no longer degrades to a loopback bind. Run `npm run setup` to generate one, then restart |
| Startup logs list only the local URL, no phone URL | `BIND_MODE=loopback` binds `127.0.0.1` only, so nothing is listening on those LAN addresses. Switch back to the default or `lan` for direct phone access |
| An agent ran setup but wrote nothing | Interactive mode was used without a TTY; setup now refuses. Use `--yes --hooks=...` (add `--work-dir=...` to connect a folder) |
| doctor / the server reads the old config | Inherited `AUTH_TOKEN` / `WORK_DIRS` / `CF_ACCESS_*` in the current shell override the file; `unset` them first |
| `EADDRINUSE :3000` | The desktop app or another npm start owns the port; do not blindly start another |
| The phone stays on device approval | Run `device.js list`, verify the ID, and approve the correct device |
| Phone is in the main shell, but sending shows `Not logged in · Please run /login` | This is **Claude CLI not logged in**, not a broken CCM token/device gate. On the host run `claude auth status`; if logged out, `/login` inside `claude`, then retry from the phone. **A third-party gateway never shows this line** — it does not use Anthropic login, and an ineffective config surfaces the gateway's own error instead; see "A third-party gateway is ignored" below. See §1 prerequisites |
| After one wrong token, the correct one is rejected too (HTTP 429 `cooldown`) | Brute-force backoff is working, not a broken server. The first failure arms a 0.5s lock, then backs off exponentially (1s → 2s → 4s…). Requests inside the lock are not checked against the token: **they get 429 `{"status":"cooldown"}` with `Retry-After`**, distinct from a wrong token (401) and never worded as "too many attempts" — you only got it wrong once. The web UI shows "retrying automatically in Ns" and reconnects on its own; scripts should **wait `Retry-After` seconds and retry**, since hammering keeps you inside the lock. Only the 15-minute lockout, which needs 8 consecutive failures, answers `{"status":"rate_limited"}` |
| You typed the token correctly but rate limiting still blocks you | Limiting buckets by source, and failures inside one bucket add up. **IPv6 clients are bucketed by /64**, so another device on your subnet typing it wrong will affect you; behind a reverse proxy terminating on loopback, all public clients share a single bucket (see the [deployment guide](deployment.md#换掉入口后ccm-侧的四处连带变化)). Wait out the lockout window, or restart the server to clear it immediately |
| A third-party gateway is ignored | Put `ANTHROPIC_*` where the CLI reads it: the `env` block of the workspace's `.claude/settings.local.json` or of `~/.claude/settings.json`, or the shell that starts the server; values in `ccm.config.json` are stripped. Only the settings-file route works under the desktop console |
| CLI session status or notifications are missing | Check the statusline and hooks bridges separately; they solve different problems |
| Android installs only a browser shortcut | Cloudflare Access may block PWA icons; see the [deployment guide](deployment.md#2b-android-pwa图标必须对匿名可达) |
| Startup logs "read as number/boolean" conversion notes | `ccm.config.json` has numbers or toggles written as strings; use `3000` / `true`, not `"3000"` / `"true"` |
| The desktop menu bar icon is gone | The notch pushed it out; see [the section above](#when-the-notch-hides-the-menu-bar-icon) for the one-line `defaults write` recovery |

## Next steps

- Long-term public access: [Deployment and operations](deployment.md) (Chinese)
- Public access without Cloudflare: the Tailscale recipe in [Deployment and operations](deployment.md) (Chinese)
- Understand the Web/CLI paths: [Architecture](architecture.en.md)
- Understand model, effort, and statusline sources: [Display contracts](display-contracts.md) (Chinese)
- Maintainers — n=1 hard rules and the technical-debt index: [hard-rules.md](hard-rules.md) (Chinese)
- Review every setting and what it does: `node scripts/config.js schema` (generated from the schema, never drifts from the code)
