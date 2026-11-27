//! Built-in workspace tools for Karsa's in-process custom HTTP API driver.
//!
//! All filesystem operations are strictly confined to the session's workspace
//! root (`cwd`) and any explicit `additional_directories`. Terminal commands
//! are only executed when `allow_terminal` is enabled on the agent config.

use std::path::{Component, Path, PathBuf};

use serde_json::{json, Value};

const MAX_READ_BYTES: usize = 256 * 1024;
const MAX_LIST_ENTRIES: usize = 250;
const MAX_SEARCH_MATCHES: usize = 80;
const MAX_CMD_OUTPUT_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone)]
pub struct ToolDefinition {
    pub name: &'static str,
    pub description: &'static str,
    pub parameters: Value,
}

#[derive(Debug, Clone)]
pub struct ToolExecutionResult {
    pub ok: bool,
    pub output: String,
    pub title: String,
    pub locations: Vec<PathBuf>,
}

pub fn available_tools(allow_terminal: bool) -> Vec<ToolDefinition> {
    let mut defs = vec![
        ToolDefinition {
            name: "read_file",
            description: "Read UTF-8 text from a file inside the workspace. Supports optional 1-based start_line and end_line.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Relative or absolute path within the workspace" },
                    "start_line": { "type": "integer", "description": "Optional 1-based start line" },
                    "end_line": { "type": "integer", "description": "Optional 1-based end line (inclusive)" }
                },
                "required": ["path"]
            }),
        },
        ToolDefinition {
            name: "write_file",
            description: "Create or overwrite a UTF-8 text file inside the workspace.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Relative or absolute path within the workspace" },
                    "content": { "type": "string", "description": "Full file content to write" }
                },
                "required": ["path", "content"]
            }),
        },
        ToolDefinition {
            name: "list_files",
            description: "List files and directories inside a workspace directory.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Directory path relative to workspace root (default '.')" }
                }
            }),
        },
        ToolDefinition {
            name: "search_files",
            description: "Search for a case-insensitive text substring across files in the workspace.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Text to search for" },
                    "path": { "type": "string", "description": "Optional subdirectory to restrict search" }
                },
                "required": ["query"]
            }),
        },
    ];

    if allow_terminal {
        defs.push(ToolDefinition {
            name: "run_command",
            description: "Run a shell command in the workspace root directory and return stdout/stderr.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "Shell command to execute" }
                },
                "required": ["command"]
            }),
        });
    }

    defs
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

fn resolve_workspace_path(
    cwd: &Path,
    additional_dirs: &[PathBuf],
    raw: &str,
) -> Result<PathBuf, String> {
    let candidate = PathBuf::from(raw);
    let abs = if candidate.is_absolute() {
        normalize_path(&candidate)
    } else {
        normalize_path(&cwd.join(&candidate))
    };

    let allowed_roots = std::iter::once(cwd)
        .chain(additional_dirs.iter().map(PathBuf::as_path))
        .map(|root| {
            std::fs::canonicalize(root)
                .map(|p| strip_verbatim_prefix(&p))
                .unwrap_or_else(|_| normalize_path(root))
        })
        .collect::<Vec<_>>();

    let check_target = std::fs::canonicalize(&abs)
        .map(|p| strip_verbatim_prefix(&p))
        .unwrap_or_else(|_| abs.clone());

    if allowed_roots.iter().any(|root| check_target.starts_with(root)) {
        Ok(abs)
    } else {
        Err(format!("Path '{raw}' is outside the active workspace"))
    }
}

fn strip_verbatim_prefix(path: &Path) -> PathBuf {
    let s = path.to_string_lossy();
    if let Some(stripped) = s.strip_prefix(r"\\?\") {
        PathBuf::from(stripped)
    } else {
        path.to_path_buf()
    }
}

pub async fn execute_tool(
    name: &str,
    args: &Value,
    cwd: &Path,
    additional_dirs: &[PathBuf],
    allow_terminal: bool,
) -> ToolExecutionResult {
    match name {
        "read_file" => exec_read_file(args, cwd, additional_dirs).await,
        "write_file" => exec_write_file(args, cwd, additional_dirs).await,
        "list_files" => exec_list_files(args, cwd, additional_dirs).await,
        "search_files" => exec_search_files(args, cwd, additional_dirs).await,
        "run_command" => exec_run_command(args, cwd, allow_terminal).await,
        other => ToolExecutionResult {
            ok: false,
            output: format!("Unknown tool: {other}"),
            title: format!("Unknown tool: {other}"),
            locations: vec![],
        },
    }
}

async fn exec_read_file(
    args: &Value,
    cwd: &Path,
    additional_dirs: &[PathBuf],
) -> ToolExecutionResult {
    let raw_path = args.get("path").and_then(Value::as_str).unwrap_or("");
    let title = format!("Read {raw_path}");
    let path = match resolve_workspace_path(cwd, additional_dirs, raw_path) {
        Ok(p) => p,
        Err(e) => {
            return ToolExecutionResult {
                ok: false,
                output: e,
                title,
                locations: vec![],
            }
        }
    };

    let bytes = match tokio::fs::read(&path).await {
        Ok(b) => b,
        Err(e) => {
            return ToolExecutionResult {
                ok: false,
                output: format!("Failed to read file: {e}"),
                title,
                locations: vec![path],
            }
        }
    };

    let truncated = bytes.len() > MAX_READ_BYTES;
    let slice = &bytes[..bytes.len().min(MAX_READ_BYTES)];
    let text = String::from_utf8_lossy(slice);
    let start_line = args
        .get("start_line")
        .and_then(Value::as_u64)
        .map(|v| v.max(1) as usize);
    let end_line = args.get("end_line").and_then(Value::as_u64).map(|v| v as usize);

    let mut out = if start_line.is_some() || end_line.is_some() {
        let start = start_line.unwrap_or(1);
        let end = end_line.unwrap_or(usize::MAX);
        text.lines()
            .enumerate()
            .filter_map(|(idx, line)| {
                let ln = idx + 1;
                if ln >= start && ln <= end {
                    Some(format!("{ln}: {line}"))
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        text.into_owned()
    };

    if truncated {
        out.push_str("\n\n[truncated at 256 KB]");
    }

    ToolExecutionResult {
        ok: true,
        output: out,
        title,
        locations: vec![path],
    }
}

async fn exec_write_file(
    args: &Value,
    cwd: &Path,
    additional_dirs: &[PathBuf],
) -> ToolExecutionResult {
    let raw_path = args.get("path").and_then(Value::as_str).unwrap_or("");
    let content = args.get("content").and_then(Value::as_str).unwrap_or("");
    let title = format!("Write {raw_path}");
    let path = match resolve_workspace_path(cwd, additional_dirs, raw_path) {
        Ok(p) => p,
        Err(e) => {
            return ToolExecutionResult {
                ok: false,
                output: e,
                title,
                locations: vec![],
            }
        }
    };

    if let Some(parent) = path.parent() {
        if let Err(e) = tokio::fs::create_dir_all(parent).await {
            return ToolExecutionResult {
                ok: false,
                output: format!("Failed to create parent directory: {e}"),
                title,
                locations: vec![path],
            };
        }
    }

    match tokio::fs::write(&path, content.as_bytes()).await {
        Ok(()) => ToolExecutionResult {
            ok: true,
            output: format!("Wrote {} bytes to {}", content.len(), raw_path),
            title,
            locations: vec![path],
        },
        Err(e) => ToolExecutionResult {
            ok: false,
            output: format!("Failed to write file: {e}"),
            title,
            locations: vec![path],
        },
    }
}

async fn exec_list_files(
    args: &Value,
    cwd: &Path,
    additional_dirs: &[PathBuf],
) -> ToolExecutionResult {
    let raw_path = args.get("path").and_then(Value::as_str).unwrap_or(".");
    let title = format!("List {raw_path}");
    let dir = match resolve_workspace_path(cwd, additional_dirs, raw_path) {
        Ok(p) => p,
        Err(e) => {
            return ToolExecutionResult {
                ok: false,
                output: e,
                title,
                locations: vec![],
            }
        }
    };

    let mut rd = match tokio::fs::read_dir(&dir).await {
        Ok(r) => r,
        Err(e) => {
            return ToolExecutionResult {
                ok: false,
                output: format!("Failed to read directory: {e}"),
                title,
                locations: vec![dir],
            }
        }
    };

    let mut entries = Vec::new();
    while let Ok(Some(entry)) = rd.next_entry().await {
        let name = entry.file_name().to_string_lossy().to_string();
        if name == ".git" || name == "node_modules" || name == "target" {
            continue;
        }
        let is_dir = entry
            .file_type()
            .await
            .map(|t| t.is_dir())
            .unwrap_or(false);
        entries.push(if is_dir { format!("{name}/") } else { name });
        if entries.len() >= MAX_LIST_ENTRIES {
            break;
        }
    }
    entries.sort();

    ToolExecutionResult {
        ok: true,
        output: if entries.is_empty() {
            "(empty directory)".to_string()
        } else {
            entries.join("\n")
        },
        title,
        locations: vec![dir],
    }
}

async fn exec_search_files(
    args: &Value,
    cwd: &Path,
    additional_dirs: &[PathBuf],
) -> ToolExecutionResult {
    let query = args.get("query").and_then(Value::as_str).unwrap_or("").trim();
    let raw_path = args.get("path").and_then(Value::as_str).unwrap_or(".");
    let title = format!("Search \"{query}\"");
    if query.is_empty() {
        return ToolExecutionResult {
            ok: false,
            output: "Search query must not be empty".to_string(),
            title,
            locations: vec![],
        };
    }

    let root = match resolve_workspace_path(cwd, additional_dirs, raw_path) {
        Ok(p) => p,
        Err(e) => {
            return ToolExecutionResult {
                ok: false,
                output: e,
                title,
                locations: vec![],
            }
        }
    };

    let needle = query.to_ascii_lowercase();
    let cwd_owned = cwd.to_path_buf();
    let matches = tokio::task::spawn_blocking(move || {
        let mut results = Vec::new();
        let mut stack = vec![root];
        while let Some(dir) = stack.pop() {
            if results.len() >= MAX_SEARCH_MATCHES {
                break;
            }
            let Ok(rd) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in rd.flatten() {
                if results.len() >= MAX_SEARCH_MATCHES {
                    break;
                }
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().to_string();
                if matches!(
                    name.as_str(),
                    ".git" | "node_modules" | "target" | "dist" | "dist-tauri" | ".next"
                ) {
                    continue;
                }
                let Ok(ft) = entry.file_type() else {
                    continue;
                };
                if ft.is_dir() {
                    stack.push(path);
                } else if ft.is_file() {
                    if let Ok(meta) = entry.metadata() {
                        if meta.len() > MAX_READ_BYTES as u64 {
                            continue;
                        }
                    }
                    let Ok(text) = std::fs::read_to_string(&path) else {
                        continue;
                    };
                    let rel = path
                        .strip_prefix(&cwd_owned)
                        .unwrap_or(&path)
                        .to_string_lossy()
                        .replace('\\', "/");
                    for (idx, line) in text.lines().enumerate() {
                        if line.to_ascii_lowercase().contains(&needle) {
                            let preview: String = line.trim().chars().take(180).collect();
                            results.push(format!("{rel}:{}: {preview}", idx + 1));
                            if results.len() >= MAX_SEARCH_MATCHES {
                                break;
                            }
                        }
                    }
                }
            }
        }
        results
    })
    .await
    .unwrap_or_default();

    ToolExecutionResult {
        ok: true,
        output: if matches.is_empty() {
            "No matches found.".to_string()
        } else {
            matches.join("\n")
        },
        title,
        locations: vec![],
    }
}

async fn exec_run_command(
    args: &Value,
    cwd: &Path,
    allow_terminal: bool,
) -> ToolExecutionResult {
    let command = args.get("command").and_then(Value::as_str).unwrap_or("").trim();
    let title = format!("Run `{command}`");
    if !allow_terminal {
        return ToolExecutionResult {
            ok: false,
            output: "Terminal access is disabled for this custom API connection. Enable 'Allow terminal' in Settings → Agents to run commands.".to_string(),
            title,
            locations: vec![],
        };
    }
    if command.is_empty() {
        return ToolExecutionResult {
            ok: false,
            output: "Command must not be empty".to_string(),
            title,
            locations: vec![],
        };
    }

    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = tokio::process::Command::new("powershell");
        c.args(["-NoProfile", "-Command", command]);
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
        c
    };

    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = tokio::process::Command::new("sh");
        c.args(["-lc", command]);
        c
    };

    cmd.current_dir(cwd);
    let output = tokio::time::timeout(std::time::Duration::from_secs(60), cmd.output()).await;
    match output {
        Ok(Ok(res)) => {
            let stdout = String::from_utf8_lossy(&res.stdout);
            let stderr = String::from_utf8_lossy(&res.stderr);
            let mut combined = String::new();
            if !stdout.is_empty() {
                combined.push_str(&stdout);
            }
            if !stderr.is_empty() {
                if !combined.is_empty() {
                    combined.push('\n');
                }
                combined.push_str("[stderr]\n");
                combined.push_str(&stderr);
            }
            if combined.len() > MAX_CMD_OUTPUT_BYTES {
                combined.truncate(MAX_CMD_OUTPUT_BYTES);
                combined.push_str("\n[output truncated]");
            }
            if combined.is_empty() {
                combined = format!("(exit code {})", res.status.code().unwrap_or(-1));
            }
            ToolExecutionResult {
                ok: res.status.success(),
                output: combined,
                title,
                locations: vec![],
            }
        }
        Ok(Err(e)) => ToolExecutionResult {
            ok: false,
            output: format!("Failed to spawn command: {e}"),
            title,
            locations: vec![],
        },
        Err(_) => ToolExecutionResult {
            ok: false,
            output: "Command timed out after 60 seconds".to_string(),
            title,
            locations: vec![],
        },
    }
}
