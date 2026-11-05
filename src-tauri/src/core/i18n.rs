//! Language of messages the backend shows (errors, notes). The frontend sets it from the UI
//! language; Chinese until it does.

use std::sync::atomic::{AtomicBool, Ordering};

static ENGLISH: AtomicBool = AtomicBool::new(false);

pub fn set(lang: &str) {
    ENGLISH.store(lang == "en", Ordering::Relaxed);
}

pub fn english() -> bool {
    ENGLISH.load(Ordering::Relaxed)
}

/// `tr!("中文 {x}", "English {x}")` formats whichever matches the current language. Both strings
/// are format strings with the same placeholders (captured from the caller, or passed after them).
#[macro_export]
macro_rules! tr {
    ($zh:literal, $en:literal $(,)?) => {
        if $crate::core::i18n::english() { format!($en) } else { format!($zh) }
    };
    ($zh:literal, $en:literal, $($arg:tt)+) => {
        if $crate::core::i18n::english() { format!($en, $($arg)+) } else { format!($zh, $($arg)+) }
    };
}

#[cfg(test)]
mod tests {
    #[test]
    fn picks_the_language_and_fills_captured_names() {
        let id = "/x";
        super::set("en");
        assert_eq!(crate::tr!("没有这个项目：{id}", "No such project: {id}"), "No such project: /x");
        super::set("zh");
        assert_eq!(crate::tr!("没有这个项目：{id}", "No such project: {id}"), "没有这个项目：/x");
        assert_eq!(crate::tr!("有 {} 个文件", "{} files", 3), "有 3 个文件");
    }
}
