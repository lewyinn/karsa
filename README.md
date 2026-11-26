# Karsa

Personal AI-assisted desktop workspace built with Tauri, React, TypeScript, and Rust by [**lewyinn**](https://github.com/lewyinn).

> **Upstream attribution:** Karsa (`v0.1.0`) is a customized personal fork of [**gnoviawan/troupe**](https://github.com/gnoviawan/troupe) (with Tauri porting contributions by **mannnrachman**), distributed under the [MIT License](./LICENSE).

---

## What Was Added & Customized

- **Multi-Repo Workspace Support (1 Project → Multiple Sub-Repos)**
  - Automatically discovers nested Git repositories up to depth 2 (e.g., `project/frontend` and `project/backend`) via `git_discover_repos`.
  - Synced **Repo Switcher** across both the **Changes** and **GitHub** panels, plus combined uncommitted-change counts in the right tool strip.
- **GitHub Panel Enhancements**
  - **`All repos`** merged mode in the GitHub panel combining Issues and Pull Requests from all discovered sub-repositories with per-row repo badges.
  - **`+ New issue`** dialog (`github_create_issue`) with Target Repo picker, Markdown description, labels, assignees, and automatic opening of the created issue tab (ready for Agent Chat handoff).
- **Inline `N files changed` Card in Agent Chat**
  - Collapsible summary card above the chat composer with downward inline diffs (without opening a side panel).
  - Multi-repo aware (`frontend` / `backend` pills), plus per-file **Stage / Unstage** and confirmed **Revert** actions directly from chat.
- **Upgraded AI Commit Message Generator**
  - Generates **Conventional Commits** (`feat(scope): ...`, `fix(scope): ...`) with bullet-point descriptions.
  - Falls back to **unstaged changes** when nothing is staged yet, and automatically omits noisy lockfiles (`bun.lock`, `package-lock.json`, `Cargo.lock`, `*.min.js`, `*.map`) to avoid diff-size failures.
- **One-Click `Run Stack` (Multi-Service Runner)**
  - Auto-discovers dev scripts (`package.json`, `go.mod`, `Cargo.toml`, Python/Django) across root and subfolders (`frontend` / `backend`), lets you **Run all / Stop all**, edits commands inline, detects `localhost` URLs, and includes **`Fix in Chat`** to send recent terminal error logs straight to an AI chat draft.
- **Share-Screen-Safe `.env` Quick Manager**
  - Auto-discovers `.env*` files across root and sub-repos with values masked by default (`••••••••••••`), single-row reveal eye, safe clipboard copy, inline edit/add/delete, `.env.example` missing-key detection, and 1-click `.env` creation from `.env.example`.
- **UX & Agent Improvements**
  - Curated ACP agent catalog focused on **Claude Code** and **Antigravity** (`client_info` set honestly to `karsa`).
  - Unified **Accounts** and **Agent Runtime** install status banner.
  - Collapsible **Staged** and **Changes** sections in the Git Changes panel.
  - Increased default toast duration to **10 seconds** and ACP initialization timeout to **180 seconds**.
  - Added faster Windows dev compilation profile (`debug = "line-tables-only"`).

---

## What Was Removed

- **Remote Server & Mobile Companion (`troupe-server` / `apps/rune`)** — removed standalone remote server binary, mobile pairing QR UI, and remote host modules.
- **Auto-Updater (`tauri-plugin-updater`)** — disabled and removed updater plugin packages and Windows installer hooks for manual personal builds.
- **Unused ACP Agents** — removed **Codex** and **Gemini CLI** entries from the ACP catalog and provider settings.
- **Workspace Snapshots** — removed the `/snapshots` page, create-snapshot modal, and command palette entry.
- **Upstream Bug Report Modal** — removed "Report a bug" UI links pointing to the upstream tracker.
- **Legacy Rebrand / Redirect Assets** — removed legacy `scripts/rebrand/`, `scripts/termul-dev-redirect/`, `design-system/`, and `img/` folders.

---

## Development & Build

### Prerequisites
- [Bun](https://bun.sh/)
- [Rust toolchain](https://rustup.rs/) (MSVC build tools on Windows)
- [GitHub CLI (`gh`)](https://cli.github.com/) authenticated (`gh auth login`) for GitHub panel features

### Run in Development
```bash
bun install
bun run dev
```

### Build Windows Desktop Installer (`.exe`)
```bash
node scripts/canvas/fetch-figcraft-bundle.mjs
bun run build
```

---

## License

This project is licensed under the **MIT License** — see the [LICENSE](./LICENSE) file for full details.

- Original work: Copyright (c) 2025 **gnoviawan** ([`gnoviawan/troupe`](https://github.com/gnoviawan/troupe))
- Tauri porting contributions: Copyright (c) 2026 **mannnrachman**
- Karsa fork and modifications: Copyright (c) 2026 **lewyinn**
