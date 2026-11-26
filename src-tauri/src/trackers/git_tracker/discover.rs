//! Discover Git repositories inside a project folder (root + nested sub-repos).
//!
//! Enables a single workspace folder (such as `internity/` containing
//! `frontend/.git` and `backend/.git`) to surface all of its Git repositories
//! in the Changes panel, GitHub panel, and chat changed-files card without
//! splitting the workspace into separate sidebar projects.

use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::path_validation::strip_verbatim_prefix;

/// Default scan depth below the workspace root (covers `frontend/`, `apps/web/`, etc.).
pub const DEFAULT_DISCOVER_MAX_DEPTH: usize = 2;
/// Hard ceiling on scan depth so a caller cannot trigger a deep filesystem crawl.
const MAX_ALLOWED_DEPTH: usize = 3;
/// Cap on discovered repositories to keep UI selectors snappy.
const MAX_DISCOVERED_REPOS: usize = 24;
/// Cap on visited directories so opening a huge folder never stalls.
const MAX_VISITED_DIRS: usize = 500;

const IGNORED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "dist-web",
    "dist-tauri",
    "build",
    "out",
    ".next",
    ".nuxt",
    ".turbo",
    ".svelte-kit",
    ".cache",
    ".venv",
    "venv",
    "__pycache__",
    "vendor",
    ".worktrees",
    ".idea",
    ".vscode",
    "coverage",
    ".gradle",
    "Pods",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredGitRepo {
    /// Human-readable label (relative path for sub-repos, folder basename for root).
    pub name: String,
    /// Forward-slash relative path from the workspace root (`""` when `is_root` is true).
    pub relative_path: String,
    /// Absolute path to the repository root (without Windows `\\?\` verbatim prefix).
    pub path: String,
    /// `true` when the workspace root itself contains `.git`.
    pub is_root: bool,
}

fn clean_path_string(path: &Path) -> String {
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    strip_verbatim_prefix(&canonical.to_string_lossy()).into_owned()
}

fn has_git_marker(dir: &Path) -> bool {
    // `.git` can be a directory (standard repo) or a file (worktree / submodule).
    dir.join(".git").exists()
}

fn is_ignored_dir(name: &str) -> bool {
    if name.starts_with('.') {
        return true;
    }
    IGNORED_DIRS
        .iter()
        .any(|ignored| ignored.eq_ignore_ascii_case(name))
}

fn to_forward_slash_relative(rel: &Path) -> String {
    rel.components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

/// Discover Git repositories at `cwd` and in subdirectories up to `max_depth`.
///
/// Never follows symlinks during traversal to avoid cycles. Returns repositories
/// sorted with the workspace root first (if present), followed by sub-repos
/// ordered alphabetically by `relative_path`.
pub fn git_discover_repos(cwd: &str, max_depth: Option<usize>) -> Result<Vec<DiscoveredGitRepo>, String> {
    let root = PathBuf::from(cwd);
    if !root.is_dir() {
        return Err(format!("directory does not exist: {cwd}"));
    }

    let max_depth = max_depth
        .unwrap_or(DEFAULT_DISCOVER_MAX_DEPTH)
        .min(MAX_ALLOWED_DEPTH);

    let mut repos = Vec::new();
    let mut visited_dirs = 0usize;

    if has_git_marker(&root) {
        let root_path = clean_path_string(&root);
        let root_name = Path::new(&root_path)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| root_path.clone());
        repos.push(DiscoveredGitRepo {
            name: root_name,
            relative_path: String::new(),
            path: root_path,
            is_root: true,
        });
    }

    if max_depth == 0 {
        return Ok(repos);
    }

    let mut queue: VecDeque<(PathBuf, PathBuf, usize)> = VecDeque::new();
    queue.push_back((root, PathBuf::new(), 0));

    while let Some((dir, rel_prefix, depth)) = queue.pop_front() {
        if depth >= max_depth || repos.len() >= MAX_DISCOVERED_REPOS || visited_dirs >= MAX_VISITED_DIRS {
            break;
        }
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };

        let mut child_dirs: Vec<(PathBuf, String)> = Vec::new();
        for entry in entries.flatten() {
            let Ok(ft) = entry.file_type() else {
                continue;
            };
            // Skip files and symlinks (prevents cycles & out-of-workspace escapes).
            if !ft.is_dir() || ft.is_symlink() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if is_ignored_dir(&name) {
                continue;
            }
            child_dirs.push((entry.path(), name));
        }

        child_dirs.sort_by(|a, b| a.1.to_ascii_lowercase().cmp(&b.1.to_ascii_lowercase()));

        for (child_path, child_name) in child_dirs {
            if repos.len() >= MAX_DISCOVERED_REPOS || visited_dirs >= MAX_VISITED_DIRS {
                break;
            }
            visited_dirs += 1;
            let child_rel = rel_prefix.join(&child_name);
            if has_git_marker(&child_path) {
                let rel_str = to_forward_slash_relative(&child_rel);
                repos.push(DiscoveredGitRepo {
                    name: rel_str.clone(),
                    relative_path: rel_str,
                    path: clean_path_string(&child_path),
                    is_root: false,
                });
                // Do not descend inside a discovered sub-repo.
            } else if depth + 1 < max_depth {
                queue.push_back((child_path, child_rel, depth + 1));
            }
        }
    }

    repos.sort_by(|a, b| {
        b.is_root
            .cmp(&a.is_root)
            .then_with(|| {
                a.relative_path
                    .to_ascii_lowercase()
                    .cmp(&b.relative_path.to_ascii_lowercase())
            })
    });

    log::debug!(
        "[git_discover_repos] cwd={} found={} visited_dirs={}",
        cwd,
        repos.len(),
        visited_dirs
    );
    Ok(repos)
}
