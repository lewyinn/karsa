//! Creating a GitHub pull request via `gh api --method POST repos/{owner}/{name}/pulls --input -`.
//!
//! Title, body, head, base, and draft flag travel in JSON on stdin rather than argv,
//! keeping multiline Markdown bodies safe on Windows and hidden from process listings.

use serde::Deserialize;
use serde_json::{json, Map, Value};

use super::error::GithubError;
use super::types::{GithubCreatePrRequest, GithubCreatePrResult, GithubRepoRef};

const MAX_PR_TITLE_CHARS: usize = 256;

#[derive(Debug, Clone)]
pub(super) struct CheckedPrInput {
    pub title: String,
    pub body: String,
    pub head: String,
    pub base: String,
    pub draft: bool,
}

pub(super) fn checked_pr(request: &GithubCreatePrRequest) -> Result<CheckedPrInput, GithubError> {
    let title = request.title.trim();
    if title.is_empty() {
        return Err(GithubError::Refused(
            "The pull request title is empty".to_string(),
        ));
    }
    if title.chars().count() > MAX_PR_TITLE_CHARS {
        return Err(GithubError::Refused(format!(
            "A pull request title has at most {MAX_PR_TITLE_CHARS} characters"
        )));
    }
    let head = request.head.trim();
    if head.is_empty() {
        return Err(GithubError::Refused(
            "The source (head) branch is required".to_string(),
        ));
    }
    let base = request.base.trim();
    if base.is_empty() {
        return Err(GithubError::Refused(
            "The target (base) branch is required".to_string(),
        ));
    }
    if head == base {
        return Err(GithubError::Refused(
            "Head and base branches must be different".to_string(),
        ));
    }

    Ok(CheckedPrInput {
        title: title.to_string(),
        body: request.body.trim_end().to_string(),
        head: head.to_string(),
        base: base.to_string(),
        draft: request.draft,
    })
}

pub(super) fn create_pr_args(repo: &GithubRepoRef) -> Vec<String> {
    vec![
        "api".to_string(),
        "--method".to_string(),
        "POST".to_string(),
        format!("repos/{}/{}/pulls", repo.owner, repo.name),
        "--input".to_string(),
        "-".to_string(),
    ]
}

pub(super) fn create_pr_payload(input: &CheckedPrInput) -> Vec<u8> {
    let mut obj = Map::new();
    obj.insert("title".to_string(), json!(input.title));
    obj.insert("head".to_string(), json!(input.head));
    obj.insert("base".to_string(), json!(input.base));
    if !input.body.is_empty() {
        obj.insert("body".to_string(), json!(input.body));
    }
    if input.draft {
        obj.insert("draft".to_string(), json!(true));
    }
    serde_json::to_vec(&Value::Object(obj)).expect("JSON object serialization cannot fail")
}

#[derive(Deserialize)]
struct RawCreatedPr {
    number: u64,
    html_url: String,
    title: String,
}

pub(super) fn parse_created_pr(stdout: &[u8]) -> Result<GithubCreatePrResult, GithubError> {
    let parsed: RawCreatedPr = serde_json::from_slice(stdout)
        .map_err(|e| GithubError::Failed(format!("unreadable create pull request response: {e}")))?;
    Ok(GithubCreatePrResult {
        number: parsed.number,
        url: parsed.html_url,
        title: parsed.title,
    })
}
