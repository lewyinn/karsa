use std::fs;

use super::discover::git_discover_repos;

#[test]
fn discovers_nested_frontend_and_backend_repos() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fs::create_dir_all(root.join("frontend/.git")).unwrap();
    fs::create_dir_all(root.join("backend/.git")).unwrap();
    fs::create_dir_all(root.join("docs")).unwrap();
    fs::create_dir_all(root.join("node_modules/fake-pkg/.git")).unwrap();

    let repos = git_discover_repos(root.to_str().unwrap(), None).unwrap();
    let rels: Vec<&str> = repos.iter().map(|r| r.relative_path.as_str()).collect();
    assert_eq!(rels, vec!["backend", "frontend"]);
    assert!(repos.iter().all(|r| !r.is_root));
}

#[test]
fn discovers_root_repo_first_and_nested_depth_two_repo() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fs::create_dir_all(root.join(".git")).unwrap();
    fs::create_dir_all(root.join("services/api/.git")).unwrap();
    // Depth 3 should not be scanned under default depth 2.
    fs::create_dir_all(root.join("a/b/c/.git")).unwrap();

    let repos = git_discover_repos(root.to_str().unwrap(), None).unwrap();
    let rels: Vec<&str> = repos.iter().map(|r| r.relative_path.as_str()).collect();
    assert_eq!(rels, vec!["", "services/api"]);
    assert!(repos[0].is_root);
    assert!(!repos[1].is_root);
}

#[test]
fn recognizes_git_file_for_worktrees() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fs::create_dir_all(root.join("frontend")).unwrap();
    fs::write(root.join("frontend/.git"), "gitdir: /somewhere/else").unwrap();

    let repos = git_discover_repos(root.to_str().unwrap(), None).unwrap();
    assert_eq!(repos.len(), 1);
    assert_eq!(repos[0].relative_path, "frontend");
}

#[test]
fn returns_empty_when_no_git_repos_exist() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("notes")).unwrap();

    let repos = git_discover_repos(dir.path().to_str().unwrap(), None).unwrap();
    assert!(repos.is_empty());
}
