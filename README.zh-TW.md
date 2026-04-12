[English](README.md) | [繁體中文](README.zh-TW.md)

# Engram 🧠

**讓你的 AI agent 擁有記憶。真正的記憶。**

Engram 是一套協作式記憶系統，讓多個 AI agent 能夠記住、學習、共享知識——全部在你的本機運行。不呼叫雲端 API，資料不離開你的網路。只有 SQLite、Ollama，和一個簡單的 plugin。

為 [OpenClaw](https://github.com/openclaw/openclaw) 打造。隸屬 [Cortex](https://github.com/maiyangyun/engram#part-of-cortex) 產品家族。

---

## Engram 能做什麼？

**對單一 agent 而言：**
- 自動記住使用者告訴你的事，以及你做出的決策
- 每次回覆前自動召回相關記憶——不需要手動查找
- 隨著對話累積，跨會話、跨頻道地建立專業知識

**對多個 agent 而言：**
- 所有 agent 共享同一個記憶資料庫
- 每個 agent 擁有私有記憶，對其他 agent 不可見
- 共享記憶自動流向所有需要的 agent
- 一個 agent 學到的東西，其他 agent 立刻受益

**對你（人類）而言：**
- 你的 agent 不再重複問同樣的問題
- 專案決策跨會話持久保存
- 切換頻道（webchat → Feishu → Telegram）不會遺失上下文

---

## 快速開始

### 前置需求

- [OpenClaw](https://github.com/openclaw/openclaw) `>= 2026.3.24`
- [Ollama](https://ollama.com) 在本機運行：
  ```bash
  ollama pull nomic-embed-text
  ollama pull qwen3.5:9b
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
          "embeddingModel": "ollama/nomic-embed-text",
          "extractionModel": "ollama/qwen3.5:9b"
        }
      }
    }
  }
}
```

```bash
openclaw gateway restart
```

搞定。你的 agent 現在有記憶了。

---

## 運作原理

```
使用者說話 → autoRecall 搜尋記憶 → 注入相關上下文
                                ↓
                          Agent 回覆
                                ↓
                    autoCapture 觸發（agent_end hook）
                                ↓
              ┌─────────────────┴─────────────────┐
              │ 短文本（<500 字元）                │ 長文本（≥500 字元）
              │ 直接 embed → 儲存                  │ LLM 抽取事實 → embed → 儲存
              └───────────────────────────────────┘
                                ↓
                     SQLite（WAL 模式，抗崩潰）
```

### 記住了什麼

Engram 雙向捕獲對話的兩端：
- **使用者說的** — 偏好、事實、需求、上下文
- **Agent 決定的** — 分析、建議、承諾、計畫

每條記憶標記 `source_role`（`user`、`assistant` 或 `both`），讓你隨時知道知識從哪來。

### 記憶類型

| 類型 | 儲存內容 | 範例 |
|------|---------|------|
| `semantic` | 穩定的事實、知識、偏好 | 「使用者偏好 PostgreSQL」 |
| `episodic` | 事件、時間相關的紀錄 | 「2026-04-09 部署了 v2.1」 |
| `procedural` | 流程、決策、操作方法 | 「部署前一定要先跑 migration」 |

---

## 多 Agent 記憶

這是 Engram 真正有趣的地方。

### 隔離

每條記憶都有 `agent_id`。Agent A 的記憶對 Agent B 不可見。這是自動的——Engram 從 session key 讀取 agent 身份。

### 共享記憶

有些知識應該讓所有人看到。兩種共享方式：

**手動：** 新增記憶時使用 `visibility: "shared"`：
```
memory_add(text="專案截止日是三月十五日", visibility="shared")
```

**自動：** 在 `~/.engram/dimensions.json` 中設定已知維度：
```json
{
  "knownOrgs": ["pumpkin", "cortex"],
  "knownProjects": ["engram", "bonbon", "imprint"]
}
```

autoCapture 時，LLM 會根據對話上下文自動推斷記憶所屬的 org 和 project 維度。匹配到已知維度的記憶會自動標記對應的 `org_id` / `project_id`，讓相關 agent 都能搜尋到。

### 四維歸屬模型

每條記憶攜帶四個並行維度，搜尋時進行維度匹配：

| 維度 | 說明 | 範例 |
|------|------|------|
| `user_id` | 所屬使用者 | `"soren"` |
| `agent_id` | 所屬 agent（`null` = 共享） | `"main"`, `null` |
| `org_id` | 所屬組織 | `"pumpkin"` |
| `project_id` | 所屬專案 | `"engram"` |

搜尋時，Engram 用單條 SQL 進行並行維度過濾，將共享記憶（`agent_id=null`）與 agent 私有記憶合併回傳。不再是逐層掃描，而是扁平化的維度匹配。

---

## 工具參考

Engram 註冊六個工具，相容 OpenClaw memory 介面：

| 工具 | 說明 |
|------|------|
| `memory_search` | 向量搜尋，支援四維過濾與可見性合併 |
| `memory_add` | 儲存記憶，支援類型分類、可見性控制與去重 |
| `memory_get` | 以 ID 取得特定記憶 |
| `memory_list` | 列出記憶，支援篩選條件 |
| `memory_update` | 更新記憶內容（自動重新 embed） |
| `memory_delete` | 以 ID 刪除或批次刪除（需安全確認） |

### 主要參數

**`memory_add`：**
- `text` / `facts` — 要記住的內容
- `memory_type` — `semantic`、`episodic` 或 `procedural`（預設：`semantic`）
- `visibility` — `agent`（私有，預設）或 `shared`（所有 agent 可見）
- `agentId`、`orgId`、`projectId` — 歸屬維度
- 回傳值包含 `dedupAction: "added" | "updated"`，告訴你是新增還是更新了既有記憶

**`memory_search`：**
- `query` — 自然語言搜尋
- `scope` — `personal`（僅 agent）、`shared`（僅共享）、`all`（合併，預設）
- `agentId`、`orgId`、`projectId` — 過濾條件
- `memory_type` — 依類型過濾

---

## 設定

### Plugin 設定（openclaw.json）

| 欄位 | 預設值 | 說明 |
|------|--------|------|
| `userId` | `"default"` | 使用者 ID |
| `defaultOrgId` | `null` | 預設組織 |
| `defaultProjectId` | `null` | 預設專案 |
| `autoCapture` | `true` | 自動從對話中抽取記憶 |
| `autoRecall` | `true` | 自動注入記憶到上下文 |
| `embeddingModel` | `ollama/nomic-embed-text` | Embedding 模型 |
| `extractionModel` | `ollama/qwen3.5:9b` | 事實抽取用 LLM |
| `ollamaBaseUrl` | `http://localhost:11434` | Ollama API 端點 |
| `dbPath` | `~/.engram/engram.db` | SQLite 資料庫路徑 |
| `searchThreshold` | `0.5` | 最低相似度分數（0-1） |
| `topK` | `10` | 每次搜尋最多回傳筆數 |

### 維度設定（~/.engram/dimensions.json）

```json
{
  "knownOrgs": ["pumpkin", "cortex"],
  "knownProjects": ["engram", "bonbon", "imprint"]
}
```

LLM 在抽取記憶時會參考這份清單，自動將記憶歸類到對應的 org/project。不需要手動標記。

---

## 技術棧

- **儲存：** SQLite + WAL 模式（抗崩潰、支援並行讀取）
- **Embedding：** Ollama + nomic-embed-text（768 維，本機運算）
- **抽取：** Ollama + qwen3.5:9b（本機 LLM，不呼叫雲端）
- **執行環境：** Node.js、TypeScript、tsup
- **框架：** OpenClaw plugin SDK

零外部 API 呼叫。零雲端費用。你的資料留在你手上。

---

## Cortex 產品家族

Engram 是 **Cortex** 旗下三個產品之一——讓 AI agent 成為真正有能力的團隊成員：

| 產品 | 用途 |
|------|------|
| **Imprint** | 從結構化的 profile 文件打造專家級 agent。*讓 agent 知道自己是誰。* |
| **Engram** | 多 agent 協作記憶系統。*讓 agent 累積並共享經驗。* |
| **Synapse** | Agent-first 的人機協作工作空間。*讓 agent 與人類並肩工作。* |

**Imprint → Engram → Synapse**：身份 → 記憶 → 協作。

---

## 更新日誌

### v0.3 (2026-04-11)

**新功能：**
- **四維歸屬模型** — 記憶攜帶 `user_id`、`agent_id`、`org_id`、`project_id`，採用並行維度匹配（取代舊的五層可見性階層）
- **自動維度推斷** — LLM 根據對話上下文自動推斷 org/project 維度，透過 `dimensions.json` 設定已知維度
- **記憶去重** — 餘弦相似度閾值（0.92）偵測近似重複記憶，更新既有記錄而非重複插入。`memory_add` 回傳 `dedupAction: "added" | "updated"`
- **Context 壓力捕獲** — 當對話過長（30+ 則訊息或 80K+ 字元）時，主動觸發完整記憶抽取，防止 context 溢出導致資料遺失

**抗異常改造（崩潰/故障保護）：**
- **失敗回合搶救** — `success=false` 的回合不再跳過捕獲；快速路徑保存最後 6 則訊息
- **LLM 失敗降級** — 若抽取或 embedding 失敗（逾時/中斷），自動降級為快速路徑捕獲，而非遺失資料
- **緊急信號捕獲** — SIGTERM/SIGUSR1/SIGUSR2 觸發同步 SQLite 寫入待處理的捕獲資料（無 embedding，但內容保留）
- **捕獲佇列串行化** — 所有捕獲透過串行佇列執行，各有獨立 60 秒逾時，與主對話的 abort 信號隔離

**改進：**
- 抽取模型升級為 `qwen3.5:9b`（更好的多語言支援）
- 抽取提示詞重寫，語言跟隨規則提升至最高優先級（中文對話產出中文記憶）
- 搜索閾值改為尊重配置值（預設 0.5），不再硬編碼 0.6 下限 — 修復中文搜索命中率問題
- 快速路徑捕獲加入輕量級關鍵詞匹配以偵測共享記憶（`inferSharedFromKeywords`）
- 單條 SQL 並行維度搜索（取代逐層五層掃描）

**破壞性變更：**
- `shared-rules.json` 關鍵詞共享機制替換為 `dimensions.json`（`knownOrgs`/`knownProjects`）— LLM 自動處理維度分配
- `searchWithVisibility()` API 變更：扁平維度過濾取代階層式結構
- `store.add()` 現在回傳 `AddMemoryResult`，包含 `dedupAction` 欄位

### v0.2 (2026-04-10)

**新功能：**
- **雙向 autoCapture** — 現在同時記住使用者輸入和 agent 回覆（決策、分析、建議）。每條記憶標記 `source_role: user|assistant|both`
- **多 agent 支援** — 多個 agent 共享一個資料庫，透過 session key 自動隔離身份
- **共享記憶** — `memory_add` 支援 `visibility: "shared"` 參數，加上透過 `shared-rules.json` 的關鍵詞自動升級

**改進：**
- autoRecall 逾時從 8 秒提高到 15 秒（應對 Ollama 冷啟動）
- 快速捕獲閾值從 200 提高到 500 字元（減少不必要的 LLM 呼叫）
- Plugin config schema 宣告，相容 OpenClaw UI

### v0.1 (2026-04-09)

- 初始版本
- 多維歸屬、多層可見性、三種記憶類型
- autoCapture + autoRecall 管線
- SQLite WAL 儲存、Ollama embedding + 抽取
- 跨頻道記憶（webchat、Feishu 等）

---

## 路線圖

- [x] 記憶去重
- [x] 多語言抽取
- [x] 專案範圍共享
- [ ] Embedding 快取（提升並行下的召回速度）
- [ ] 記憶重要性衰減
- [ ] Web 儀表板（記憶檢視與管理）

---

## 聯繫我們

Engram 由 **Ben**（AI）和 **Soren**（人類）共同打造，是 Pumpkin Global Limited 旗下 Cortex 專案的一部分。

- **GitHub Issues：** [github.com/maiyangyun/engram/issues](https://github.com/maiyangyun/engram/issues)
- **Discord：** [OpenClaw Community](https://discord.com/invite/clawd)
- **Email：** maiyangyun@gmail.com

如果你在做多 agent 系統，希望你的 agent 真的能「記住」東西——試試 Engram。我們很想聽聽你的使用體驗。

---

## 授權

MIT
