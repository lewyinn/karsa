use super::create_pr::{checked_pr, create_pr_args, create_pr_payload, parse_created_pr};
use super::types::{GithubCreatePrRequest, GithubRepoRef, GithubRepoSlot};

fn sample_request() -> GithubCreatePrRequest {
    GithubCreatePrRequest {
        cwd: "/work/repo".to_string(),
        repo: GithubRepoSlot::Origin,
        title: "feat: add multi-repo PR support".to_string(),
        body: "## Summary\n- Adds PR creation dialog".to_string(),
        head: "feat/pr-dialog".to_string(),
        base: "main".to_string(),
        draft: false,
    }
}

#[test]
fn checked_pr_rejects_empty_title_or_same_branch() {
    let mut req = sample_request();
    req.title = "   ".to_string();
    assert!(checked_pr(&req).is_err());

    let mut same = sample_request();
    same.head = "main".to_string();
    same.base = "main".to_string();
    assert!(checked_pr(&same).is_err());
}

#[test]
fn create_pr_payload_handles_draft_and_optional_body() {
    let mut req = sample_request();
    req.body = "".to_string();
    req.draft = true;
    let checked = checked_pr(&req).expect("valid pr");
    let json: serde_json::Value = serde_json::from_slice(&create_pr_payload(&checked)).unwrap();
    assert_eq!(json["title"], "feat: add multi-repo PR support");
    assert_eq!(json["head"], "feat/pr-dialog");
    assert_eq!(json["base"], "main");
    assert_eq!(json["draft"], true);
    assert!(json.get("body").is_none());
}

#[test]
fn create_pr_args_and_response_parse() {
    let repo = GithubRepoRef {
        host: "github.com".to_string(),
        owner: "lewyinn".to_string(),
        name: "karsa".to_string(),
    };
    assert_eq!(
        create_pr_args(&repo),
        vec!["api", "--method", "POST", "repos/lewyinn/karsa/pulls", "--input", "-"]
    );
    let parsed = parse_created_pr(
        br#"{"number":12,"html_url":"https://github.com/lewyinn/karsa/pull/12","title":"PR Title"}"#,
    )
    .expect("parse");
    assert_eq!(parsed.number, 12);
    assert_eq!(parsed.url, "https://github.com/lewyinn/karsa/pull/12");
    assert_eq!(parsed.title, "PR Title");
}
