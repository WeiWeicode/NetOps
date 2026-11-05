# language: zh-TW
@F1
功能: 選單與頁面依權限顯示
  為了讓每個人只看到自己可以用的功能,而且沒有權限時不會卡在本系統
  身為 使用者
  我要選單依權限顯示,無權限時導回入口網或顯示 403

  # 依據:docs/UI-GUIDE.md §1、§5;ARCHITECTURE §5、D5、D11、D18;Gateway FRONTEND-GUIDE §7.4、§7.5.3;
  #       F1 程式(origin/feature/netops-f1-pa-dashboard:frontend/src/router.ts、composables/guard.ts、composables/apps.ts)。
  # 前端依權限隱藏只是體驗,BFF 一定再以 API 權限檢查(AGENT.md §7.1)。

  Rule: 應用層守衛

    # 來源: frontend/src/composables/guard.ts:29(origin/feature/netops-f1-pa-dashboard)
    @auto
    場景: 未登入時導向入口網登入頁
      假如 使用者尚未登入
      當 開啟 /netops/firewall/dashboard
      那麼 導向入口網 /login,登入後回到原頁

    # 來源: frontend/src/composables/guard.ts:30(origin/feature/netops-f1-pa-dashboard)
    @auto
    場景: 沒有應用權限時導回入口網
      假如 使用者已登入但沒有 "netops.app.access"
      當 開啟 /netops/ 下任何頁面
      那麼 整頁導回入口網 /?denied=netops
      而且 不停在本系統(避免導向迴圈)

    # 來源: frontend/src/composables/guard.ts:48(fix/d1-uat-findings)
    @auto @changed
    場景: 導向登入頁或入口網時不回報錯誤
      # D1 測試區每次未登入開頁,giga-observe 都多一筆 netops-web 空白訊息的錯誤(D1 驗收 2026-11-05 §4.4)
      假如 使用者尚未登入,或沒有 "netops.app.access"
      當 開啟 /netops/
      那麼 導向入口網,離開前維持「正在確認登入狀態」畫面
      而且 守衛中止第一次導覽不算錯誤,不回報 giga-observe
      但是 守衛丟出的其他例外照常回報

    # 來源: frontend/src/router.ts:236(origin/feature/netops-f1-pa-dashboard)
    @untested
    場景: BFF 無法連線時顯示維護頁
      假如 BFF 回應不是 401 的錯誤或無法連線
      當 開啟 /netops/firewall/dashboard
      那麼 顯示 /unavailable,不導向登入頁

  Rule: 選單

    # 來源: frontend/src/router.ts:38(origin/feature/netops-f1-pa-dashboard)
    @auto
    場景大綱: 功能頁需要選單權限與 API 讀取權限
      假如 使用者有 "netops.app.access" 與 "<選單權限>"
      而且 <是否> 擁有 "<API 權限>"
      那麼 側欄 <顯示> 「<功能頁>」

      例子:
        | 功能頁            | 選單權限                  | API 權限           | 是否 | 顯示   |
        | 流量總覽          | netops.pa-dashboard.read  | netops.pa.read     | 有   | 顯示   |
        | 流量總覽          | netops.pa-dashboard.read  | netops.pa.read     | 沒有 | 不顯示 |
        | 安全事件          | netops.pa-events.read     | netops.pa.read     | 有   | 顯示   |
        | Log 明細查詢(PA) | netops.pa-search.read     | netops.pa-log.read | 有   | 顯示   |
        | FTP Log 檔案(PA) | netops.pa-files.read      | netops.ftp.read    | 有   | 顯示   |
        | AD 事件總覽       | netops.ad-events.read     | netops.ad.read     | 有   | 顯示   |
        | Log 明細查詢(AD) | netops.ad-search.read     | netops.ad-log.read | 有   | 顯示   |
        | FTP Log 檔案(AD) | netops.ad-files.read      | netops.ftp.read    | 有   | 顯示   |
        | 知識庫            | netops.kb-page.read       | netops.kb.read     | 有   | 顯示   |

    # 來源: frontend/src/composables/menu.ts:1(origin/feature/netops-f1-pa-dashboard)
    @auto
    場景: 沒有任何可見功能的選單群組不顯示
      假如 使用者沒有「AD 網域」群組下任何功能頁的權限
      那麼 側欄不顯示「AD 網域」

    # 來源: frontend/src/router.ts:183(origin/feature/netops-f1-pa-dashboard)
    @auto @changed
    場景: 舊版 AI 問答與 Veeam 改為一般連結
      # D11、D17、D18:AI 不搬移,切換後舊版 IIS 留著提供 AI;Veeam 不再同步登入
      假如 使用者有 "netops.pa.read"
      那麼 「防火牆 PA-560」群組顯示「AI 問答(舊版)」連結,另開分頁到舊版 NetOps
      而且 「其他系統」群組顯示「Veeam 備份監控」連結,使用者在該系統另行登入

  Rule: 頁面守衛

    # 來源: frontend/src/composables/guard.ts:40(origin/feature/netops-f1-pa-dashboard)
    @auto
    場景: 直接開啟沒有權限的頁面顯示 403
      假如 使用者有 "netops.app.access",沒有 "netops.kb-page.read"
      當 直接開啟 /netops/knowledge
      那麼 導向 /netops/403

    # 來源: frontend/src/composables/guard.ts:36(origin/feature/netops-f1-pa-dashboard)
    @auto
    場景: 從首頁進入時改到第一個有權限的功能頁
      假如 使用者沒有「流量總覽」的權限,但有「AD 事件總覽」的權限
      當 開啟 /netops/
      那麼 導向 /netops/ad/events

    # 來源: frontend/src/composables/guard.ts:33(origin/feature/netops-f1-pa-dashboard)
    @auto @pending-ui
    場景: 目前 Tab 沒有權限時改到同頁第一個可看的 Tab
      # F1 第 1 批各頁還沒有 Tab(router.ts 註解);規則已在 guard 實作,等頁面加入 Tab 後驗證
      假如 某功能頁有兩個 Tab,使用者只有第二個 Tab 的權限
      當 開啟第一個 Tab 的網址
      那麼 改到第二個 Tab

    # 來源: frontend/src/router.ts:96(origin/feature/netops-f1-pa-dashboard)
    @pending-ui
    場景: 編輯按鈕依按鈕權限顯示
      # 按鈕權限 netops.pa-files.manage、netops.ad-files.manage、netops.kb-page.write(frontend/src/api/perms.ts)
      假如 使用者有「FTP Log 檔案」與「知識庫」的檢視權限,沒有 manage / write 按鈕權限
      那麼 不顯示同步、分析、刪除分析結果、新增 / 修改 / 刪除筆記的按鈕
      當 直接呼叫對應的寫入 API
      那麼 回應 403,code 為 "PERMISSION_DENIED"
