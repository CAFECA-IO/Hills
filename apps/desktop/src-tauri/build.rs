fn main() {
    // 建置 commit（設定 → 個人「版本」，ui-spec v0.30）；不在 git 中建置時留空
    let sha = std::process::Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_owned())
        .unwrap_or_default();
    println!("cargo:rustc-env=HILLS_GIT_SHA={sha}");
    // 發佈通道（technical-design §12.1，D75）：CI 以 HILLS_CHANNEL=alpha 建置；本機建置留空
    let channel = std::env::var("HILLS_CHANNEL").unwrap_or_default();
    println!("cargo:rustc-env=HILLS_CHANNEL={channel}");
    println!("cargo:rerun-if-env-changed=HILLS_CHANNEL");
    println!("cargo:rerun-if-changed=../../../.git/HEAD");
    println!("cargo:rerun-if-changed=../../../.git/refs/heads");
    tauri_build::build()
}
