fn main() {
    tauri_build::build();
    #[cfg(target_os = "macos")]
    {
        // Unbundled dev/test executables need the same onedir runtime beside them.
        // Inside an .app, PyInstaller instead resolves Contents/Frameworks.
        let runtime = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries/_internal");
        println!("cargo:rerun-if-changed=binaries/_internal");
        let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
        let profile = out.ancestors().nth(3).expect("Cargo profile directory");
        for dir in [profile.to_path_buf(), profile.join("deps")] {
            let link = dir.join("_internal");
            if !link.exists() && runtime.exists() {
                std::os::unix::fs::symlink(&runtime, link).expect("link sidecar runtime");
            }
        }
    }
}
