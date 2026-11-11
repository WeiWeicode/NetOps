-- C2(2026-11-11):每小時彙總表開去重視窗。
-- netops-ingest 重送同一批時,來源表依 insert_deduplication_token 略過;26.x 仍會把區塊推給物化檢視,
-- 寫入端帶 deduplicate_blocks_in_dependent_materialized_views=1 讓目標表用衍生 token 去重,目標表要有視窗才生效
-- (CI 整合測試:不設時同一 token 重送,原始表 2 筆、彙總 4)。
-- 注意:有視窗後,不帶 token 的寫入會依區塊內容雜湊去重;手動重建彙總(dedupe-day.sh)要帶 insert_deduplicate = 0。
-- migrations/ 由 apply-schema.sh 每次依序執行:必須可重複執行(MODIFY SETTING 重複執行沒有影響)。
ALTER TABLE netops.pa_traffic_hourly_app MODIFY SETTING non_replicated_deduplication_window = 1000;
ALTER TABLE netops.pa_traffic_hourly_src MODIFY SETTING non_replicated_deduplication_window = 1000;
