# M0/M1 后端交付记录

实现日期：2026-09-29。所有后端测试为本地 mock；没有调用真实付费接口，没有读取用户登录凭证。

## 配置与运行

- `npm run dev`：Express 与 Vite middleware 同端口，默认只监听 `127.0.0.1:4317`。
- `npm run build` 后 `npm start`：提供 `dist` 静态页面及同一组 API。
- 无 `.env` 时默认明确演示模式；`.env.example` 默认 `DEMO_MODE=true`。
- 本机复制 `.env.example` 为 `.env` 后自行填写 Key 与当前账号有权限的模型名称。`DEMO_MODE=false` 才会启用真实请求。未配置的独立能力返回中文错误，不自动换用 fixture。
- `APP_HOST` 只接受 `127.0.0.1`，端口允许本机配置。自定义 base URL 仅从后端环境读取，网页不能控制转发目标；远端必须 HTTPS。
- 模型名不硬编码；`TTS_VOICE=coral` 是文档列出的声音选择，账号真实支持仍待用户验证。转写与实时字段仅保留配置接口，本轮不使用。

## API 与安全约定

- `GET /api/config` 创建或复用 6 小时本地会话，返回模式、能力、模型名、CSRF、sessionId 和 generation/context watermark。Cookie 使用 HttpOnly + SameSite=Strict。
- 所有请求检查精确 Host；来源存在时必须等于当前 HTTP Host。跨站 Fetch 拒绝。修改操作必须有同源 Origin、会话 Cookie、匹配的 sessionId、`x-csrf-token`。
- `POST /api/ask` 校验统一 Zod schema、同书来源、sourceId 唯一性、24000 字上下文上限、PNG 头与体积。真实 Responses 请求仅包含用户提供的上下文、最多 6 条最近历史及主动选择的图片；`store=false`，没有可执行工具。
- `POST /api/tts` 只接受不超过 1600 字、0.5–2 语速的短段。返回 `audio/mpeg` 与 `x-session-id`、`x-generation-id`、`x-context-revision`。输入直接送 speech endpoint，不经过自由改写模型。
- `POST /api/cancel` 接受完整 Envelope，只取消该会话 generationId 不大于指定值的任务。AbortSignal 到达 SDK；超时和断连也取消。取消不保证退款。
- 新 generation/revision 取消旧任务；旧请求立即拒绝，即使上游忽略 AbortSignal，晚到结果仍不能发回为成功。
- `GET /api/usage` 返回本会话 records、requestCount、maxRequests 与 cache 统计。未知 tokens 和费用为 null，不显示伪造的免费价格。
- `POST /api/cache/clear` 清除当前会话的内存音频。缓存全局 32 MB / 最多 256 项 LRU，可本机配置；每次音频最多 8 MB，重启清空。键含会话、服务、模型、声音、速度与文本哈希。
- 默认会话最多 100 次请求、每分钟 30 次。最多 128 个会话，6 小时失效；这些是应用防护，不是服务商账单硬额度。
- SDK 自动重试为 0，默认 45 秒超时。失败允许用户手动重试，不自动重复计费。
- Provider 错误只返回预设中文错误和严格过滤的 request ID，不返回服务商原始消息、请求头、Key 或堆栈。
- 结构/来源校验失败时安全文本降级、板书为空；SDK 自身 JSON 解析失败返回安全错误。未做第二次收费修复请求。

## 官方接口核验

已读取安装 SDK 的 `audio/speech.d.ts` 与 `helpers/zod.d.ts`，并查阅 OpenAI Docs：

- [Structured model outputs](https://developers.openai.com/api/docs/guides/structured-outputs)：`responses.parse`、`text.format=zodTextFormat(...)` 与 `output_parsed`。
- [Text to speech](https://developers.openai.com/api/docs/guides/text-to-speech)：`audio.speech.create`、`model`、`voice`、`input`、`speed`、`response_format: mp3`。客户端需明确 AI 合成声音。

能力先是 `unconfigured` 或 `untested`，仅当前进程相应 API 请求成功后标记 supported。文本成功不自动表示视觉、TTS、转写或实时成功。上述是文档与 SDK 核验，不是账号真实接口验证。

## 验证

在 backend worktree 使用根目录已安装的项目依赖执行：

```powershell
& D:/PDF-AI-Teacher/node_modules/.bin/tsc.cmd --noEmit
& D:/PDF-AI-Teacher/node_modules/.bin/eslint.cmd apps/server tests/integration/backend.test.ts
& D:/PDF-AI-Teacher/node_modules/.bin/vitest.cmd run tests/integration/backend.test.ts
```

覆盖：Host/Origin/CSRF/Cookie、密钥缺失、显式 demo、上下文/请求 schema、sourceId 白名单、跨书隔离、大小上限、限流、会话上限与过期、刷新 generation 继承、取消与晚到结果、超时、服务商认证/权限/模型/配额错误脱敏、缺失用量、TTS 精确输入、缓存与清理。Responses/TTS 的 SDK fetch 全部注入 mock，无网络请求。

真实文字/视觉/TTS、真实中文发音与数学朗读正确性均 **未测**：需要用户本机配置凭证并明确同意最小付费验收。M2/M3 没有实现，能力返回 unsupported；不能把浏览器演示声音或文字取消称为 Realtime 打断。
