use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

const LIBGHOSTTY_REVISION: &str = "426386b8579d5e558aa5d4cfdfb003ad06bc4fc5";

fn main() {
    println!("cargo:rerun-if-env-changed=SOLOE_LIBGHOSTTY_SOURCE");
    println!("cargo:rerun-if-changed=native-terminal/ghostty_vt_bridge.c");
    println!("cargo:rerun-if-changed=native-terminal/ghostty_vt_bridge.h");

    if env::var_os("CARGO_FEATURE_LIBGHOSTTY_LINUX_PROTOTYPE").is_some() {
        build_libghostty_linux_prototype();
    }

    tauri_build::build()
}

fn build_libghostty_linux_prototype() {
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("linux") {
        panic!("libghostty-linux-prototype currently supports Linux only");
    }

    let source = env::var_os("SOLOE_LIBGHOSTTY_SOURCE")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            panic!("SOLOE_LIBGHOSTTY_SOURCE must point to the pinned Ghostty checkout")
        });
    verify_revision(&source);

    let library = source.join("zig-out/lib/libghostty-vt.a");
    let headers = source.join("zig-out/include");
    if !library.is_file() || !headers.is_dir() {
        let status = Command::new("zig")
            .current_dir(&source)
            .args([
                "build",
                "-Demit-lib-vt",
                "-Dsimd=false",
                "-Doptimize=ReleaseFast",
            ])
            .status()
            .unwrap_or_else(|error| panic!("failed to start Zig for libghostty-vt: {error}"));
        assert!(status.success(), "failed to build pinned libghostty-vt");
    }

    cc::Build::new()
        .file("native-terminal/ghostty_vt_bridge.c")
        .include("native-terminal")
        .include(&headers)
        .define("GHOSTTY_STATIC", None)
        .warnings(true)
        .compile("soloe_ghostty_vt_bridge");

    println!(
        "cargo:rustc-link-search=native={}",
        source.join("zig-out/lib").display()
    );
    println!("cargo:rustc-link-lib=static=ghostty-vt");
    println!("cargo:rustc-link-lib=dylib=m");
}

fn verify_revision(source: &Path) {
    let output = Command::new("git")
        .current_dir(source)
        .args(["rev-parse", "HEAD"])
        .output()
        .unwrap_or_else(|error| panic!("failed to verify Ghostty revision: {error}"));
    assert!(
        output.status.success(),
        "Ghostty source is not a Git checkout"
    );
    let revision = String::from_utf8_lossy(&output.stdout);
    assert_eq!(
        revision.trim(),
        LIBGHOSTTY_REVISION,
        "Ghostty source revision does not match libghostty-source.json"
    );
}
