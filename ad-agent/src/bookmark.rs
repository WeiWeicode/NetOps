//! 本機水位 state\bookmarks.json(AD6、計畫 §3.3;審查 H4、M8)。
//!
//! - 每個 Channel 記錄已收到後端 200 的最後 RecordID(`lastRecordId`;含被過濾掉、不必送的事件)與世代 `logEpoch`
//! - 寫入是原子的:先寫 `.tmp` 並 flush 到磁碟,再改名取代(停電或被結束時只會留下舊檔或新檔)
//! - Event Log 被清除重編號(目前最大 RecordID < 水位)時 `logEpoch` 加 1、水位歸 0,並立即寫檔(H4)
//! - 沒有水位的 Channel(第一次安裝或 bookmarks.json 遺失)用 [`resolve_initial`] 決定起點

use crate::channel::Channel;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};

pub const FILE_NAME: &str = "bookmarks.json";
const FORMAT_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mark {
    pub log_epoch: u32,
    pub last_record_id: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileFormat {
    version: u32,
    channels: BTreeMap<String, Mark>,
    updated_at: String,
}

/// RecordID 被重設(H4):回報用
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResetInfo {
    pub channel: Channel,
    pub old_epoch: u32,
    pub new_epoch: u32,
    pub old_last_record_id: u64,
    pub newest_record_id: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Bookmarks {
    marks: BTreeMap<Channel, Mark>,
}

impl Bookmarks {
    pub fn get(&self, c: Channel) -> Option<Mark> {
        self.marks.get(&c).copied()
    }

    pub fn set(&mut self, c: Channel, m: Mark) {
        self.marks.insert(c, m);
    }

    pub fn iter(&self) -> impl Iterator<Item = (Channel, Mark)> + '_ {
        self.marks.iter().map(|(c, m)| (*c, *m))
    }

    /// 已 ACK 到 `through`(同一世代才前進;不會倒退)
    pub fn ack(&mut self, c: Channel, epoch: u32, through: u64) -> bool {
        match self.marks.get_mut(&c) {
            Some(m) if m.log_epoch == epoch && through > m.last_record_id => {
                m.last_record_id = through;
                true
            }
            _ => false,
        }
    }

    /// Channel 目前最大的 RecordID 比水位小:Event Log 被清除或重編號(H4)→ 世代加 1、水位歸 0
    pub fn detect_reset(&mut self, c: Channel, newest_record_id: u64) -> Option<ResetInfo> {
        let m = self.marks.get_mut(&c)?;
        if newest_record_id >= m.last_record_id {
            return None;
        }
        let info = ResetInfo {
            channel: c,
            old_epoch: m.log_epoch,
            new_epoch: m.log_epoch.saturating_add(1),
            old_last_record_id: m.last_record_id,
            newest_record_id,
        };
        *m = Mark {
            log_epoch: info.new_epoch,
            last_record_id: 0,
        };
        Some(info)
    }

    pub fn path(state_dir: &Path) -> PathBuf {
        state_dir.join(FILE_NAME)
    }

    /// 讀檔:沒有檔案回空的;內容壞掉時改名成 `.bad-<時間>` 保留現場並回空的(由 [`resolve_initial`] 重新決定起點)
    pub fn load(state_dir: &Path) -> Result<(Self, Option<String>), String> {
        let p = Self::path(state_dir);
        let text = match std::fs::read_to_string(&p) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok((Self::default(), None));
            }
            Err(e) => return Err(format!("讀不到 {}:{e}", p.display())),
        };
        match serde_json::from_str::<FileFormat>(&text) {
            Ok(f) if f.version == FORMAT_VERSION => {
                let marks = f
                    .channels
                    .iter()
                    .filter_map(|(k, m)| Channel::from_name(k).map(|c| (c, *m)))
                    .collect();
                Ok((Self { marks }, None))
            }
            _ => {
                let bad = p.with_extension(format!(
                    "bad-{}",
                    chrono::Local::now().format("%Y%m%d%H%M%S")
                ));
                std::fs::rename(&p, &bad)
                    .map_err(|e| format!("無法保留損壞的 {}:{e}", p.display()))?;
                Ok((
                    Self::default(),
                    Some(format!(
                        "{} 內容損壞,已改名為 {}",
                        p.display(),
                        bad.display()
                    )),
                ))
            }
        }
    }

    pub fn save(&self, state_dir: &Path) -> Result<(), String> {
        let f = FileFormat {
            version: FORMAT_VERSION,
            channels: self
                .marks
                .iter()
                .map(|(c, m)| (c.wire_name().to_string(), *m))
                .collect(),
            updated_at: chrono::Local::now().to_rfc3339(),
        };
        let text = serde_json::to_vec_pretty(&f).map_err(|e| e.to_string())?;
        write_atomic(&Self::path(state_dir), &text)
    }
}

/// 原子寫檔:先寫 `<檔名>.tmp` 並 flush 到磁碟,再改名取代(Windows:MoveFileExW REPLACE_EXISTING)
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    let write = || -> std::io::Result<()> {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&tmp, path)
    };
    write().map_err(|e| format!("無法寫入 {}:{e}", path.display()))
}

/// 後端記錄的該 Channel 最大世代與水位(心跳回應 `channels`;backend/src/infra/redis/ad-receiver.ts watermarks)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerMark {
    pub log_epoch: u32,
    pub last_record_id: u64,
}

/// 決定沒有本機水位的 Channel 從哪裡開始(bookmarks.json 遺失 / 第一次安裝):
///
/// - 後端有該 Channel 的紀錄(E, R):
///   - 目前最大 RecordID ≥ R:Event Log 沒被清除過 → 沿用世代 E,從 R 之後接著讀(不重送、不漏)
///   - 目前最大 RecordID < R:Agent 停機期間被清除過 → 世代 E+1,從「往回 N 分鐘」開始
/// - 後端沒有紀錄(第一次安裝,或 DC 停送超過 30 天水位已過期):世代 0,從「往回 N 分鐘」開始(M8)
///
/// `lookback_start` = 往回 N 分鐘內第一筆事件的 RecordID(沒有事件時 None → 從目前最新一筆之後開始)
pub fn resolve_initial(
    server: Option<ServerMark>,
    newest_record_id: u64,
    lookback_start: Option<u64>,
) -> Mark {
    let from_lookback = |epoch: u32| Mark {
        log_epoch: epoch,
        last_record_id: lookback_start.map_or(newest_record_id, |r| r.saturating_sub(1)),
    };
    match server {
        Some(s) if newest_record_id >= s.last_record_id => Mark {
            log_epoch: s.log_epoch,
            last_record_id: s.last_record_id,
        },
        Some(s) => from_lookback(s.log_epoch.saturating_add(1)),
        None => from_lookback(0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 水位寫檔再讀回_續傳從ack位置開始() {
        let d = tempfile::tempdir().unwrap();
        let mut b = Bookmarks::default();
        b.set(
            Channel::Security,
            Mark {
                log_epoch: 0,
                last_record_id: 100,
            },
        );
        b.set(
            Channel::DirectoryService,
            Mark {
                log_epoch: 2,
                last_record_id: 7,
            },
        );
        assert!(b.ack(Channel::Security, 0, 150));
        assert!(!b.ack(Channel::Security, 0, 120), "水位不倒退");
        assert!(
            !b.ack(Channel::Security, 1, 999),
            "不同世代的 ACK 不移動水位"
        );
        b.save(d.path()).unwrap();
        let text = std::fs::read_to_string(Bookmarks::path(d.path())).unwrap();
        assert!(text.contains("\"Directory_Service\"") && text.contains("\"logEpoch\": 2"));
        let (r, warn) = Bookmarks::load(d.path()).unwrap();
        assert!(warn.is_none());
        assert_eq!(
            r.get(Channel::Security),
            Some(Mark {
                log_epoch: 0,
                last_record_id: 150
            })
        );
        assert_eq!(r, b);
        assert!(!d.path().join("bookmarks.json.tmp").exists());
    }

    #[test]
    fn 沒有檔案回空的_壞檔改名保留() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(Bookmarks::load(d.path()).unwrap().0, Bookmarks::default());
        std::fs::write(Bookmarks::path(d.path()), "{oops").unwrap();
        let (b, warn) = Bookmarks::load(d.path()).unwrap();
        assert_eq!(b, Bookmarks::default());
        assert!(warn.unwrap().contains("損壞"));
        assert!(!Bookmarks::path(d.path()).exists());
    }

    #[test]
    fn recordid比水位小時log_epoch加1並寫進檔案() {
        let d = tempfile::tempdir().unwrap();
        let mut b = Bookmarks::default();
        b.set(
            Channel::Security,
            Mark {
                log_epoch: 3,
                last_record_id: 98_765_432,
            },
        );
        assert_eq!(
            b.detect_reset(Channel::Security, 98_765_432),
            None,
            "相等不算重設"
        );
        assert_eq!(b.detect_reset(Channel::Security, 98_800_000), None);
        let r = b.detect_reset(Channel::Security, 1).unwrap();
        assert_eq!(
            (r.old_epoch, r.new_epoch, r.old_last_record_id),
            (3, 4, 98_765_432)
        );
        assert_eq!(
            b.get(Channel::Security),
            Some(Mark {
                log_epoch: 4,
                last_record_id: 0
            })
        );
        b.save(d.path()).unwrap();
        assert_eq!(
            Bookmarks::load(d.path()).unwrap().0.get(Channel::Security),
            Some(Mark {
                log_epoch: 4,
                last_record_id: 0
            })
        );
        assert_eq!(
            b.detect_reset(Channel::System, 0),
            None,
            "沒有水位的 Channel 不處理"
        );
    }

    #[test]
    fn 第一次啟動往回讀_無後端紀錄時世代0() {
        assert_eq!(
            resolve_initial(None, 5000, Some(4200)),
            Mark {
                log_epoch: 0,
                last_record_id: 4199
            }
        );
        assert_eq!(
            resolve_initial(None, 5000, None),
            Mark {
                log_epoch: 0,
                last_record_id: 5000
            }
        );
    }

    #[test]
    fn 水位遺失時沿用後端世代_清除過則加1() {
        let s = ServerMark {
            log_epoch: 2,
            last_record_id: 4800,
        };
        assert_eq!(
            resolve_initial(Some(s), 5000, Some(4200)),
            Mark {
                log_epoch: 2,
                last_record_id: 4800
            }
        );
        assert_eq!(
            resolve_initial(Some(s), 4800, Some(4200)),
            Mark {
                log_epoch: 2,
                last_record_id: 4800
            }
        );
        assert_eq!(
            resolve_initial(Some(s), 30, Some(1)),
            Mark {
                log_epoch: 3,
                last_record_id: 0
            }
        );
    }
}
