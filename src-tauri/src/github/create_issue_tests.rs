use super::create_issue::{
    checked_issue, create_issue_args, create_issue_payload, parse_created_issue,
};
use super::types::{GithubCreateIssueRequest, GithubRepoRef, GithubRepoSlot};

fn sample_request() -> GithubCreateIssueRequest {
    GithubCreateIssueRequest {
        cwd: "/repo".to_string(),
        repo: GithubRepoSlot::Origin,
        title: "  Fix login refresh  ".to_string(),
        body: "Steps to reproduce\n- expire token\n".to_string(),
        labels: vec!["bug".to_string(), " ".to_string()],
        assignees: vec!["@ridho".to_string()],
    }
}

#[test]
fn checked_issue_rejects_empty_title() {
    let mut req = sample_request();
    req.title = "   ".to_string();
    assert!(checked_issue(&req).is_err());
}

#[test]
fn create_issue_payload_omits_empty_optional_fields() {
    let req = GithubCreateIssueRequest {
        cwd: "/repo".to_string(),
        repo: GithubRepoSlot::Origin,
        title: "Minimal issue".to_string(),
        body: String::new(),
        labels: Vec::new(),
        assignees: Vec::new(),
    };
    let checked = checked_issue(&req).unwrap();
    let payload: serde_json::Value =
        serde_json::from_slice(&create_issue_payload(&checked)).unwrap();
    assert_eq!(payload, serde_json::json!({ "title": "Minimal issue" }));
}

#[test]
fn create_issue_payload_trims_and_normalizes_assignees() {
    let checked = checked_issue(&sample_request()).unwrap();
    let payload: serde_json::Value =
        serde_json::from_slice(&create_issue_payload(&checked)).unwrap();
    assert_eq!(payload["title"], "Fix login refresh");
    assert_eq!(payload["body"], "Steps to reproduce\n- expire token");
    assert_eq!(payload["labels"], serde_json::json!(["bug"]));
    assert_eq!(payload["assignees"], serde_json::json!(["ridho"]));
}

#[test]
fn create_issue_args_and_response_parse() {
    let repo = GithubRepoRef {
        host: "github.com".to_string(),
        owner: "ridho".to_string(),
        name: "internity-be".to_string(),
    };
    assert_eq!(
        create_issue_args(&repo),
        vec!["api", "--method", "POST", "repos/ridho/internity-be/issues", "--input", "-"]
    );
    let result = parse_created_issue(
        br#"{"number":42,"html_url":"https://github.com/ridho/internity-be/issues/42","title":"Fix login refresh"}"#,
    )
    .unwrap();
    assert_eq!(result.number, 42);
    assert_eq!(result.url, "https://github.com/ridho/internity-be/issues/42");
    assert_eq!(result.title, "Fix login refresh");
}
