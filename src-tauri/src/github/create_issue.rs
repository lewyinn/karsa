//! Creating a GitHub issue via `gh api --method POST repos/{owner}/{name}/issues --input -`.
//!
//! Title, body, labels, and assignees travel in JSON on stdin rather than argv,
//! keeping multiline Markdown bodies safe on Windows and hidden from process listings.

use serde::Deserialize;
use serde_json::{json, Map, Value};

use super::error::GithubError;
use super::types::{GithubCreateIssueRequest, GithubCreateIssueResult, GithubRepoRef};

const MAX_ISSUE_TITLE_CHARS: usize = 256;

#[derive(Debug, Clone)]
pub(super) struct CheckedIssueInput {
    pub title: String,
    pub body: String,
    pub labels: Vec<String>,
    pub assignees: Vec<String>,
}

pub(super) fn checked_issue(
    request: &GithubCreateIssueRequest,
) -> Result<CheckedIssueInput, GithubError> {
    let title = request.title.trim();
    if title.is_empty() {
        return Err(GithubError::Refused("The issue title is empty".to_string()));
    }
    if title.chars().count() > MAX_ISSUE_TITLE_CHARS {
        return Err(GithubError::Refused(format!(
            "An issue title has at most {MAX_ISSUE_TITLE_CHARS} characters"
        )));
    }
    let labels = request
        .labels
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    let assignees = request
        .assignees
        .iter()
        .map(|s| s.trim().trim_start_matches('@'))
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();

    Ok(CheckedIssueInput {
        title: title.to_string(),
        body: request.body.trim_end().to_string(),
        labels,
        assignees,
    })
}

pub(super) fn create_issue_args(repo: &GithubRepoRef) -> Vec<String> {
    vec![
        "api".to_string(),
        "--method".to_string(),
        "POST".to_string(),
        format!("repos/{}/{}/issues", repo.owner, repo.name),
        "--input".to_string(),
        "-".to_string(),
    ]
}

pub(super) fn create_issue_payload(input: &CheckedIssueInput) -> Vec<u8> {
    let mut obj = Map::new();
    obj.insert("title".to_string(), json!(input.title));
    if !input.body.is_empty() {
        obj.insert("body".to_string(), json!(input.body));
    }
    if !input.labels.is_empty() {
        obj.insert("labels".to_string(), json!(input.labels));
    }
    if !input.assignees.is_empty() {
        obj.insert("assignees".to_string(), json!(input.assignees));
    }
    serde_json::to_vec(&Value::Object(obj)).expect("JSON object serialization cannot fail")
}

#[derive(Deserialize)]
struct RawCreatedIssue {
    number: u64,
    html_url: String,
    title: String,
}

pub(super) fn parse_created_issue(stdout: &[u8]) -> Result<GithubCreateIssueResult, GithubError> {
    let parsed: RawCreatedIssue = serde_json::from_slice(stdout)
        .map_err(|e| GithubError::Failed(format!("unreadable create issue response: {e}")))?;
    Ok(GithubCreateIssueResult {
        number: parsed.number,
        url: parsed.html_url,
        title: parsed.title,
    })
}
