# dsh-redact · 数据脱敏插件

dsh（DeepSeek Harness）插件：在「模型厂商边界」上对会话数据做双向脱敏——
发往 LLM 的敏感内容（手机号、身份证、密钥等）替换为一致性占位符，模型回复中的
占位符自动还原为真实值；宿主日志同步打码。模型厂商收不到真实数据，
而本机的 UI 展示、工具执行、会话记录全程无感。

## 机制

```
用户输入/工具结果 ──→ [llm/stream 出站] 敏感值 → [[TEL_1]] 一致性占位符 ──→ LLM provider
本机会话历史（原文保留）                                              （只见占位符）
                                                        ┌────────────────┘
UI 展示 / 工具执行 / 会话记录 ←── [llm/stream 入站] 占位符还原为真实值 ←──┘
```

- **挂点 = `llm/stream` waterfall**（dsh-llm 官方拦截点）：对 agent 循环、会话标题
  生成等所有 LLM 调用统一生效。出站在 `options` 上整体替换 `messages` 数组引用与
  `system`（单条消息是会话投影的冻结对象，克隆承接、绝不变更本机历史）；入站包装
  chunk 流做占位符还原（含跨 chunk 拆分的边界缓冲；`block-end` 权威块整块还原；
  delta-only 流在 `finish` 前补发残余）。
- **一致性假名**：同一会话内同一真实值永远映射到同一占位符（`[[CODE_N]]`，按首次
  出现顺序编号），模型仍能理解数据关系（"把那个手机号格式化"类任务正常完成）。
  映射按 sessionId 分账，持久化于 `~/.dsh/redact/state.json`（dsh 重启后同会话
  占位符保持一致）；会话 7 天不活跃或总量超 200 自动清理。
- **日志打码**：包装 cordis LoggerService 的 exporter 汇出层（现有 + 后续注册
  全覆盖），用独立全局映射，只打码不还原。

## 内置规则（可开关）

| 类别 | 占位符 | 匹配 |
|---|---|---|
| 密钥/凭据 | `[[SECRET_N]]` | sk-…、AKIA…、ghp_/github_pat_…、xox…-…、JWT、`Bearer <值>`、PEM 私钥块、`password/api_key/token… = 值`（保留变量名与协议前缀，只脱敏值） |
| 身份证 | `[[ID_N]]` | 18 位（GB 11643 校验码 + 日期段验证）、15 位一代证 |
| 银行卡 | `[[BANK_N]]` | 13–19 位数字段且通过 Luhn 校验 |
| 手机号 | `[[TEL_N]]` | `1[3-9]` 开头 11 位（数字边界防从长数字段内截取） |
| 邮箱 | `[[EMAIL_N]]` | 标准邮箱 |

规则按优先级收集、重叠区间先到先得（密钥 > 证件 > 银行卡 > 手机 > 邮箱）；
脱敏幂等（占位符本身不会被再次命中）。

**自定义规则**：设置页添加名称 + 正则（≤200 字符、≤50 条，保存时编译校验）。
占位符类别码取规则名中的字母数字（如 `orderID` → `[[ORDERID_1]]`）。

## 设置页

设置面板顶级「数据脱敏」Tab：三个总开关（LLM 脱敏 / 输出还原 / 日志打码）、
内置类别开关、自定义规则管理、**脱敏测试框**（粘贴文本即时看效果，不污染会话映射）、
按类别命中统计与会话映射清理。

HTTP API（同源回环；写路由 sameOrigin 校验）：`GET|PUT /redact/api/config`、
`GET /redact/api/status`、`POST /redact/api/test`、`POST /redact/api/clear-maps`。

## 已知边界

- 正文恰好包含 `[[TEL_1]]` 形态的字面量会被当作占位符（概率极低，README 明示）；
- 自定义正则由用户提供，超复杂正则的回溯成本自负（内置规则全部线性/定长匹配）；
- 15 位一代证仅能验证日期段合理性，长随机数字段有极低误报可能（18 位有校验码兜底）；
- 模型若把占位符改写变形（如全角化），还原会失败并原样显示占位符——ASCII 格式
  `[[CODE_N]]` 是模型回抄保真度最高的选择；
- 日志打码传给 exporter 的是 args 浅拷贝（Error 等奇异对象不深遍历，避免触发
  getter 副作用）。

## 开发

```bash
npm install
npm test          # vitest（90 用例：规则/映射/流式还原/日志/持久化/编排冒烟）
npm run build     # tsc + esbuild client → lib/
npm run typecheck
node refresh-local.mjs   # 构建 + 测试门禁 + 直推 profile（重启 dsh 后生效）
```

部署环境见工作区惯例（`F:` 开发检出 → `~/.dsh` profile 用 refresh-local.mjs）。
状态文件路径：`$DSH_REDACT_HOME ?? $DSH_HOME ?? ~/.dsh` 下的 `redact/state.json`。

设计文档：`../docs/plans/2026-09-01-dsh-redact-design.md`（工作区仓库）。
