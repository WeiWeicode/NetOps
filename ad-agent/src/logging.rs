//! 檔案日誌 logs\<agent|watchdog>.log(單檔 5 MB,保留 1 個舊檔 .1)。一行一筆:時間、等級、訊息。
//! 不記 Token、事件內容與訊息全文(只記筆數、RecordID 與錯誤原因)。

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const MAX_BYTES: u64 = 5 * 1024 * 1024;

struct FileLogger {
    path: PathBuf,
    file: Mutex<Option<File>>,
    console: bool,
    secret: String,
}

fn open(path: &Path) -> Option<File> {
    OpenOptions::new().create(true).append(true).open(path).ok()
}

impl log::Log for FileLogger {
    fn enabled(&self, m: &log::Metadata) -> bool {
        m.level() <= log::Level::Info
    }

    fn log(&self, r: &log::Record) {
        if !self.enabled(r.metadata()) || !r.target().starts_with("netops_ad_agent") {
            return;
        }
        let mut msg = format!("{}", r.args());
        if !self.secret.is_empty() {
            msg = msg.replace(&self.secret, "***");
        }
        let line = format!(
            "{} {:<5} {}\r\n",
            chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%.3f%:z"),
            r.level(),
            msg
        );
        if self.console {
            eprint!("{line}");
        }
        let mut g = self.file.lock().unwrap_or_else(|e| e.into_inner());
        if g.as_ref()
            .and_then(|f| f.metadata().ok())
            .is_some_and(|m| m.len() > MAX_BYTES)
        {
            *g = None;
            let old = self.path.with_extension("log.1");
            let _ = std::fs::remove_file(&old);
            let _ = std::fs::rename(&self.path, &old);
        }
        if g.is_none() {
            *g = open(&self.path);
        }
        if let Some(f) = g.as_mut() {
            let _ = f.write_all(line.as_bytes());
        }
    }

    fn flush(&self) {
        if let Some(f) = self.file.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
            let _ = f.flush();
        }
    }
}

/// 初始化日誌;`secret`(Token)出現在訊息裡時一律遮掉
pub fn init(dir: &Path, name: &str, console: bool, secret: &str) {
    let _ = std::fs::create_dir_all(dir);
    let path = dir.join(format!("{name}.log"));
    let file = open(&path);
    let logger = FileLogger {
        path,
        file: Mutex::new(file),
        console,
        secret: secret.to_string(),
    };
    if log::set_boxed_logger(Box::new(logger)).is_ok() {
        log::set_max_level(log::LevelFilter::Info);
    }
}
