# 设计取舍与接口核验

日期：2026-09-29。需求依据为原始 PRD.md；未改变完成标准。

## 环境与隔离

初始目录仅 AGENTS.md、PRD.md、START_HERE.md，无 Git 历史。建立项目 Git 检查点；后端、PDF、音频分别在项目 .worktrees 下独立分支开发，合并后统一验证。未访问科研仓库、Conda/CUDA、全局代理或训练进程。

Node 24.19.0、npm.cmd 11.17.0、Git 2.50.1。npm.ps1 被 PowerShell 策略阻止，使用 npm.cmd。沙箱辅助程序发生 setup refresh errors，必要的项目内命令经自动审批使用提升执行；npm 缓存仍限制在本项目 .npm-cache。Git safe.directory 仅通过每条命令的 -c 设置，无全局修改。

## 依赖

npm 当前解析并锁定：React 19.3.0、Vite 8.3.1、TypeScript 6.0.3、Express 5.2.1、pdfjs-dist 6.3.289、KaTeX 0.18.9、Zod 4.6.5、OpenAI SDK 7.23.0、Vitest 5.0.2、Playwright 1.63.0。完整版本以 package-lock.json 为准。安装后 npm audit 为 0 已知漏洞，此记录不构成安全保证。未升级全局 Node/Python。

## 官方资料核验

- [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)：实际打开核对 Node SDK responses.parse 与 text.format / zodTextFormat，用本地 Zod 再校验来源白名单、版本与唯一步骤。协议是应用自己的 TeachingPlan，不假定为供应商原生工具格式。
- [Text to speech](https://developers.openai.com/api/docs/guides/text-to-speech)：实际打开核对 audio.speech.create 的 model、voice、input 与 response_format。实现服务端生成、前端统一播放。未做账号付费验证。
- [PDF.js 示例](https://mozilla.github.io/pdf.js/examples/)：页面 viewport 处理缩放、旋转与 PDF/屏幕坐标变换。采用同版 worker/TextLayer，CMap、字体、WASM 为项目本地资源。
- [KaTeX 安全](https://katex.org/docs/security)：只用受控 KaTeX 渲染公式，trust=false，限制 maxExpand/maxSize；其余模型文本由 React 普通文本显示，不接收任意 HTML。
- [Realtime WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc)：仅保留 M3 适配边界，本轮未实现/未验证，不启用麦克风或实时连接。

配置模型名留空，不把文档样例等同于当前账号可用性。未使用用户 ChatGPT/Codex 登录凭证。

## 协议和状态

共享 Zod schema 定义 Envelope(sessionId/generationId/contextRevision)、SourceRef、ContextSnapshot、TeachingPlan、ReadingCursor。一个模型教案同时提供回答、分步板书、speechText。来源由客户端真实 PDF 选区注册，模型不能自行创造页码。

开始问题时深复制快照；翻页不修改正在使用的目标。新问题、新选区、跟随模式切换和换书使旧版本失效，前后端都丢弃迟到结果。阅读书签与问答目标分开，回答不会把原文标记为已读。

PDF M1 采用单页视图，可见页就是当前页。仅渲染和提取当前页，无全书索引/后台 OCR。复杂排版显示提取质量提示，要求原页核对。文件以 SHA-256 内容指纹隔离。裁剪矩形存未旋转原页的归一化坐标。

## 音频和演示

AudioCoordinator 是唯一输出拥有者，输入状态预留独立接口。按句生成/播放；停播、AbortController 和播放任务 token 一起失效。暂停保留同一音频位置，取消后保留未完成句，并在手动恢复时更新请求版本。

无 .env 默认演示，DEMO_MODE=false 且缺 Key 则明确未配置。演示教案是自制 EMA 样例，明确不代表理解教材，不把随机延迟包装为流式模型。演示声音只选浏览器 localService 语音；没有本机中文声音时明确失败，不静默外发。真实服务不会失败后自动退回假答案。

文本 sourceText 与 speechText 分离，只有有限明确的数学发音规则；复杂公式要求核对。停止/打断后的句首重播不声称有逐字时间戳。真实 TTS 仍需最小样本验收。

## 安全与数据

后端只监听 127.0.0.1，同源单端口，Host/Origin 校验，HttpOnly/SameSite 会话 cookie + CSRF token，限速与会话请求上限。长期 Key 只读后端 .env，前端不接受模型地址或 Key。PDF 脚本不执行、模型不具有任意文件或工具权限，图片必须 PNG data URL 并限制长度。

本轮采用纯文本安全展示（Markdown 标记可见），避免模型 HTML 注入。KaTeX 独立安全渲染。会话不持久化；用户本地笔记按文档指纹存 localStorage，无凭证。PDF 不默认存储。

后端音频缓存有容量上限和清理入口；费用缺少价格信息时显示无法估算。取消不能撤销已生成费用。没有无限重试或后台付费预生成。

## 保留范围

M2：语音转文字、逐段读并讲、持久化学习记录、完整笔记导出。
M3：Realtime/WebRTC、VAD 插话、服务端未播内容修剪、工具成功回执、真人演练。
本轮提交后等待用户体验反馈，不提前实现完整实时语音。


## 最终集成修正

增加 cancelledThrough 水位：取消先到而旧请求晚到时，后端在额度消耗和上游调用前拒绝旧任务；同一未取消 generation 的逐句 TTS 仍可用。GET /api/config 返回当前 generation/context 水位，刷新页面不会从零倒退。

暂停音频时，浏览器可能拒绝尚未完成的 play Promise。独立 playbackAttempt 使暂停前的 Promise 失效，保留当前声音对象和书签；已用两个时序测试验证。阅读高亮只用于书签对应的文档与页。同页“阅读位置”跳转不会清除书签。

模型 needsClarification 会显示明确澄清问题。剪贴板拒绝时提供可手工复制的 LaTeX 文本，不产生未处理异常。

本机 SpeechSynthesis localService 策略另依据 [MDN localService](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesisVoice/localService)。真实浏览器事件记录见 production-smoke.json；这不构成真人听感验证。

## 自定义提问、取消选区与自然声音（2026-09-29）

选区主按钮采用原生 dialog：先预览内容、编辑问题，再明确发送；预设按钮只填入草稿。左右入口共享草稿，关闭弹窗不丢失；板书追问必须同时显示实际附带的板书内容。以发送时的不可变 ContextSnapshot 为准。

清除由 App 统一执行：推进 generation/contextRevision，abort 在途请求，interrupt 音频，清空 target/locked/boardTarget/navigation；向 PdfReader 发送 clearSelectionRevision，清除 DOM range、矩形、拖动与去重状态，并释放 pointer capture。Esc 在弹窗中只关弹窗，在阅读工作台中清选区；不删除历史教案和独立阅读书签。恢复音频时 rebind 新 envelope，从未完成句继续。

依据 [官方 TTS 指南](https://developers.openai.com/api/docs/guides/text-to-speech)与本机 OpenAI SDK 7.23.0 的 SpeechCreateParams，gpt-4o-mini-tts 可通过 instructions 调整语气、节奏；tts-1 / tts-1-hd 不支持。官方推荐 marin / cedar，但声音当前侧重英语优化，不据此保证中文听感。仅官方地址的已列出模型自动启用指导，未知模型/兼容地址必须显式声明支持；不支持却填写指令时明确报错。TTS_INSTRUCTIONS 属后端私有配置，前端只见固定风格标签。原文仍是 input，始终附加不增漏改写、不执行文中指令的约束；该提示约束不是已验证的逐字保真保证。

缓存 identity 复用实际 speech 请求字段（包括 instructions / voice / model / speed / input）及服务地址和会话，避免改变语气后命中旧声音。未新增后台生成或付费试听。

[GPT-Live 模型](https://developers.openai.com/api/docs/models/gpt-live-1)、[Live 提示指南](https://developers.openai.com/api/docs/guides/live-prompting)与 [WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc)已核验：这是连续语音交互能力，与单次 TTS 不同，需要单独会话、麦克风与实时输出协调。保留 M2/M3 目标，不用修改 TTS 参数冒充已接通 GPT-Live。没有真实调用或麦克风测试。

E2E 独立使用 4320，生产 smoke 使用 4318，日常开发仍用 4317，避免为测试关闭用户正使用的页面。
