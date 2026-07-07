# What you can do with claude from your phone

[中文](capabilities.md) · **English**

> This doc answers one question: **once it's set up, what can the phone actually do?** For setup steps see the [README](../README.en.md); for the security model see [design.md §4](design.md).

One thing first: this project is **not a new AI, and not a reimplementation of Claude**. It projects the **`claude` CLI you already run on your own machine** (Claude Code) onto your phone's browser — so the agent capabilities you have in the terminal are essentially all here: the same agent, the same `CLAUDE.md`, the same MCP servers, skills, hooks, and logged-in session. The design goal is **terminal equivalence**: typing to claude on your phone behaves just like sitting at your computer.

Below is organized by "what you do on the phone," and each block marks the **↳ claude CLI capability it draws on under the hood**.

---

## 1. Talk to claude and actually get work done, like the terminal

- **Send a message and watch it stream back** word by word — not a finished block, but live, like in the terminal.
- **It really edits files and runs commands**, not just chat: `Read` / `Edit` / `Write` / `Bash` / `Grep` and more execute for real in your project directory.
- **The whole process is visible**: every tool call renders as a collapsible card (tool name + argument summary + status), so you see what it's doing right now instead of a black box.
- **Markdown and syntax highlighting**: adapted for a small screen, code blocks scroll horizontally, long replies stay readable.
- **Stop anytime**: a stop button interrupts the current generation without corrupting session state — you can pick right back up.

> ↳ **Under the hood**: the same claude agent and its real tool execution; streaming output, tool calls, and interrupt come straight from the Claude Agent SDK. The middle layer does not alter, summarize, or "optimize" its output.

---

## 2. The core mobile value: dangerous actions bounce back to your phone for approval

This is where it differs most from "just glancing at a remote desktop."

- When claude wants to do something **off your allowlist** (say `git push`, `rm`, editing config, installing deps), it **suspends and pushes an approval request to your phone** — the dialog shows the **full command + working directory + key arguments**, not just a tool name.
- You tap **Allow / Deny / Always allow this session**, and only then does claude continue.
- **Five permission modes, switchable at runtime**: `default` (ask each time), `plan` (plan only, no changes), `acceptEdits` (auto-accept file edits), `bypassPermissions` (allow everything, blast radius = the whole machine, requires an explicit switch + a danger confirmation), `dontAsk`.

> ↳ **Under the hood**: the auto-approve set is **exactly the `permissions.allow` from your existing claude config** (global `~/.claude/settings.json` + project `.claude/settings.json` + local `.claude/settings.local.json`, merged, same source as the terminal) — this project **injects no allow/deny list of its own**. A match is approved; anything else goes through the SDK approval callback and lands on your phone.

---

## 3. Your whole Claude environment, inherited as-is

The phone operates on **"your Claude Code,"** not a clean default instance.

- **Your `CLAUDE.md`, MCP servers, skills, hooks, and logged-in session** — all loaded, behaving exactly as in your terminal.
- **Slash commands**: type `/` to bring up the commands **you actually have** (`/skill`, your custom commands, etc.) and tap to run.
- **Per-message model switching** (`/model`, gateway-suffixed names supported) and **thinking-effort switching**.
- **When claude asks you a question** (`AskUserQuestion`), the phone shows **native option buttons** — tap to answer instead of typing a number.

> ↳ **Under the hood**: the SDK loads your full local config via `settingSources`; slash commands come from the session `init` event's `slash_commands` (claude's machine-readable command boundary); model and effort are passed straight through to the CLI.

---

## 4. Built for how phones are actually used (things the terminal doesn't have)

The phone usage pattern is "look for 30 seconds → lock screen → look again ten minutes later," and this project is designed for exactly that:

- **Continuous session, handed off across devices**: start something on your phone, pick it up at your desk with `/resume` — both ends read the **same CLI session log**, not two separate ones.
- **It doesn't drop when you leave**: the task lives on the server, decoupled from the network connection. Lock the screen, background the tab, lose signal on the subway — it keeps running; when you come back the page **reconnects and replays everything you missed**.
- **Self-healing on weak networks**: every event carries a monotonic sequence number, so a reconnect resumes by sequence instead of losing or duplicating output.
- **History sessions**: pick, switch, or start one from the session list; switching in **replays the full history** (same source as the terminal's `/resume`).
- **Multi-repo, multi-session in parallel**: switch among allow-listed working directories and run several sessions at once in tabs — something a single-screen remote desktop can't do.
- **Upload files / images**: pick one from your library or files and hand it to claude, which `Read`s it on the spot (with path-injection and traversal protection).
- **Copy long output**: a copy button grabs the raw Markdown source.
- **Web Push notifications**: **approval requests / claude's questions / results that finished while you were disconnected** are pushed to your phone's notifications, so you don't have to keep staring at the screen (iOS 16.4+ requires "Add to Home Screen" first).
- **Web-native status line**: above the input, showing model, context usage, cost, git, and more (rendered natively by the app, not a copy of the terminal's ANSI).

> ↳ **Under the hood**: claude's native session (the JSONL session file) is the single source of truth, and resume relies entirely on it; this project only keeps a lightweight session-metadata mapping on the server. The phone also remembers the permission mode / thinking effort last in effect for a session (a small enhancement over the terminal).

---

## Phone action ↔ terminal equivalent

| On your phone… | Equivalent to, at the terminal… |
|---|---|
| Send a message | Typing to claude |
| Watch the streaming reply + tool cards | Watching it output word by word, watching it call tools |
| Tap Allow / Deny in the approval dialog | Answering the `y / n` permission prompt |
| Tap the stop button | Pressing `Esc` to interrupt |
| Type `/` to pick a command | Using `/skill`, `/model`, custom commands |
| Tap an `AskUserQuestion` option | Answering claude's question |
| Switch sessions, review history | `claude -r` to pick a past session, `--continue` to resume |
| Come back after a 10-minute lock and auto-get the output | Sitting there watching it run |
| Get a push for an approval / result | Being at the terminal, seeing it the moment it appears |

---

## Boundaries: what it does **not** do, what you **can't** see (stated honestly)

To avoid misleading you, these are limits — some deliberate, some architectural:

- **It does not recreate the terminal's settings panels**: `/config`, `/plugin` and other **TUI panels that belong to the terminal client itself** are not ported — they're replaced by the app's own UI or by natural language. The thing made equivalent is **agent capability** (conversation, tools, skills, approval, resume, model switching), not the terminal client's interface.
- **When resuming a session that's actively running in a terminal, you can't see live state**: the phone resume spins up a separate process that cold-reads the on-disk session log, so it can only **catch up on output already flushed to disk**; a subagent or thinking mid-turn that hasn't been flushed is not visible, and you can't **take over** the input of a live terminal process from the phone. This is an architectural limit, not a bug.
- **No session rename / delete, no message search / export / stats panel**: the terminal doesn't have these either; if you need them, the raw records are all under `~/.claude/projects/`.
- **The status line has no account-level quota** (e.g. 5-hour / 7-day usage percentages) — the SDK physically can't get that number.
- **It is not a remote desktop**: a remote desktop mirrors a screen; this gives you a **native phone entry point** to your own local claude session — input, notifications, and multi-session built for a phone, not your computer's screen projected over.

---

> For the per-feature spec (the mobile implementation detail of each item), see [design.md §2, the terminal-equivalence checklist](design.md).
