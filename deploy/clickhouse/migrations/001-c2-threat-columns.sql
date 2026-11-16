-- C2(2026-11-10):pa_threat_logs 補欄位。
--   session_id   $sessionid(CQ9 例外,和 pa_traffic_logs 相同;FTP 補漏逐筆去重)
--   sport        來源 Port(2026-11-10 威脅類 payload 補的 $sport)
--   nat_dport    目的 NAT Port($natdport)
-- migrations/ 由 apply-schema.sh 在 schema.sql 之後依檔名順序每次執行:每個檔都必須可重複執行(IF NOT EXISTS / IF EXISTS)。
ALTER TABLE netops.pa_threat_logs
    ADD COLUMN IF NOT EXISTS session_id UInt32 DEFAULT 0 AFTER seqno,
    ADD COLUMN IF NOT EXISTS sport UInt16 DEFAULT 0 AFTER to_zone,
    ADD COLUMN IF NOT EXISTS nat_dport UInt16 DEFAULT 0 AFTER dport;
