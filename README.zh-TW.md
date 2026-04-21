[English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md)

# Engram 🧠

**你的 AI 代理每次對話結束就全忘了。Engram 解決這個問題。**

Engram 為你的 [OpenClaw](https://github.com/openclaw/openclaw) 代理提供持久記憶——它們會記住你說過的話、做過的決定、學到的東西，跨越每一次對話、每一個頻道。多個代理之間甚至能自動共享知識。

一切都在你的本機運行。不需要雲端 API，資料不會離開你的網路。屬於 [Cortex](https://github.com/maiyangyun/engram#part-of-cortex) 產品家族的一員。

---

## 問題在哪

AI 代理就像金魚，每次對話都從零開始。

你告訴代理你偏好 PostgreSQL 而不是 MySQL。下一次對話，它推薦 MySQL。你花了二十分鐘帶代理走過一遍你的部署流程。隔天，它完全不記得你怎麼部署的。你們一起做了一個關鍵的架構決策——推理過程、權衡取捨、最終結論——對話一結束，全部消失。

多代理的情況更慘。你有三個代理分別負責專案的不同部分。其中一個學到了重要資訊——比如 staging 伺服器換了新 IP。另外兩個？完全不知道。你變成了自己代理之間的傳話筒，一遍又一遍重複同樣的事。

這不是小麻煩，而是從根本上限制了代理的能力。沒有記憶，每個代理永遠都是新手。

---

## 為什麼要做 Engram

OpenClaw 本身就有記憶功能——而且堪用。你可以設定 `dmScope` 讓對話上下文跨頻道共享，代理也可以把筆記寫進 `memory/YYYY-MM-DD.md` 這類 Markdown 檔案。簡單的場景下，這些通常就夠了。

但當我們開始在真實專案中跑多個代理，問題就浮現了。

**Token 問題。** 跨頻道共享完整對話上下文，代表你的代理什麼都記得——但代價是每則訊息都要帶上整段歷史紀錄。Token 成本飆得很快。你真正需要的是選擇性回憶：只在需要的時候，精準注入相關的片段。

**「記得要記」的問題。** Markdown 日誌能用，但它仰賴某個人——你或代理——主動決定把東西寫下來。實際上，重要的決策常常就這樣溜走了。代理給了一個很棒的架構建議，你們繼續往下聊，沒人記錄。一週後，什麼都不剩。記憶不應該需要手動操作，代理應該自己判斷什麼值得記住。

**多代理的斷層。** 當你有多個代理，問題成倍放大。代理 A 學會了你的部署流程，代理 B 完全不知道。內建機制沒辦法讓代理之間共享知識，同時又保持各自的私有記憶。

我們看了現有的方案。[Mem0](https://github.com/mem0ai/mem0) 是最有潛力的——設計良好的記憶層，搭配 LLM 驅動的提取。我們試過 OpenClaw 的 Mem0 外掛，從中學到很多，也尊重這個作品。但它不太符合我們的需求：

- **雲端依賴。** Mem0 的平台會把你的資料送到他們的伺服器。對於處理敏感專案資訊的團隊來說，這是硬傷。
- **單代理設計。** Mem0 是圍繞一個使用者和一個代理來設計的。它沒有組織、專案或多代理可見性規則的概念。
- **回憶控制有限。** 我們需要對回憶的內容和時機有細緻的控制——分數門檻、智慧截斷、短訊息處理——在不丟失重要上下文的前提下壓低 token 成本。

所以我們做了 Engram。它完全在你的機器上運行，支援多代理並有適當的隔離與共享機制，而且自動處理記憶——擷取、回憶、去重，都不需要你操心。

我們還在持續迭代。Engram 還很年輕，有很多可以改進的地方。但它已經解決了驅使我們打造它的那些問題，而且我們每天都在用。

---

## Engram 做了什麼

Engram 在背景安靜地運行，幫你處理記憶：

- **代理會記住。** 偏好、決策、專案脈絡、技術細節——聊過一次就記住了。你的代理會隨著時間累積真正的專業知識。
- **代理會分享。** 當一個代理學到新東西，同組織的其他代理也能存取。不用手動複製，不用重複解釋。
- **資料留在你手上。** 所有資料都存在本機的 SQLite 資料庫。嵌入向量透過你機器上的 Ollama 生成。除非你主動選擇雲端模型，否則什麼都不會離開你的網路。
- **到處都能用。** Webchat、飛書、Telegram、Discord——隨意切換頻道，代理的記憶跟著走。

---

## 實際效果

**沒有 Engram：**
> **你：** 這個專案用 PostgreSQL，不要 MySQL。
> **代理：** 收到，我會用 PostgreSQL。
>
> *（下一次對話）*
>
> **你：** 把資料庫建起來。
> **代理：** 好的！你想用哪個資料庫——MySQL、PostgreSQL 還是 SQLite？

**有 Engram：**
> **你：** 把資料庫建起來。
> **代理：** 用 PostgreSQL 建，因為這是你的偏好。要不要沿用 Bonbon 專案的 schema 模式？

---

**沒有 Engram：**
> **代理 A** *（學到了）：* 團隊決定用 GitHub Actions 部署，不再手動 SSH。
>
> *（稍後，另一個代理）*
>
> **代理 B：** 這個要怎麼部署？要我 SSH 進伺服器嗎？

**有 Engram：**
> **代理 B：** 我來設定 GitHub Actions 工作流程——這是團隊定下的部署方式。

---

## 快速開始

### 前置需求

- [OpenClaw](https://github.com/openclaw/openclaw) `>= 2026.3.24`
- [Ollama](https://ollama.com) 在本機運行：
  ```bash
  ollama pull bge-m3
  ollama pull qwen3:8b
  ```

### 安裝

```bash
git clone https://github.com/maiyangyun/engram.git
cd engram
npm install && npm run build
ln -s "$(pwd)" ~/.openclaw/extensions/engram
```

### 設定

在你的 `openclaw.json` 中加入：

```json
{
  "plugins": {
    "load": { "paths": ["~/.openclaw/extensions/engram"] },
    "slots": { "memory": "engram" },
    "entries": {
      "engram": {
        "enabled": true,
        "config": {
          "userId": "your_user_id",
          "autoRecall": true,
          "autoCapture": true,
          "ollamaBaseUrl": "http://localhost:11434",
          "embeddingModel": "ollama/bge-m3",
          "extractionModel": "ollama/qwen3:8b"
        }
      }
    }
  }
}
```

```bash
openclaw gateway restart
```

搞定。你的代理現在有記憶了。

---

## 運作原理

Engram 在每次對話的兩個時間點介入：

**代理回覆之前** — Engram 拿你的訊息去記憶資料庫搜尋相關內容，然後悄悄注入代理的上下文中。對代理來說，這些就像是它本來就知道的背景知識。

**代理回覆之後** — Engram 檢視剛才的對話，提取重要事實。短對話（500 字元以下）直接儲存。較長的對話會經過 LLM 閱讀完整內容，挑出關鍵資訊——表達的偏好、做出的決定、確立的事實。

所有資料都存在本機的 SQLite（WAL 模式，防崩潰）。嵌入向量由你機器上的 Ollama 生成，所以記憶搜尋既快速又隱私。

### 記憶類型

| 類型 | 儲存內容 | 範例 |
|------|---------|------|
| `semantic` | 穩定的事實、知識、偏好 | 「使用者偏好 PostgreSQL」 |
| `episodic` | 事件、時間相關的紀錄 | 「2026-04-09 部署了 v2.1」 |
| `procedural` | 流程、決策、操作方法 | 「部署前一定要先跑 migration」 |

### 什麼會被記住

Engram 會擷取對話雙方的內容：
- **你說的** — 偏好、事實、需求、脈絡
- **代理決定的** — 分析、建議、承諾、計畫

每條記憶都會標記 `source_role`（`user`、`assistant` 或 `both`），讓你隨時知道知識的來源。

---

## 多代理記憶

這是 Engram 真正厲害的地方。

預設情況下，每個代理的記憶是私有的。代理 A 看不到代理 B 記住的東西，反之亦然。這是自動的——Engram 會從 session 讀取代理身份。

但有時候你希望代理之間能共享。也許代理 A 搞清楚了你的部署流程，你希望代理 B 也知道。也許你的整個代理團隊都應該了解專案架構。

Engram 透過組織和專案來處理這件事。當代理儲存記憶時帶上組織或專案標籤，同組織或同專案的其他代理就能看到。就像團隊頻道——預設私有，需要時共享。

最棒的是：你通常不需要手動操作。Engram 的提取 LLM 會自動判斷對話屬於哪個組織或專案，並自動標記記憶。你只需要設定一次已知的組織和專案，剩下的 Engram 搞定。

### 四維度所有權

每條記憶都帶有四個平行的所有權維度：

| 維度 | 代表什麼 | 範例 |
|------|---------|------|
| `user_id` | 人類身份——跨所有代理共享的個人資訊 | `"soren"` |
| `agent_id` | 建立記憶的代理（必填，不可為空） | `"main"`, `"lion"` |
| `org_id` | 組織範圍——將可見性擴展到組織成員 | `"pumpkin-global"` |
| `project_id` | 專案範圍——將可見性擴展到專案成員 | `"engram"`, `"imprint"` |

這些維度是**平行的，不是階層式的**。搜尋時會比對所有指定維度——未指定的維度視為萬用字元。

例如，用 `orgId="pumpkin-global"` 搜尋會回傳該組織的所有記憶，不限專案。加上 `projectId="engram"` 可以進一步縮小範圍。沒有組織/專案維度的記憶只有建立它的代理看得到。

### 可見性規則

- **有 `project_id` + `org_id`** → 該專案的所有代理都看得到
- **只有 `org_id`** → 該組織的所有代理都看得到
- **都沒有** → 只有建立它的代理看得到

手動分享記憶：
```
memory_add(text="Project deadline is March 15", visibility="shared")
```

---

## 設定項

以下是預設值。大多數使用者不需要修改。

### 外掛設定（openclaw.json）

| 欄位 | 預設值 | 說明 |
|------|-------|------|
| `userId` | `"default"` | 根使用者 ID，用於範圍界定 |
| `defaultOrgId` | `null` | 預設組織 |
| `defaultProjectId` | `null` | 預設專案 |
| `autoCapture` | `true` | 自動從對話中提取記憶 |
| `autoRecall` | `true` | 自動將記憶注入上下文 |
| `embeddingModel` | `ollama/bge-m3` | 嵌入模型 |
| `extractionModel` | `ollama/qwen3.5:9b` | 事實提取用的 LLM |
| `ollamaBaseUrl` | `http://localhost:11434` | Ollama API 端點 |
| `dbPath` | `~/.engram/engram.db` | SQLite 資料庫路徑 |
| `searchThreshold` | `0.5` | 最低相似度分數（0-1） |
| `topK` | `10` | 每次搜尋最多回傳的記憶數 |
| `recallMaxResults` | `8` | 注入回憶記憶的硬上限 |
| `recallScoreGap` | `0.08` | 相鄰分數差距過大時截斷回憶記憶 |
| `recallHighConfidence` | `0.75` | 高信心回憶門檻 |
| `recallShortMsgMaxResults` | `3` | 短提示（<20 字元）的最大回憶記憶數 |
| `recallStatsLog` | `true` | 記錄回憶實驗統計 |
| `extractionWindowMessages` | `30` | 標準完整提取檢視最近 N 則訊息 |
| `extractionWindowChars` | `8000` | 標準完整提取的字元上限 |
| `extractionPressureWindowMessages` | `50` | 壓力觸發提取檢視最近 N 則訊息 |
| `extractionPressureWindowChars` | `16000` | 壓力觸發提取的字元上限 |

### 進階設定

#### 提取視窗調校

Engram 的 `autoCapture` 完整提取使用兩種提取視窗：

- **標準完整提取** — 用於一般較長的對話
- **壓力觸發提取** — 當上下文壓力較高時，Engram 會主動在壓縮風險增加前擷取記憶

預設值：

```json
{
  "extractionWindowMessages": 30,
  "extractionWindowChars": 8000,
  "extractionPressureWindowMessages": 50,
  "extractionPressureWindowChars": 16000
}
```

調高這些值可以提升長規劃討論串的擷取完整度，代價是更多的提取 token 消耗和稍慢的擷取速度。

#### 維度設定（~/.engram/dimensions.json）

```json
{
  "knownOrgs": [
    { "id": "pumpkin-global", "aliases": ["pumpkin", "PGL"] }
  ],
  "knownProjects": [
    { "id": "engram", "aliases": ["memory system"] },
    { "id": "imprint", "aliases": ["identity engine"] }
  ]
}
```

LLM 會利用這些已知維度，在記憶提取時自動推斷 `org_id` 和 `project_id`。不需要手動標記——只要設定一次你的組織和專案，Engram 就會自動判斷每條記憶該歸屬到哪裡。LLM 發現的新維度也會自動註冊到這裡。

---

## 工具參考

Engram 註冊了六個工具，相容 OpenClaw 記憶介面：

| 工具 | 說明 |
|------|------|
| `memory_search` | 向量搜尋，支援四維度篩選和可見性合併 |
| `memory_add` | 儲存記憶，支援類型分類和可見性控制 |
| `memory_get` | 透過 ID 取得特定記憶 |
| `memory_list` | 列出記憶，支援篩選條件 |
| `memory_update` | 更新記憶內容（自動重新生成嵌入向量） |
| `memory_delete` | 透過 ID 刪除或批次刪除（需安全確認） |

### 主要參數

**`memory_add`：**
- `text` / `facts` — 要記住的內容
- `memory_type` — `semantic`、`episodic` 或 `procedural`（預設：`semantic`）
- `visibility` — `agent`（私有，預設）或 `shared`（附加預設 org_id，讓組織成員可見）
- `agentId`、`orgId`、`projectId` — 所有權維度

**`memory_search`：**
- `query` — 自然語言搜尋
- `scope` — `personal`（僅代理自己）、`shared`（僅共享）、`all`（合併，預設）
- `agentId`、`orgId`、`projectId` — 篩選條件
- `memory_type` — 依類型篩選

---

## 技術架構

- **儲存：** SQLite，WAL 模式（防崩潰、支援並行讀取）
- **嵌入：** Ollama + bge-m3（1024 維，本機運行，優秀的中日韓文支援）
- **提取：** Ollama + qwen3.5:9b（本機 LLM）或 Gemini API（雲端選項）
- **執行環境：** Node.js、TypeScript、tsup
- **框架：** OpenClaw plugin SDK

預設本機優先。Gemini API 作為可選的雲端提取供應商。

---

## Cortex 家族

Engram 是 **Cortex** 旗下三個產品之一——讓 AI 代理成為真正有能力的團隊成員的工具：

| 產品 | 用途 |
|------|------|
| [**Imprint**](https://github.com/maiyangyun/imprint) | 從結構化的 profile 文件打造專家級代理。*讓代理知道自己是誰。* |
| **Engram** | 多代理協作記憶系統。*讓代理累積並分享經驗。* |
| **Synapse** | 代理優先的人機協作工作空間。*讓代理與人類並肩工作。* |

**Imprint → Engram → Synapse**：身份 → 記憶 → 協作。

---

## 更新日誌

**v0.5.0-beta.1**（2026-04-22）— 回憶精準度大幅改進，新增智慧截斷機制、增量記憶去重與人工審核、代理別名映射，以及可設定的提取視窗。

完整版本歷史請見 [CHANGELOG.md](CHANGELOG.md)。

---

## 路線圖

- [ ] 多代理並行下的回憶超時最佳化
- [ ] 評估雲端提取供應商（Gemini API）以加速擷取
- [ ] 記憶檢視與管理的 Web 儀表板
- [ ] 記憶抽象化——自動將具體經驗蒸餾為可遷移的方法論

---

## 聯絡我們

Engram 由 **Ben**（AI）和 **Soren**（人類）共同打造，是 [Cortex](https://github.com/maiyangyun/engram#part-of-cortex) 專案的一部分。

- **GitHub Issues：** [github.com/maiyangyun/engram/issues](https://github.com/maiyangyun/engram/issues)
- **Discord：** [OpenClaw Community](https://discord.com/invite/clawd)
- **Email：** maiyangyun@gmail.com

如果你在打造多代理系統，希望你的代理真的能*記住東西*——試試 Engram 吧。我們很期待聽到你的使用心得。

---

## 授權

MIT
