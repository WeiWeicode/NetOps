//! Event Log 定位判斷(0.1.1,大型 Security Log 逾時修正)。與 Windows 無關的純函式,`winlog` 呼叫。
//!
//! 0.1.0 用 XPath `EventRecordID > N`、`timediff(...)` 篩選:Windows 從最舊一筆依序比對,
//! 3 GB 的 Security Log `EvtNext` 10 秒內找不到第一筆就逾時,而且每個週期重查一次(GSMC-DC1 實測 2026-11-25)。
//! 0.1.1 改成查詢不帶篩選(`*`),以書籤 `EvtSeek` 直接定位到水位;往回 60 分鐘用 RecordID 二分搜尋。
//! 書籤定位失敗(水位那一筆不存在)時,改用「第幾筆」(`EvtSeekRelativeToFirst`)二分搜尋,也不線性掃描。

/// 增量讀取的起點
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartPlan {
    /// 從最舊一筆讀(水位已被覆寫,或 Log 回報不出最舊 RecordID)
    FromOldest,
    /// 以書籤定位到這一筆(水位本身),讀到後丟掉 ≤ 水位的事件
    AtRecord(u64),
}

/// `after` = 水位(已讀到的最後 RecordID),`oldest` = Log 目前最舊一筆的 RecordID(0 = 不明或沒有事件)
///
/// - 水位 0(世代剛重設或從頭讀):從最舊一筆
/// - 水位比最舊一筆還小(已被覆寫):從最舊一筆,不必略過任何事件;跳號由既有行為處理(與 0.1.0 `EventRecordID > N` 結果相同)
/// - 其他(含最舊不明):定位到水位那一筆;定位失敗由呼叫端改用第幾筆二分搜尋
pub fn plan_start(after: u64, oldest: u64) -> StartPlan {
    if after == 0 || (oldest != 0 && after < oldest) {
        StartPlan::FromOldest
    } else {
        StartPlan::AtRecord(after)
    }
}

/// 一次 `read_after` 結束的原因
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadEnd {
    /// 讀到結尾(ERROR_NO_MORE_ITEMS)
    Exhausted,
    /// 讀滿 max 筆
    Full,
    /// `EvtNext` 逾時
    TimedOut,
    /// 略過 ≤ 水位的事件達上限(定位失敗、從最舊一筆找水位時)
    SkipBudget,
    /// 其他錯誤
    Failed,
}

/// 保留的查詢連續幾次「逾時且一筆都沒讀到」就丟掉重開
pub const MAX_EMPTY_TIMEOUTS: u32 = 3;

/// 讀完後是否保留查詢(下個週期水位相同就接著讀,不重新查詢、不重新掃描)。
/// `empty_timeouts` = 含這次在內,連續逾時且沒讀到事件的次數
pub fn keep_cursor(end: ReadEnd, empty_timeouts: u32) -> bool {
    match end {
        ReadEnd::Full | ReadEnd::SkipBudget => true,
        ReadEnd::TimedOut => empty_timeouts < MAX_EMPTY_TIMEOUTS,
        ReadEnd::Exhausted | ReadEnd::Failed => false,
    }
}

/// 沿用保留的查詢卻一筆都沒讀到(呼叫端只在最新 RecordID > 水位時才讀,所以讀到結尾也算異常,
/// 例:等待期間 Log 被清除或覆寫):當次重新定位一次
pub fn should_reopen(reused: bool, got_events: bool, end: ReadEnd) -> bool {
    reused && !got_events && matches!(end, ReadEnd::Exhausted | ReadEnd::Failed)
}

/// 保留的查詢能不能接著用:查詢停在 `cursor_after` 之後,這次要讀 `after` 之後
pub fn can_reuse(cursor_after: Option<u64>, after: u64) -> bool {
    cursor_after == Some(after)
}

/// `EvtCreateBookmark` 用的書籤 XML(指到 `record_id` 那一筆)
pub fn bookmark_xml(log_name: &str, record_id: u64) -> String {
    let mut name = String::with_capacity(log_name.len());
    for ch in log_name.chars() {
        match ch {
            '&' => name.push_str("&amp;"),
            '<' => name.push_str("&lt;"),
            '>' => name.push_str("&gt;"),
            '\'' => name.push_str("&apos;"),
            '"' => name.push_str("&quot;"),
            c => name.push(c),
        }
    }
    format!(
        "<BookmarkList><Bookmark Channel='{name}' RecordId='{record_id}' IsCurrent='true'/></BookmarkList>"
    )
}

/// `[lo, hi)` 中第一個讓 `pred` 成立的值(`pred` 須單調:先 false 後 true);都不成立回 `hi`。
/// 讀取次數約 log2(hi - lo)。
pub fn lower_bound<E>(
    lo: u64,
    hi: u64,
    mut pred: impl FnMut(u64) -> Result<bool, E>,
) -> Result<u64, E> {
    let (mut lo, mut hi) = (lo, hi);
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        if pred(mid)? {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    Ok(lo)
}

/// 書籤定位失敗時的退路:依「第幾筆」(0 起算,共 `count` 筆)二分搜尋第一筆 RecordID > `after` 的位置。
/// 同一個 Log 內 RecordID 隨位置遞增,有跳號也成立。回傳往前退 [`POSITION_MARGIN`] 筆的位置
/// (搜尋期間 Log 被覆寫、位置往前移時不漏讀;多讀的由呼叫端丟掉 ≤ 水位的事件)。
pub fn seek_position_after<E>(
    count: u64,
    after: u64,
    id_at: impl FnMut(u64) -> Result<u64, E>,
) -> Result<u64, E> {
    let mut id_at = id_at;
    let pos = lower_bound(0, count, |p| Ok(id_at(p)? > after))?;
    Ok(pos.saturating_sub(POSITION_MARGIN))
}

/// 第幾筆定位往前多退的筆數
pub const POSITION_MARGIN: u64 = 256;

/// 首次啟動往回讀:時間 ≥ `since_ms` 的第一筆 RecordID(沒有就 None)。
///
/// 在 `[oldest, newest]` 依 RecordID 二分搜尋,`time_at(id)` 讀那一筆的時間;最多約 log2(筆數) + 1 次
/// (500 萬筆約 24 次),不掃整個 Log。假設 TimeCreated 大致隨 RecordID 遞增(Event Log 依寫入順序編號)。
pub fn first_id_since<E>(
    oldest: u64,
    newest: u64,
    since_ms: i64,
    mut time_at: impl FnMut(u64) -> Result<i64, E>,
) -> Result<Option<u64>, E> {
    let oldest = oldest.max(1);
    if newest == 0 || newest < oldest {
        return Ok(None);
    }
    if time_at(newest)? < since_ms {
        return Ok(None);
    }
    // time(newest) ≥ since_ms,答案在 [oldest, newest]
    lower_bound(oldest, newest, |id| Ok(time_at(id)? >= since_ms)).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 起點_水位在log內就定位到水位() {
        assert_eq!(plan_start(500, 100), StartPlan::AtRecord(500));
        assert_eq!(plan_start(100, 100), StartPlan::AtRecord(100));
    }

    #[test]
    fn 起點_水位已被覆寫就從最舊一筆() {
        assert_eq!(plan_start(99, 100), StartPlan::FromOldest);
        assert_eq!(plan_start(1, 129_145), StartPlan::FromOldest);
    }

    #[test]
    fn 起點_水位0從最舊一筆_最舊不明仍定位到水位() {
        assert_eq!(plan_start(0, 100), StartPlan::FromOldest);
        assert_eq!(plan_start(0, 0), StartPlan::FromOldest);
        // 取不到最舊 RecordID 時不從最舊一筆找水位(大型 Log 會卡住;審查 3)
        assert_eq!(plan_start(500, 0), StartPlan::AtRecord(500));
    }

    #[test]
    fn 逾時與讀滿保留查詢_讀完與錯誤丟掉() {
        assert!(keep_cursor(ReadEnd::TimedOut, 1));
        assert!(keep_cursor(ReadEnd::Full, 0));
        assert!(keep_cursor(ReadEnd::SkipBudget, 0));
        assert!(!keep_cursor(ReadEnd::Exhausted, 0));
        assert!(!keep_cursor(ReadEnd::Failed, 0));
    }

    #[test]
    fn 連續空逾時達上限就丟掉查詢() {
        assert!(keep_cursor(ReadEnd::TimedOut, MAX_EMPTY_TIMEOUTS - 1));
        assert!(!keep_cursor(ReadEnd::TimedOut, MAX_EMPTY_TIMEOUTS));
    }

    #[test]
    fn 沿用查詢卻讀不到才當次重新定位() {
        assert!(should_reopen(true, false, ReadEnd::Exhausted));
        assert!(should_reopen(true, false, ReadEnd::Failed));
        assert!(!should_reopen(true, true, ReadEnd::Exhausted));
        assert!(!should_reopen(false, false, ReadEnd::Exhausted));
        assert!(!should_reopen(true, false, ReadEnd::TimedOut));
        assert!(!should_reopen(true, false, ReadEnd::Full));
    }

    #[test]
    fn 二分搜尋上下界() {
        assert_eq!(lower_bound::<()>(0, 10, |x| Ok(x >= 7)), Ok(7));
        assert_eq!(lower_bound::<()>(0, 10, |_| Ok(true)), Ok(0));
        assert_eq!(lower_bound::<()>(0, 10, |_| Ok(false)), Ok(10));
        assert_eq!(lower_bound::<()>(5, 5, |_| panic!("不應讀取")), Ok(5));
    }

    #[test]
    fn 依位置找水位_有跳號也找得到並往前多退() {
        // 位置 p 的 RecordID:1000 起,位置 5000 之後跳號 +100
        let id_at = |p: u64| -> Result<u64, ()> { Ok(if p < 5000 { 1000 + p } else { 1100 + p }) };
        let mut probes = 0;
        let pos = seek_position_after(1_000_000, 6_050, |p| {
            probes += 1;
            id_at(p)
        })
        .unwrap();
        // 位置 4999 是 RecordID 5999,位置 5000 是 6100:第一筆 > 6050 在位置 5000
        assert_eq!(pos, 5000 - POSITION_MARGIN);
        assert!(probes <= 21, "probes = {probes}");
        // 水位比全部都舊 → 位置 0;比全部都新 → count 往前退
        assert_eq!(seek_position_after(100, 0, id_at), Ok(0));
        assert_eq!(
            seek_position_after(1000, u64::MAX, id_at),
            Ok(1000 - POSITION_MARGIN)
        );
        assert_eq!(seek_position_after(0, 5, id_at), Ok(0));
    }

    #[test]
    fn 水位相同才接著用保留的查詢() {
        assert!(can_reuse(Some(10), 10));
        assert!(!can_reuse(Some(10), 9));
        assert!(!can_reuse(Some(10), 11));
        assert!(!can_reuse(None, 10));
    }

    #[test]
    fn 書籤xml() {
        assert_eq!(
            bookmark_xml("Security", 129_145),
            "<BookmarkList><Bookmark Channel='Security' RecordId='129145' IsCurrent='true'/></BookmarkList>"
        );
        assert!(bookmark_xml("Directory Service", 1).contains("Channel='Directory Service'"));
        assert!(bookmark_xml("a'b&<", 1).contains("Channel='a&apos;b&amp;&lt;'"));
    }

    /// 假 Log:RecordID oldest..=newest,每筆間隔 step 毫秒,記錄讀了哪幾筆
    fn log(oldest: u64, step: i64) -> impl Fn(u64) -> i64 {
        move |id| (id - oldest) as i64 * step
    }

    #[test]
    fn 往回找_找到第一筆時間不早於since() {
        let t = log(1000, 10);
        let mut probes = 0;
        let r = first_id_since::<()>(1000, 2000, 555, |id| {
            probes += 1;
            Ok(t(id))
        });
        // 時間 (id-1000)*10 ≥ 555 → id ≥ 1055.5 → 1056
        assert_eq!(r, Ok(Some(1056)));
        assert!(probes <= 12, "probes = {probes}");
    }

    #[test]
    fn 往回找_全部都在since之後回最舊一筆() {
        let r = first_id_since::<()>(1000, 2000, -1, |id| Ok(log(1000, 10)(id)));
        assert_eq!(r, Ok(Some(1000)));
    }

    #[test]
    fn 往回找_全部都在since之前回none() {
        let r = first_id_since::<()>(1000, 2000, 1_000_000, |id| Ok(log(1000, 10)(id)));
        assert_eq!(r, Ok(None));
    }

    #[test]
    fn 往回找_since剛好等於某筆時間() {
        let r = first_id_since::<()>(1000, 2000, 500, |id| Ok(log(1000, 10)(id)));
        assert_eq!(r, Ok(Some(1050)));
    }

    #[test]
    fn 往回找_空log與只有一筆() {
        assert_eq!(
            first_id_since::<()>(0, 0, 0, |_| panic!("不應讀取")),
            Ok(None)
        );
        assert_eq!(
            first_id_since::<()>(5, 4, 0, |_| panic!("不應讀取")),
            Ok(None)
        );
        assert_eq!(first_id_since::<()>(7, 7, 0, |_| Ok(10)), Ok(Some(7)));
        assert_eq!(first_id_since::<()>(7, 7, 11, |_| Ok(10)), Ok(None));
        // 最舊不明(0)當成 1
        assert_eq!(
            first_id_since::<()>(0, 3, 0, |id| Ok(id as i64)),
            Ok(Some(1))
        );
    }

    #[test]
    fn 往回找_大型log讀取次數是對數級() {
        // DC1 量級:最舊 RecordID 約 1 億、500 萬筆、24 小時
        let oldest = 100_000_000u64;
        let newest = oldest + 5_000_000;
        let step = 86_400_000 / 5_000_000; // 約 17 毫秒一筆
        let since = (newest - oldest) as i64 * step - 3_600_000; // 往回 60 分鐘
        let mut probes = 0;
        let r = first_id_since::<()>(oldest, newest, since, |id| {
            probes += 1;
            Ok((id - oldest) as i64 * step)
        })
        .unwrap()
        .unwrap();
        assert!((r - oldest) as i64 * step >= since);
        assert!((r - 1 - oldest) as i64 * step < since);
        assert!(probes <= 25, "probes = {probes}");
    }

    #[test]
    fn 往回找_讀取失敗就回錯誤() {
        let r = first_id_since(1, 100, 0, |id| if id == 100 { Ok(5) } else { Err("x") });
        assert_eq!(r, Err("x"));
    }
}
