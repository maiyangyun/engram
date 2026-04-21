[English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md)

# Engram 🧠

**你的 AI 代理每次对话结束就全忘了。Engram 解决这个问题。**

Engram 为你的 [OpenClaw](https://github.com/openclaw/openclaw) 代理提供持久记忆——它们会记住你说过的话、做过的决定、学到的东西，跨越每一次对话、每一个频道。多个代理之间甚至能自动共享知识。

一切都在你的本机运行。不需要云端 API，数据不会离开你的网络。属于 [Cortex](https://github.com/maiyangyun/engram#part-of-cortex) 产品家族的一员。

---

## 问题在哪

AI 代理就像金鱼，每次对话都从零开始。

你告诉代理你偏好 PostgreSQL 而不是 MySQL。下一次对话，它推荐 MySQL。你花了二十分钟带代理走过一遍你的部署流程。隔天，它完全不记得你怎么部署的。你们一起做了一个关键的架构决策——推理过程、权衡取舍、最终结论——对话一结束，全部消失。

多代理的情况更惨。你有三个代理分别负责项目的不同部分。其中一个学到了重要信息——比如 staging 服务器换了新 IP。另外两个？完全不知道。你变成了自己代理之间的传话筒，一遍又一遍重复同样的事。

这不是小麻烦，而是从根本上限制了代理的能力。没有记忆，每个代理永远都是新手。

---

## 为什么要做 Engram

OpenClaw 本身已经有记忆能力了——而且能用。你可以设置 `dmScope` 在频道之间共享对话上下文，代理也可以往 Markdown 文件（比如 `memory/YYYY-MM-DD.md`）里写笔记。简单场景下，这些往往够用了。

但当我们开始在真实项目中跑多个代理时，撞墙了。

**token 问题。** 跨频道共享完整对话上下文，意味着代理什么都记得——但代价是每条消息都要带上全部历史记录。token 成本飙升。你真正需要的是选择性召回：只在需要的时候，精准注入相关的那几条。

**「记得去记」问题。** Markdown 日志能用，但它依赖某个人——你或者代理——主动决定把东西记下来。实际操作中，重要决策经常漏掉。代理给了一个很好的架构建议，你们俩继续往下聊，没人记录。一周后，这条信息就没了。记忆不应该需要手动操作。代理应该自己判断什么值得记住。

**多代理的空白。** 当你有多个代理时，问题成倍放大。代理 A 学会了你的部署流程，代理 B 完全不知道。没有内置的方式让代理之间共享知识，同时又保持各自的私有记忆。

我们看了现有的方案。[Mem0](https://github.com/mem0ai/mem0) 是最有前景的——一个设计精良的记忆层，带 LLM 驱动的提取能力。我们试了 OpenClaw 的 Mem0 插件，从中学到了很多，也尊重这个项目的工作。但它不太符合我们的需求：

- **云端依赖。** Mem0 的平台会把你的数据发送到他们的服务器。对于处理敏感项目信息的团队来说，这是硬伤。
- **单代理设计。** Mem0 围绕一个用户和一个代理构建。它没有组织、项目或多代理可见性规则的概念。
- **召回控制有限。** 我们需要对召回的内容和时机做精细控制——相似度阈值、智能截断、短消息处理——在控制 token 成本的同时不丢失重要上下文。

所以我们做了 Engram。它完全在你的机器上运行，支持多代理并提供合理的隔离和共享机制，自动处理记忆——捕获、召回、去重，全都不需要你操心。

我们还在持续迭代。Engram 还很年轻，有很多可以改进的地方。但它已经解决了驱动我们去做它的那些问题，而且我们每天都在用。

---

## Engram 做了什么

Engram 在后台安静地运行，帮你处理记忆：

- **代理会记住。** 偏好、决策、项目脉络、技术细节——聊过一次就记住了。你的代理会随着时间积累真正的专业知识。
- **代理会分享。** 当一个代理学到新东西，同组织的其他代理也能访问。不用手动复制，不用重复解释。
- **数据留在你手上。** 所有数据都存在本机的 SQLite 数据库。嵌入向量通过你机器上的 Ollama 生成。除非你主动选择云端模型，否则什么都不会离开你的网络。
- **到处都能用。** Webchat、飞书、Telegram、Discord——随意切换频道，代理的记忆跟着走。

---

## 实际效果

**没有 Engram：**
> **你：** 这个项目用 PostgreSQL，不要 MySQL。
> **代理：** 收到，我会用 PostgreSQL。
>
> *（下一次对话）*
>
> **你：** 把数据库建起来。
> **代理：** 好的！你想用哪个数据库——MySQL、PostgreSQL 还是 SQLite？

**有 Engram：**
> **你：** 把数据库建起来。
> **代理：** 用 PostgreSQL 建，因为这是你的偏好。要不要沿用 Bonbon 项目的 schema 模式？

---

**没有 Engram：**
> **代理 A** *（学到了）：* 团队决定用 GitHub Actions 部署，不再手动 SSH。
>
> *（稍后，另一个代理）*
>
> **代理 B：** 这个要怎么部署？要我 SSH 进服务器吗？

**有 Engram：**
> **代理 B：** 我来配置 GitHub Actions 工作流——这是团队定下的部署方式。

---

## 快速开始

### 前置需求

- [OpenClaw](https://github.com/openclaw/openclaw) `>= 2026.3.24`
- [Ollama](https://ollama.com) 在本机运行：
  ```bash
  ollama pull bge-m3
  ollama pull qwen3:8b
  ```

### 安装

```bash
git clone https://github.com/maiyangyun/engram.git
cd engram
npm install && npm run build
ln -s "$(pwd)" ~/.openclaw/extensions/engram
```

### 配置

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

搞定。你的代理现在有记忆了。

---

## 运作原理

Engram 在每次对话的两个时间点介入：

**代理回复之前** — Engram 拿你的消息去记忆数据库搜索相关内容，然后悄悄注入代理的上下文中。对代理来说，这些就像是它本来就知道的背景知识。

**代理回复之后** — Engram 检视刚才的对话，提取重要事实。短对话（500 字符以下）直接存储。较长的对话会经过 LLM 阅读完整内容，挑出关键信息——表达的偏好、做出的决定、确立的事实。

所有数据都存在本机的 SQLite（WAL 模式，防崩溃）。嵌入向量由你机器上的 Ollama 生成，所以记忆搜索既快速又隐私。

### 记忆类型

| 类型 | 存储内容 | 示例 |
|------|---------|------|
| `semantic` | 稳定的事实、知识、偏好 | 「用户偏好 PostgreSQL」 |
| `episodic` | 事件、时间相关的记录 | 「2026-04-09 部署了 v2.1」 |
| `procedural` | 流程、决策、操作方法 | 「部署前一定要先跑 migration」 |

### 什么会被记住

Engram 会提取对话双方的内容：
- **你说的** — 偏好、事实、需求、脉络
- **代理决定的** — 分析、建议、承诺、计划

每条记忆都会标记 `source_role`（`user`、`assistant` 或 `both`），让你随时知道知识的来源。

---

## 多代理记忆

这是 Engram 真正厉害的地方。

默认情况下，每个代理的记忆是私有的。代理 A 看不到代理 B 记住的东西，反之亦然。这是自动的——Engram 会从 session 读取代理身份。

但有时候你希望代理之间能共享。也许代理 A 搞清楚了你的部署流程，你希望代理 B 也知道。也许你的整个代理团队都应该了解项目架构。

Engram 通过组织和项目来处理这件事。当代理存储记忆时带上组织或项目标签，同组织或同项目的其他代理就能看到。就像团队频道——默认私有，需要时共享。

最棒的是：你通常不需要手动操作。Engram 的提取 LLM 会自动判断对话属于哪个组织或项目，并自动标记记忆。你只需要配置一次已知的组织和项目，剩下的 Engram 搞定。

### 四维度所有权

每条记忆都带有四个平行的所有权维度：

| 维度 | 代表什么 | 示例 |
|------|---------|------|
| `user_id` | 人类身份——跨所有代理共享的个人信息 | `"soren"` |
| `agent_id` | 创建记忆的代理（必填，不可为空） | `"main"`, `"lion"` |
| `org_id` | 组织范围——将可见性扩展到组织成员 | `"pumpkin-global"` |
| `project_id` | 项目范围——将可见性扩展到项目成员 | `"engram"`, `"bonbon"` |

这些维度是**平行的，不是层级式的**。搜索时会匹配所有指定维度——未指定的维度视为通配符。

例如，用 `orgId="pumpkin-global"` 搜索会返回该组织的所有记忆，不限项目。加上 `projectId="engram"` 可以进一步缩小范围。没有组织/项目维度的记忆只有创建它的代理看得到。

### 可见性规则

- **有 `project_id` + `org_id`** → 该项目的所有代理都看得到
- **只有 `org_id`** → 该组织的所有代理都看得到
- **都没有** → 只有创建它的代理看得到

手动分享记忆：
```
memory_add(text="Project deadline is March 15", visibility="shared")
```

---

## 配置项

以下是默认值。大多数用户不需要修改。

### 插件配置（openclaw.json）

| 字段 | 默认值 | 说明 |
|------|-------|------|
| `userId` | `"default"` | 根用户 ID，用于范围界定 |
| `defaultOrgId` | `null` | 默认组织 |
| `defaultProjectId` | `null` | 默认项目 |
| `autoCapture` | `true` | 自动从对话中提取记忆 |
| `autoRecall` | `true` | 自动将记忆注入上下文 |
| `embeddingModel` | `ollama/bge-m3` | 嵌入模型 |
| `extractionModel` | `ollama/qwen3.5:9b` | 事实提取用的 LLM |
| `ollamaBaseUrl` | `http://localhost:11434` | Ollama API 端点 |
| `dbPath` | `~/.engram/engram.db` | SQLite 数据库路径 |
| `searchThreshold` | `0.5` | 最低相似度分数（0-1） |
| `topK` | `10` | 每次搜索最多返回的记忆数 |
| `recallMaxResults` | `8` | 注入召回记忆的硬上限 |
| `recallScoreGap` | `0.08` | 相邻分数差距过大时截断召回记忆 |
| `recallHighConfidence` | `0.75` | 高置信度召回阈值 |
| `recallShortMsgMaxResults` | `3` | 短提示（<20 字符）的最大召回记忆数 |
| `recallStatsLog` | `true` | 记录召回实验统计 |
| `extractionWindowMessages` | `30` | 标准完整提取查看最近 N 条消息 |
| `extractionWindowChars` | `8000` | 标准完整提取的字符上限 |
| `extractionPressureWindowMessages` | `50` | 压力触发提取查看最近 N 条消息 |
| `extractionPressureWindowChars` | `16000` | 压力触发提取的字符上限 |

### 进阶配置

#### 提取窗口调优

Engram 的 `autoCapture` 完整提取使用两种提取窗口：

- **标准完整提取** — 用于一般较长的对话
- **压力触发提取** — 当上下文压力较高时，Engram 会主动在压缩风险增加前提取记忆

默认值：

```json
{
  "extractionWindowMessages": 30,
  "extractionWindowChars": 8000,
  "extractionPressureWindowMessages": 50,
  "extractionPressureWindowChars": 16000
}
```

调高这些值可以提升长规划讨论串的提取完整度，代价是更多的提取 token 消耗和稍慢的提取速度。

#### 维度配置（~/.engram/dimensions.json）

```json
{
  "knownOrgs": [
    { "id": "pumpkin-global", "aliases": ["pumpkin", "PGL"] }
  ],
  "knownProjects": [
    { "id": "engram", "aliases": ["memory system"] },
    { "id": "bonbon", "aliases": ["dating app"] }
  ]
}
```

LLM 会利用这些已知维度，在记忆提取时自动推断 `org_id` 和 `project_id`。不需要手动标记——只要配置一次你的组织和项目，Engram 就会自动判断每条记忆该归属到哪里。LLM 发现的新维度也会自动注册到这里。

---

## 工具参考

Engram 注册了六个工具，兼容 OpenClaw 记忆接口：

| 工具 | 说明 |
|------|------|
| `memory_search` | 向量搜索，支持四维度筛选和可见性合并 |
| `memory_add` | 存储记忆，支持类型分类和可见性控制 |
| `memory_get` | 通过 ID 获取特定记忆 |
| `memory_list` | 列出记忆，支持筛选条件 |
| `memory_update` | 更新记忆内容（自动重新生成嵌入向量） |
| `memory_delete` | 通过 ID 删除或批量删除（需安全确认） |

### 主要参数

**`memory_add`：**
- `text` / `facts` — 要记住的内容
- `memory_type` — `semantic`、`episodic` 或 `procedural`（默认：`semantic`）
- `visibility` — `agent`（私有，默认）或 `shared`（附加默认 org_id，让组织成员可见）
- `agentId`、`orgId`、`projectId` — 所有权维度

**`memory_search`：**
- `query` — 自然语言搜索
- `scope` — `personal`（仅代理自己）、`shared`（仅共享）、`all`（合并，默认）
- `agentId`、`orgId`、`projectId` — 筛选条件
- `memory_type` — 按类型筛选

---

## 技术架构

- **存储：** SQLite，WAL 模式（防崩溃、支持并行读取）
- **嵌入：** Ollama + bge-m3（1024 维，本机运行，优秀的中日韩文支持）
- **提取：** Ollama + qwen3.5:9b（本机 LLM）或 Gemini API（云端选项）
- **运行环境：** Node.js、TypeScript、tsup
- **框架：** OpenClaw plugin SDK

默认本机优先。Gemini API 作为可选的云端提取供应商。

---

## Cortex 家族

Engram 是 **Cortex** 旗下三个产品之一——让 AI 代理成为真正有能力的团队成员的工具：

| 产品 | 用途 |
|------|------|
| [**Imprint**](https://github.com/maiyangyun/imprint) | 从结构化的 profile 文件打造专家级代理。*让代理知道自己是谁。* |
| **Engram** | 多代理协作记忆系统。*让代理积累并分享经验。* |
| **Synapse** | 代理优先的人机协作工作空间。*让代理与人类并肩工作。* |

**Imprint → Engram → Synapse**：身份 → 记忆 → 协作。

---

## 更新日志

**v0.5.0-beta.1**（2026-04-22）— 召回精准度大幅改进，新增智能截断机制、增量记忆去重与人工审核、代理别名映射，以及可配置的提取窗口。

完整版本历史请见 [CHANGELOG.md](CHANGELOG.md)。

---

## 路线图

- [ ] 多代理并行下的召回超时优化
- [ ] 评估云端提取供应商（Gemini API）以加速提取
- [ ] 记忆查看与管理的 Web 仪表盘
- [ ] 记忆抽象化——自动将具体经验蒸馏为可迁移的方法论

---

## 联系我们

Engram 由 **Ben**（AI）和 **Soren**（人类）共同打造，是 Pumpkin Global Limited 旗下 Cortex 项目的一部分。

- **GitHub Issues：** [github.com/maiyangyun/engram/issues](https://github.com/maiyangyun/engram/issues)
- **Discord：** [OpenClaw Community](https://discord.com/invite/clawd)
- **Email：** maiyangyun@gmail.com

如果你在打造多代理系统，希望你的代理真的能*记住东西*——试试 Engram 吧。我们很期待听到你的使用心得。

---

## 许可

MIT
