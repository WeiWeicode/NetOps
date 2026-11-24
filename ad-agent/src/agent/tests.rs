//! 採集主迴圈測試(假 Event Log、假後端;計畫 §8 AD-2 完成標準:Bookmark 續傳、EventID 過濾、後端 503 不誤殺、log_epoch 加 1)

use super::*;
use crate::parser::tests::sample;
use std::collections::HashMap;
use std::sync::Mutex;

const T0: i64 = 1_795_151_112_000;

#[derive(Default)]
struct FakeLog {
    /// Channel → (RecordID, 時間 ms, EventID)
    events: HashMap<Channel, Vec<(u64, i64, u32)>>,
    absent: Vec<Channel>,
    /// 這些 RecordID 的 XML 給壞的(模擬無法解析)
    bad_xml: Vec<u64>,
    since_calls: Vec<(Channel, i64)>,
    /// 模擬覆寫中途 log_info 回傳偏小的假 newest_record_id(confirm_newest_record_id 仍回真實最大值;審查 M2)
    fake_log_info_newest: HashMap<Channel, u64>,
    confirm_calls: u32,
}

#[derive(Clone, Default)]
struct Source(Arc<Mutex<FakeLog>>);

impl Source {
    fn push(&self, c: Channel, rid: u64, t: i64, id: u32) {
        self.0
            .lock()
            .unwrap()
            .events
            .entry(c)
            .or_default()
            .push((rid, t, id));
    }
    /// 清除 Event Log:只剩一筆 1102(RecordID 從 1 開始)
    fn clear(&self, c: Channel, t: i64) {
        let mut g = self.0.lock().unwrap();
        g.events.insert(c, vec![(1, t, 1102)]);
    }
}

impl EventSource for Source {
    fn log_info(&mut self, c: Channel) -> Result<Option<LogInfo>, String> {
        let g = self.0.lock().unwrap();
        if g.absent.contains(&c) {
            return Ok(None);
        }
        let newest = g.fake_log_info_newest.get(&c).copied().unwrap_or_else(|| {
            g.events
                .get(&c)
                .and_then(|v| v.iter().map(|e| e.0).max())
                .unwrap_or(0)
        });
        Ok(Some(LogInfo {
            newest_record_id: newest,
            file_size: 20 * 1_048_576,
            max_size: Some(128 * 1_048_576),
        }))
    }
    fn confirm_newest_record_id(&mut self, c: Channel) -> Result<Option<u64>, String> {
        let mut g = self.0.lock().unwrap();
        g.confirm_calls += 1;
        if g.absent.contains(&c) {
            return Ok(None);
        }
        Ok(Some(
            g.events
                .get(&c)
                .and_then(|v| v.iter().map(|e| e.0).max())
                .unwrap_or(0),
        ))
    }
    fn read_after(&mut self, c: Channel, after: u64, max: usize) -> Result<Vec<RawEvent>, String> {
        let g = self.0.lock().unwrap();
        Ok(g.events
            .get(&c)
            .map(|v| {
                v.iter()
                    .filter(|e| e.0 > after)
                    .take(max)
                    .map(|e| RawEvent {
                        xml: if g.bad_xml.contains(&e.0) {
                            "<Event><broken".into()
                        } else {
                            sample(e.2, e.0, "0x8010000000000000", &[])
                        },
                        message: format!("msg {}", e.0),
                    })
                    .collect()
            })
            .unwrap_or_default())
    }
    fn first_record_since(&mut self, c: Channel, since_ms: i64) -> Result<Option<u64>, String> {
        let mut g = self.0.lock().unwrap();
        g.since_calls.push((c, since_ms));
        Ok(g.events
            .get(&c)
            .and_then(|v| v.iter().find(|e| e.1 >= since_ms).map(|e| e.0)))
    }
    fn oldest_event_ms(&mut self, c: Channel) -> Result<Option<i64>, String> {
        let g = self.0.lock().unwrap();
        Ok(g.events.get(&c).and_then(|v| v.iter().map(|e| e.1).min()))
    }
}

#[derive(Default)]
struct Server {
    /// 依序回應 /ad/v1/logs 的狀態碼(用完後 200)
    log_codes: VecDeque<u16>,
    /// 心跳回應的 channels
    marks: Value,
    /// 有值時心跳直接回這個 body(模擬缺 channels、型別不符的回應)
    hb_body: Option<Value>,
    /// 有值時心跳回這個狀態碼(例:接收端讀 Redis 水位失敗回 503)
    hb_code: Option<u16>,
    logs: Vec<Value>,
    heartbeats: Vec<Value>,
    down: bool,
}

#[derive(Clone, Default)]
struct Backend(Arc<Mutex<Server>>);

impl Transport for Backend {
    fn post(&mut self, path: &str, body: &Value) -> HttpResult {
        let mut g = self.0.lock().unwrap();
        if g.down {
            return HttpResult::Failed("connection refused".into());
        }
        if path == "/ad/v1/heartbeat" {
            g.heartbeats.push(body.clone());
            if let Some(code) = g.hb_code {
                return HttpResult::Status {
                    code,
                    body: Some(json!({ "code": "NETOPS_AD_UNAVAILABLE", "message": "暫時無法接收,請稍後重送" })),
                    retry_after_sec: None,
                };
            }
            if let Some(b) = g.hb_body.clone() {
                return HttpResult::Status {
                    code: 200,
                    body: Some(b),
                    retry_after_sec: None,
                };
            }
            let marks = if g.marks.is_null() {
                json!({})
            } else {
                g.marks.clone()
            };
            return HttpResult::Status {
                code: 200,
                body: Some(json!({ "ok": true, "channels": marks })),
                retry_after_sec: None,
            };
        }
        g.logs.push(body.clone());
        let code = g.log_codes.pop_front().unwrap_or(200);
        let body = if code == 200 {
            json!({ "accepted": body["events"].as_array().unwrap().len(), "duplicates": 0, "rejected": 0 })
        } else {
            json!({ "code": "NETOPS_AD_UNAVAILABLE", "message": "x" })
        };
        HttpResult::Status {
            code,
            body: Some(body),
            retry_after_sec: (code == 429).then_some(120),
        }
    }
}

fn settings(dir: &std::path::Path, channels: Vec<Channel>) -> AgentSettings {
    AgentSettings {
        computer: "GSMC-DC1".into(),
        domain: "gsmc.com.tw".into(),
        channels,
        state_dir: dir.to_path_buf(),
        initial_lookback_minutes: 60,
        include_user_logon_4624: false,
        batch_interval_ms: 4_000,
        heartbeat_interval_ms: 15_000,
        max_batch_events: 500,
    }
}

fn agent(
    dir: &std::path::Path,
    src: &Source,
    be: &Backend,
    channels: Vec<Channel>,
    now: i64,
) -> Agent<Source, Backend> {
    Agent::new(
        settings(dir, channels),
        src.clone(),
        be.clone(),
        Arc::new(SharedStatus::new(now)),
        now,
    )
    .unwrap()
}

fn seed(dir: &std::path::Path, c: Channel, epoch: u32, last: u64) {
    let mut b = Bookmarks::default();
    b.set(
        c,
        Mark {
            log_epoch: epoch,
            last_record_id: last,
        },
    );
    b.save(dir).unwrap();
}

fn sent_ids(be: &Backend, i: usize) -> Vec<(u64, u64)> {
    be.0.lock().unwrap().logs[i]["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| {
            (
                e["recordId"].as_u64().unwrap(),
                e["logEpoch"].as_u64().unwrap(),
            )
        })
        .collect()
}

#[test]
fn bookmark續傳_收到200才移動水位並寫檔() {
    let d = tempfile::tempdir().unwrap();
    let (src, be) = (Source::default(), Backend::default());
    seed(d.path(), Channel::Security, 0, 100);
    for r in 95..=103 {
        src.push(Channel::Security, r, T0, 4625);
    }
    let mut a = agent(d.path(), &src, &be, vec![Channel::Security], T0);
    a.step(T0);
    assert_eq!(
        sent_ids(&be, 0),
        vec![(101, 0), (102, 0), (103, 0)],
        "只送水位之後的事件"
    );
    assert_eq!(be.0.lock().unwrap().logs[0]["computer"], "GSMC-DC1");
    assert_eq!(
        Bookmarks::load(d.path())
            .unwrap()
            .0
            .get(Channel::Security)
            .unwrap()
            .last_record_id,
        103
    );

    // 重新啟動(新的 Agent 讀同一個 bookmarks.json)從 103 之後接著讀
    src.push(Channel::Security, 104, T0, 4740);
    let mut b = agent(d.path(), &src, &be, vec![Channel::Security], T0 + 10_000);
    b.step(T0 + 10_000);
    assert_eq!(sent_ids(&be, 1), vec![(104, 0)]);
}

#[test]
fn eventid過濾_被過濾掉的事件也推進水位但不送() {
    let d = tempfile::tempdir().unwrap();
    let (src, be) = (Source::default(), Backend::default());
    seed(d.path(), Channel::Security, 0, 10);
    src.push(Channel::Security, 11, T0, 4634); // 登出:不收
    src.push(Channel::Security, 12, T0, 4625);
    src.push(Channel::Security, 13, T0, 4769); // 服務票證:不收
    let mut a = agent(d.path(), &src, &be, vec![Channel::Security], T0);
    a.step(T0);
    assert_eq!(sent_ids(&be, 0), vec![(12, 0)]);
    assert_eq!(
        a.bookmarks().get(Channel::Security).unwrap().last_record_id,
        13
    );

    // 全部被過濾:不呼叫 /ad/v1/logs,水位照樣前進
    src.push(Channel::Security, 14, T0, 4634);
    a.step(T0 + 5_000);
    assert_eq!(be.0.lock().unwrap().logs.len(), 1);
    assert_eq!(
        a.bookmarks().get(Channel::Security).unwrap().last_record_id,
        14
    );
}

#[test]
fn 未ack前重送同一批_不加入新事件() {
    let d = tempfile::tempdir().unwrap();
    let (src, be) = (Source::default(), Backend::default());
    seed(d.path(), Channel::Security, 0, 0);
    src.push(Channel::Security, 1, T0, 4625);
    be.0.lock().unwrap().log_codes = VecDeque::from([503, 503]);
    let mut a = agent(d.path(), &src, &be, vec![Channel::Security], T0);
    a.step(T0);
    src.push(Channel::Security, 2, T0, 4625);
    let mut now = T0;
    while be.0.lock().unwrap().logs.len() < 3 {
        now += 1_000;
        a.step(now);
        assert!(now < T0 + 60_000, "退避後應重送");
    }
    assert_eq!(sent_ids(&be, 1), vec![(1, 0)], "重送同一批");
    assert_eq!(sent_ids(&be, 2), vec![(1, 0)]);
    assert_eq!(
        Bookmarks::load(d.path())
            .unwrap()
            .0
            .get(Channel::Security)
            .unwrap()
            .last_record_id,
        1,
        "200 後才移動水位"
    );
    a.step(now + 1_000);
    assert_eq!(sent_ids(&be, 3), vec![(2, 0)], "ACK 後才送新事件");
}

#[test]
fn 後端503或斷線時採集迴圈tick照常前進() {
    let d = tempfile::tempdir().unwrap();
    let (src, be) = (Source::default(), Backend::default());
    seed(d.path(), Channel::Security, 0, 0);
    src.push(Channel::Security, 1, T0, 4625);
    be.0.lock().unwrap().log_codes = VecDeque::from(vec![503; 1000]);
    let status = Arc::new(SharedStatus::new(T0));
    let mut a = Agent::new(
        settings(d.path(), vec![Channel::Security]),
        src.clone(),
        be.clone(),
        status.clone(),
        T0,
    )
    .unwrap();
    let mut wd = crate::watchdog::Monitor::new(T0);
    for k in 1..=300 {
        let now = T0 + k * 1_000;
        if k == 150 {
            be.0.lock().unwrap().down = true;
        }
        a.step(now);
        assert_eq!(status.last_tick(), now);
        if k % 15 == 0 {
            // Watchdog 每 15 秒看一次:tick 新鮮 → 不動作(M4:後端 503 不誤殺)
            let obs = crate::watchdog::Observation::running(
                4120,
                Ok(crate::watchdog::Probe {
                    pid: 4120,
                    last_collect_tick_ms: status.last_tick(),
                    tick_age_ms: None,
                }),
            );
            assert_eq!(wd.decide(&obs, now), crate::watchdog::Action::None);
        }
    }
    let s = status.snapshot();
    assert!(
        s.last_error.contains("連線失敗") || s.last_error.contains("503"),
        "{}",
        s.last_error
    );
    assert_eq!(s.pending_events, 1);
    assert_eq!(
        a.bookmarks().get(Channel::Security).unwrap().last_record_id,
        0
    );
}

#[test]
fn 第一次啟動往回讀60分鐘_後端沒有紀錄時世代0() {
    let d = tempfile::tempdir().unwrap();
    let (src, be) = (Source::default(), Backend::default());
    src.push(Channel::Security, 500, T0 - 3 * 3_600_000, 4625);
    src.push(Channel::Security, 600, T0 - 30 * 60_000, 4625);
    src.push(Channel::Security, 601, T0 - 10 * 60_000, 4740);
    let mut a = agent(d.path(), &src, &be, vec![Channel::Security], T0);
    a.step(T0);
    assert_eq!(
        src.0.lock().unwrap().since_calls,
        vec![(Channel::Security, T0 - 3_600_000)]
    );
    assert_eq!(sent_ids(&be, 0), vec![(600, 0), (601, 0)]);
    assert_eq!(
        Bookmarks::load(d.path()).unwrap().0.get(Channel::Security),
        Some(Mark {
            log_epoch: 0,
            last_record_id: 601
        })
    );
}

#[test]
fn 後端連不上時不決定起點_不送事件() {
    let d = tempfile::tempdir().unwrap();
    let (src, be) = (Source::default(), Backend::default());
    src.push(Channel::Security, 1, T0, 4625);
    be.0.lock().unwrap().down = true;
    let mut a = agent(d.path(), &src, &be, vec![Channel::Security], T0);
    for k in 0..20 {
        a.step(T0 + k * 1_000);
    }
    assert!(a.bookmarks().get(Channel::Security).is_none());
    assert!(be.0.lock().unwrap().logs.is_empty());
    be.0.lock().unwrap().down = false;
    for k in 20..40 {
        a.step(T0 + k * 1_000);
    }
    assert_eq!(sent_ids(&be, 0), vec![(1, 0)]);
}

#[test]
fn bookmarks遺失時以心跳回應的後端世代接續() {
    let d = tempfile::tempdir().unwrap();
    let (src, be) = (Source::default(), Backend::default());
    for r in 4795..=4805 {
        src.push(Channel::Security, r, T0 - 1_000, 4625);
    }
    be.0.lock().unwrap().marks = json!({ "Security": { "logEpoch": 2, "lastRecordId": 4800 } });
    let mut a = agent(d.path(), &src, &be, vec![Channel::Security], T0);
    a.step(T0);
    assert_eq!(
        sent_ids(&be, 0),
        (4801..=4805).map(|r| (r, 2)).collect::<Vec<_>>(),
        "沿用世代 2,從後端水位之後接續"
    );
}

#[test]
fn bookmarks遺失且期間清除過_世代加1() {
    let d = tempfile::tempdir().unwrap();
    let (src, be) = (Source::default(), Backend::default());
    src.push(Channel::Security, 1, T0 - 60_000, 1102);
    src.push(Channel::Security, 2, T0 - 50_000, 4625);
    be.0.lock().unwrap().marks = json!({ "Security": { "logEpoch": 2, "lastRecordId": 4800 } });
    let mut a = agent(d.path(), &src, &be, vec![Channel::Security], T0);
    a.step(T0);
    assert_eq!(sent_ids(&be, 0), vec![(1, 3), (2, 3)]);
    a.step(T0 + 15_000);
    let hb = be.0.lock().unwrap().heartbeats.last().unwrap().clone();
    assert_eq!(hb["watchdogEvents"][0]["type"], "log_record_id_reset");
    assert_eq!(hb["watchdogEvents"][0]["newEpoch"], 3);
}

#[test]
fn 執行中清除security_log時log_epoch加1並寫入bookmarks() {
    let d = tempfile::tempdir().unwrap();
    let (src, be) = (Source::default(), Backend::default());
    seed(d.path(), Channel::Security, 0, 0);
    for r in 1..=50 {
        src.push(Channel::Security, r, T0, 4625);
    }
    let mut a = agent(d.path(), &src, &be, vec![Channel::Security], T0);
    a.step(T0);
    assert_eq!(
        a.bookmarks().get(Channel::Security).unwrap(),
        Mark {
            log_epoch: 0,
            last_record_id: 50
        }
    );

    src.clear(Channel::Security, T0 + 1_000);
    a.step(T0 + 5_000);
    assert_eq!(
        sent_ids(&be, 1),
        vec![(1, 1)],
        "清除後的 1102 以世代 1 送出"
    );
    assert_eq!(
        Bookmarks::load(d.path()).unwrap().0.get(Channel::Security),
        Some(Mark {
            log_epoch: 1,
            last_record_id: 1
        })
    );
    a.step(T0 + 15_000);
    let hb = be.0.lock().unwrap().heartbeats.last().unwrap().clone();
    assert_eq!(hb["watchdogEvents"][0]["type"], "log_record_id_reset");
    assert_eq!(hb["watchdogEvents"][0]["oldEpoch"], 0);
    assert_eq!(hb["channels"]["Security"]["logEpoch"], 1);
    // 已上報的警告不重複送
    a.step(T0 + 30_000);
    assert_eq!(
        be.0.lock().unwrap().heartbeats.last().unwrap()["watchdogEvents"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
}

#[test]
fn 沒有dns角色時略過該channel() {
    let d = tempfile::tempdir().unwrap();
    let (src, be) = (Source::default(), Backend::default());
    src.0.lock().unwrap().absent.push(Channel::DnsServer);
    src.push(Channel::System, 7, T0 - 1_000, 7036);
    let mut a = agent(
        d.path(),
        &src,
        &be,
        vec![Channel::System, Channel::DnsServer],
        T0,
    );
    a.step(T0);
    assert_eq!(sent_ids(&be, 0), vec![(7, 0)]);
    a.step(T0 + 15_000);
    let hb = be.0.lock().unwrap().heartbeats.last().unwrap().clone();
    assert_eq!(hb["channels"]["DNS_Server"]["present"], false);
    assert_eq!(hb["channels"]["System"]["present"], true);
}

#[test]
fn 心跳帶security容量與wrap_risk() {
    let d = tempfile::tempdir().unwrap();
    let (src, be) = (Source::default(), Backend::default());
    seed(d.path(), Channel::Security, 0, 0);
    src.push(Channel::Security, 1, T0 - 10 * 3_600_000, 4625);
    let mut a = agent(d.path(), &src, &be, vec![Channel::Security], T0);
    a.step(T0);
    let hb = be.0.lock().unwrap().heartbeats[0].clone();
    let s = &hb["channels"]["Security"];
    assert_eq!(s["coverageHours"], 10.0);
    assert_eq!(s["wrapRisk"], true);
    assert_eq!(s["maxSizeMb"], 128.0);
    assert_eq!(hb["agentVersion"], "0.1.0");
    assert_eq!(hb["agent"]["statusOk"], true);
}

#[test]
fn wrap_risk以24小時為界() {
    assert_eq!(coverage(T0, T0 - 23 * 3_600_000), (23.0, true));
    assert_eq!(coverage(T0, T0 - 24 * 3_600_000), (24.0, false));
    assert_eq!(
        coverage(T0, T0 - 200 * 3_600_000 - 3_240_000),
        (200.9, false)
    );
}

#[test]
fn 退避_2到60秒_429依retry_after() {
    let mut b = Backoff::default();
    let delays: Vec<i64> = (0..8).map(|_| b.fail(0, None)).collect();
    assert_eq!(
        delays,
        vec![2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]
    );
    b.reset();
    assert!(b.ready(0));
    assert_eq!(b.fail(0, Some(120)), 120_000);
    assert_eq!(b.fail(0, Some(9_999)), 300_000);
}

#[test]
fn 一批不超過上限筆數() {
    let d = tempfile::tempdir().unwrap();
    let (src, be) = (Source::default(), Backend::default());
    seed(d.path(), Channel::Security, 0, 0);
    for r in 1..=1_200 {
        src.push(Channel::Security, r, T0, 4625);
    }
    let mut a = agent(d.path(), &src, &be, vec![Channel::Security], T0);
    a.step(T0);
    a.step(T0 + 1_000);
    a.step(T0 + 2_000);
    let g = be.0.lock().unwrap();
    assert_eq!(g.logs.len(), 3);
    assert_eq!(
        g.logs
            .iter()
            .map(|l| l["events"].as_array().unwrap().len())
            .collect::<Vec<_>>(),
        vec![500, 500, 200]
    );
}

#[test]
fn 心跳200但回應缺channels或格式錯誤時不決定起點() {
    for bad in [
        json!({ "ok": true }),
        json!({ "ok": true, "channels": [] }),
        json!({ "ok": true, "channels": { "Security": { "logEpoch": "2", "lastRecordId": 4800 } } }),
    ] {
        let d = tempfile::tempdir().unwrap();
        let (src, be) = (Source::default(), Backend::default());
        for r in 4795..=4805 {
            src.push(Channel::Security, r, T0 - 1_000, 4625);
        }
        be.0.lock().unwrap().hb_body = Some(bad.clone());
        let mut a = agent(d.path(), &src, &be, vec![Channel::Security], T0);
        for k in 0..20 {
            a.step(T0 + k * 1_000);
        }
        assert!(
            a.bookmarks().get(Channel::Security).is_none(),
            "不可當成後端沒有紀錄而以世代 0 開始:{bad}"
        );
        assert!(be.0.lock().unwrap().logs.is_empty());

        // 回應恢復正常後照後端世代接續
        {
            let mut g = be.0.lock().unwrap();
            g.hb_body = None;
            g.marks = json!({ "Security": { "logEpoch": 2, "lastRecordId": 4800 } });
        }
        for k in 20..40 {
            a.step(T0 + k * 1_000);
        }
        assert_eq!(
            sent_ids(&be, 0),
            (4801..=4805).map(|r| (r, 2)).collect::<Vec<_>>()
        );
    }
}

#[test]
fn 心跳channels是物件但沒有該channel時視為後端沒有紀錄() {
    assert!(parse_server_marks(Some(&json!({ "channels": {} }))).unwrap().is_empty());
    let m = parse_server_marks(Some(&json!({ "channels": { "Unknown": 1, "DNS_Server": { "logEpoch": 1, "lastRecordId": 7 } } }))).unwrap();
    assert_eq!(m.len(), 1);
    assert!(parse_server_marks(None).is_err());
}

#[test]
fn 後端持續4xx拒收時水位不動_心跳回報連續拒收次數與範圍() {
    let d = tempfile::tempdir().unwrap();
    let (src, be) = (Source::default(), Backend::default());
    seed(d.path(), Channel::Security, 0, 10);
    src.push(Channel::Security, 11, T0, 4625);
    be.0.lock().unwrap().log_codes = VecDeque::from([400; 10]);
    let mut a = agent(d.path(), &src, &be, vec![Channel::Security], T0);
    for k in 0..=15 {
        a.step(T0 + k * 1_000);
    }
    assert_eq!(
        a.bookmarks().get(Channel::Security).unwrap().last_record_id,
        10
    );
    let hb = be.0.lock().unwrap().heartbeats.last().unwrap().clone();
    let streak = hb["agent"]["sendRejectStreak"].as_u64().unwrap();
    assert!(streak >= 3, "{hb}");
    let err = hb["agent"]["lastError"].as_str().unwrap();
    assert!(err.contains("連續拒收") && err.contains("Security@0..11"), "{err}");

    // 恢復 200 後歸零
    be.0.lock().unwrap().log_codes.clear();
    for k in 16..=80 {
        a.step(T0 + k * 1_000);
    }
    let hb = be.0.lock().unwrap().heartbeats.last().unwrap().clone();
    assert_eq!(hb["agent"]["sendRejectStreak"], 0);
    assert_eq!(
        a.bookmarks().get(Channel::Security).unwrap().last_record_id,
        11
    );
}

#[test]
fn 無法解析的事件略過並計數_隨心跳上報() {
    let d = tempfile::tempdir().unwrap();
    let (src, be) = (Source::default(), Backend::default());
    seed(d.path(), Channel::Security, 0, 0);
    for r in 1..=3 {
        src.push(Channel::Security, r, T0, 4625);
    }
    src.0.lock().unwrap().bad_xml.push(2);
    let mut a = agent(d.path(), &src, &be, vec![Channel::Security], T0);
    a.step(T0);
    assert_eq!(sent_ids(&be, 0), vec![(1, 0), (3, 0)]);
    a.step(T0 + 15_000);
    let hb = be.0.lock().unwrap().heartbeats.last().unwrap().clone();
    assert_eq!(hb["agent"]["skippedEvents"], 1);
}

#[test]
fn 心跳503時不決定起點_恢復後照後端世代接續() {
    // 接收端讀 Redis 水位失敗回 503 NETOPS_AD_UNAVAILABLE(AD-1 2026-11-24 修正):Agent 不可當成「後端沒有紀錄」
    let d = tempfile::tempdir().unwrap();
    let (src, be) = (Source::default(), Backend::default());
    for r in 4795..=4805 {
        src.push(Channel::Security, r, T0 - 1_000, 4625);
    }
    be.0.lock().unwrap().hb_code = Some(503);
    let mut a = agent(d.path(), &src, &be, vec![Channel::Security], T0);
    for k in 0..40 {
        a.step(T0 + k * 1_000);
    }
    assert!(a.bookmarks().get(Channel::Security).is_none());
    assert!(be.0.lock().unwrap().logs.is_empty());
    assert!(be.0.lock().unwrap().heartbeats.len() >= 2, "下一次心跳照常重試");
    {
        let mut g = be.0.lock().unwrap();
        g.hb_code = None;
        g.marks = json!({ "Security": { "logEpoch": 2, "lastRecordId": 4800 } });
    }
    for k in 40..60 {
        a.step(T0 + k * 1_000);
    }
    assert_eq!(
        sent_ids(&be, 0),
        (4801..=4805).map(|r| (r, 2)).collect::<Vec<_>>()
    );
}

#[test]
fn 覆寫中途假newest小於水位_二次確認正常時不得觸發換世代() {
    // 模擬 Security Log 覆寫中途 log_info 回傳偏小值(小於水位 500),但反向查詢 confirm_newest_record_id 讀到真實最大 502(審查 M2)
    let d = tempfile::tempdir().unwrap();
    let (src, be) = (Source::default(), Backend::default());
    seed(d.path(), Channel::Security, 0, 500);
    for r in 495..=502 {
        src.push(Channel::Security, r, T0, 4625);
    }
    src.0
        .lock()
        .unwrap()
        .fake_log_info_newest
        .insert(Channel::Security, 480);
    let mut a = agent(d.path(), &src, &be, vec![Channel::Security], T0);
    a.step(T0);
    assert_eq!(src.0.lock().unwrap().confirm_calls, 1, "應呼叫二次確認");
    let mark = a.bookmarks().get(Channel::Security).unwrap();
    assert_eq!(mark.log_epoch, 0, "不可誤觸世代 +1");
    assert_eq!(mark.last_record_id, 502, "應正常送出 501、502 並前進水位");
    assert_eq!(sent_ids(&be, 0), vec![(501, 0), (502, 0)]);
    // 心跳不得帶 log_record_id_reset
    a.step(T0 + 15_000);
    let has_reset = be.0.lock().unwrap().heartbeats.iter().any(|hb| {
        hb["watchdogEvents"]
            .as_array()
            .is_some_and(|arr| arr.iter().any(|e| e["type"] == "log_record_id_reset"))
    });
    assert!(!has_reset, "覆寫中途假資料不應發出 log_record_id_reset");
}

#[test]
fn 整批全被過濾且尚未追上水位時立即接續掃描() {
    // 預設 max_batch_events=500、batch_interval_ms=4000:1..=600 是被過濾的 4624,601 是 4625(審查 M3)
    let d = tempfile::tempdir().unwrap();
    let (src, be) = (Source::default(), Backend::default());
    seed(d.path(), Channel::Security, 0, 0);
    for r in 1..=600 {
        src.push(Channel::Security, r, T0, 4624);
    }
    src.push(Channel::Security, 601, T0, 4625);
    let mut a = agent(d.path(), &src, &be, vec![Channel::Security], T0);
    // 第 1 秒:讀滿 500 筆全過濾,水位前進到 500,不送 HTTP,且 next_collect_ms 重設為 T0
    a.step(T0);
    assert_eq!(
        a.bookmarks().get(Channel::Security).unwrap().last_record_id,
        500
    );
    assert!(be.0.lock().unwrap().logs.is_empty());
    // 第 2 秒(未滿 4 秒週期):應立即接續讀完 501..=601 並送出 601
    a.step(T0 + 1_000);
    assert_eq!(sent_ids(&be, 0), vec![(601, 0)]);
    assert_eq!(
        a.bookmarks().get(Channel::Security).unwrap().last_record_id,
        601
    );
}
