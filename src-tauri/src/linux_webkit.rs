use std::ffi::OsStr;
use std::fs;

const DMABUF_RENDERER_ENV: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
const DMI_ID_PATHS: [&str; 2] = [
    "/sys/class/dmi/id/sys_vendor",
    "/sys/class/dmi/id/product_name",
];

fn should_disable_dmabuf<I, S>(existing_value: Option<&OsStr>, dmi_values: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    existing_value.is_none()
        && dmi_values
            .into_iter()
            .any(|value| value.as_ref().to_ascii_lowercase().contains("vmware"))
}

fn renderer_overrides(
    dmi_values: &[String],
    existing: impl Fn(&str) -> Option<std::ffi::OsString>,
) -> Vec<&'static str> {
    [DMABUF_RENDERER_ENV, "WEBKIT_DISABLE_COMPOSITING_MODE"]
        .into_iter()
        .filter(|key| should_disable_dmabuf(existing(key).as_deref(), dmi_values))
        .collect()
}

/// Apply the two WebKitGTK workarounds confirmed on Linux Mint in VMware.
///
/// This must run before Tauri initializes GTK/WebKit. Each explicit user value
/// wins independently, and physical or unidentified hosts keep default rendering.
pub fn configure() {
    let dmi_values: Vec<String> = DMI_ID_PATHS
        .iter()
        .filter_map(|path| fs::read_to_string(path).ok())
        .collect();
    for key in renderer_overrides(&dmi_values, |key| std::env::var_os(key)) {
        std::env::set_var(key, "1");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    #[test]
    fn selects_both_workarounds_confirmed_on_mint_vmware() {
        assert_eq!(
            renderer_overrides(&["VMware, Inc.".to_owned()], |_| None),
            vec![
                "WEBKIT_DISABLE_DMABUF_RENDERER",
                "WEBKIT_DISABLE_COMPOSITING_MODE"
            ]
        );
    }

    #[test]
    fn respects_each_explicit_override_independently() {
        for chosen in [
            "WEBKIT_DISABLE_DMABUF_RENDERER",
            "WEBKIT_DISABLE_COMPOSITING_MODE",
        ] {
            let selected = renderer_overrides(&["vmware".to_owned()], |key| {
                (key == chosen).then(|| std::ffi::OsString::from("0"))
            });
            assert_eq!(selected.len(), 1);
            assert!(!selected.contains(&chosen));
        }
    }

    #[test]
    fn selects_nothing_for_physical_or_unidentified_hosts() {
        assert!(renderer_overrides(&["Framework".to_owned()], |_| None).is_empty());
        assert!(renderer_overrides(&[], |_| None).is_empty());
    }

    #[test]
    fn disables_dmabuf_for_vmware_when_the_user_has_not_chosen_a_value() {
        assert!(should_disable_dmabuf(
            None,
            ["VMware, Inc.", "VMware Virtual Platform"],
        ));
    }

    #[test]
    fn preserves_an_explicit_user_choice_on_vmware() {
        assert!(!should_disable_dmabuf(
            Some(OsStr::new("0")),
            ["VMware, Inc.", "VMware Virtual Platform"],
        ));
    }

    #[test]
    fn leaves_physical_hardware_on_the_default_renderer() {
        assert!(!should_disable_dmabuf(None, ["Framework", "Laptop 13"]));
    }
}
