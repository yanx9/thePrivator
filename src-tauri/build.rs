fn main() {
    tauri_build::build();
    #[cfg(target_os = "macos")]
    {
        // Unbundled dev/test executables need the same onedir runtime beside them.
        // Inside an .app, PyInstaller instead resolves Contents/Frameworks.
        let runtime = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries/_internal");
        println!("cargo:rerun-if-changed=binaries/_internal");
        let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
        // Cargo may put another crate-name directory between build/ and out/.
        let profile = out
            .ancestors()
            .find(|path| path.file_name() == Some(std::ffi::OsStr::new("build")))
            .and_then(std::path::Path::parent)
            .expect("Cargo profile directory");
        for dir in [profile.to_path_buf(), profile.join("deps")] {
            let link = dir.join("_internal");
            if runtime.exists() {
                std::fs::create_dir_all(&dir).expect("create Cargo runtime directory");
                // A restored cache can contain a symlink to a previous checkout.
                if link.is_symlink() && std::fs::read_link(&link).ok().as_ref() != Some(&runtime) {
                    std::fs::remove_file(&link).expect("remove stale runtime link");
                }
                if link.symlink_metadata().is_ok() {
                    continue;
                }
                std::os::unix::fs::symlink(&runtime, link).expect("link sidecar runtime");
            }
        }
    }
}
