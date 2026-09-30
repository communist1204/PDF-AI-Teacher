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

## M2：课堂、转写与学习记录（2026-09-29）

用户明确要求进入下一阶段后实施 M2；此前章节描述的是 M1 当时状态。未改 PRD 完成标准，未提前启用 M3 Realtime。后端转写、输出音频、记录存储分别在项目内独立 worktree 开发，合并后统一集成与验证，没有并行修改同一文件。

### 课堂与声音

ClassroomController 只处理用户所选的逐句/逐段单元。只朗读、读并讲、只讲解使用同一 AudioCoordinator；原文书签独立于解释队列。原文结束才申请本单元教案，提交当前板书后播放同一 TeachingPlan 的 speechText，每步后等待继续，不预生成整章。只有收到当前 envelope 的真实播放开始/结束事件才确认步骤完成。新问题与模式切换同时取消输出及上游请求，拒绝旧 generation。

同会话恢复可保留解释中的句位置；持久化恢复解释到未完成步骤开头，原文则恢复经文本版本/句 ID 核对的句书签，不伪装逐词精度。手动继续为默认；自动恢复是明确可选项。朗读校对生成新版本，不修改 PDF 原文或既有教案。重复 stepId 必须同时核对来源和 speechText，不能串用另一回答的音频。

图示限定为最多 8 节点、12 边的 schema，校验唯一 ID 与边端点，用固定 SVG 组件和普通文本显示。模型不提供任意 SVG/HTML/JS。清空黑板只隐藏当前内容，删除历史从学习记录入口单独确认。

### 转写接口核验与输入边界

2026-09-29 实际打开 [官方 Speech-to-text 指南](https://developers.openai.com/api/docs/guides/speech-to-text)和 [TypeScript 转写接口](https://developers.openai.com/api/reference/typescript/resources/audio/subresources/transcriptions/methods/create)，并核对本机 OpenAI SDK 7.23.0。完成录音使用 audio.transcriptions.create，经 /v1/audio/transcriptions 发送 multipart file/model，解析 JSON text；SDK toFile 保留文件名与 MIME。官方指南当前推荐 gpt-transcribe 作为录音文件转写起点，模板只作注释示例，TRANSCRIPTION_MODEL 默认留空，不声称账号已可用。可选供应商字段未纳入未经验证的假设。

浏览器独立 MediaRecorder 输入状态，点击录音立即取消输出但保留阅读位置。最长 60 秒/4 MiB，20 秒权限等待，静音/空录音/格式检查；取消、隐藏、离线、卸载释放设备。权限请求不能强制取消时，迟到设备仍立即停止。DEMO 录音只本地体验后丢弃，不上传、不编造文本；API 模式结束录音才上传转写，结果只填可编辑草稿，发送问答仍需用户动作。

前后端转写能力与文字/TTS 独立。复用回环、Host/Origin、CSRF、会话、限额和请求版本校验；重入 generation 拒绝，无自动重试。前端以有界 JSON 传音频，后端检查字节/MIME/文件头再调用 SDK。取消不代表免除已产生费用。客户端录音时长不是供应商计费用量；仅显示上游实际返回的 audioSeconds，无价格时显示无法估算。未调用任何真实收费接口。

### 本地记录与恢复

采用 IndexedDB 按 PDF 内容指纹隔离的 version 1 白名单记录，保存页码、真实目标、问答、教案、笔记、原文句书签与教学步骤/偏好。文件指纹、页数、解析版本、来源与文本版本均校验；导入未知字段拒绝。最多 50 本、单条最多 8 MiB，达到限制报错且保留内存，不静默淘汰其他书。PDF blob、原始录音、API Key、CSRF/服务会话凭证不进入记录。

IndexedDB 不能保证刷新前的异步写入完成，因此将同一白名单快照同步暂存 localStorage，再串行入库；仅在确认写入的是同一快照后清除。刷新时取匹配本书的较新有效快照，不自动播放。localStorage 也有容量限制，失败提示先导出，不能保证绕过浏览器配额。加载期间暂时禁止编辑，防止迟到的旧记录覆盖新操作。

导入与删除先暂停自动保存并排空队列，异步结果再核对当前文档；成功持久化后清理恢复快照。删除仅作用于本书、清空对应当前状态并暂停自动保存，用户可明确重启保存；其他书保留。JSON/Markdown 均从校验后的记录导出。刷新/浏览器重启后需要重新选择原 PDF，不承诺跨设备、端口或浏览器共享。

### 验收界限

140 项单元/模拟接口和 28 项 Edge 场景通过，包括真实 MediaRecorder 管线的合成音/静音输入与 20 次模拟输出打断。合成输入不等于真人麦克风，20 次循环不等于 20 分钟学习，SpeechSynthesis 事件不等于中文听感通过。真实模型、转写、TTS 与真人长时验收仍待完成；保留 M3 全双工、直接开口打断、回声和未播内容修剪目标。

最终记录边界修正：替换记录的操作锁由 App 持有，关闭/重开设置不会解除；忙碌期间禁用重复删除和重新开启保存。JSON 保存/导入/导出维持 8 MiB 上限；Markdown 不包含图像，沿用结构/来源/未知字段校验但不受 JSON 总字节限制，用于截图累计超限时保留文字笔记和板书，不声称它能完整还原图像记录。

## M3：Realtime、打断和可确认板书（2026-09-29）

用户明确要求继续下一阶段后实施 M3。本节取代前文“仅保留 M3 接口”的历史状态；需求文档原样保留。后端、音频协调器与协议测试在独立 worktree 完成并 cherry-pick，主目录负责集成。

### 接口选择与核验

应用 openai-docs 技能，先核对本地 OpenAI SDK 7.23.0，随后实际打开官方文档。使用 [Realtime WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc) 的 POST /v1/realtime/calls：后端提交 multipart sdp/session，session.type=realtime，保留 Location 中供应商 call ID。前端只得到 SDP 和本应用随机 connectionId；通过后端 [hangup](https://developers.openai.com/api/reference/typescript/resources/realtime/subresources/calls/methods/hangup) 关闭。模板 gpt-realtime-2.1、marin 为文档样例，不是账号可用性或实际质量保证。

[Realtime transcription](https://developers.openai.com/api/docs/guides/realtime-transcription) 的 WebRTC 输入转写独立配置，示例 gpt-4o-mini-transcribe；不复用 M2 录音文件的 gpt-transcribe。后者当前文档的实时模式要求 WebSocket committed-turn 接口。本版只支持已核对的 WebRTC 转写模型与官方地址，兼容文字服务不推断为支持实时音频。

[Live conversations](https://developers.openai.com/api/docs/guides/live-conversations) 与 [Live server controls](https://developers.openai.com/api/docs/guides/voice-server-controls?api=live) 是不同协议。GPT-Live 偏连续全双工，未提供与本版 Realtime 输出清除/未听历史修剪完全对应的保证。当前优先落实 PRD 的板书成功回执、逐步讲解、未播上下文修剪，选 OpenAI Realtime；不把不同接口包装成已接通 GPT-Live。自然语气只写为提示目标，不声称效果已达真人水平。

### 输入、声音所有权和取消

依据 [Realtime VAD](https://developers.openai.com/api/docs/guides/realtime-vad)，server_vad 配置 create_response=false / interrupt_response=true，应用收到有效转写才自行 response.create。另用浏览器 AudioContext RMS 作本机快速停音，不把有声音直接当成有问题；本地检测不递增语义轮次，避免和服务端重复检测互相作废。有效转写长度/重复 item/上下文/轮次均校验，不能保证真实 ASR 从不把噪声转成文字，需真人实测。

AudioCoordinator 拥有唯一输出，实时声音通过外部 lease 互斥。交接同步停原文，释放旧 lease 不影响新音源；不删除独立原文书签。不用新服务挂断结果覆盖重连会话。音频元素事件、play Promise、数据通道异步错误同时校验 epoch 与元素身份，避免停止后的旧回调关闭新会话。

按 [Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations) 和 [client events](https://developers.openai.com/api/reference/resources/realtime/client-events)，打断先本机静音，再 response.cancel + output_audio_buffer.clear；等待匹配 cleared 回执，2.5 秒未确认关闭连接。WebRTC 清除会由服务端处理未播放历史的截断；不使用 HTMLAudio.currentTime 伪造 audio_end_ms。取消最终状态是 response.done 的 cancelled，而非依赖不存在的 response.cancelled。真实服务的修剪效果仍待真实接口验收。

response.done 只代表生成结束。步骤完成需当前响应的 output_audio_buffer.started/stopped、浏览器 playing 与有效输出 lease 同时成立；这证明播放器事件链，不证明人耳已听到。被打断/播放未确认的转写明确标记，不放入后续普通文字问答的已听历史。中断实时步骤从该步骤重播，不承诺逐词续播；原文维持独立句级锚点。

### 教案和工具确认

实时 response.metadata 携带本应用 sessionId/generationId/contextRevision/turn；所有迟到回复拒绝。仅接受 present_teaching_plan、focus_board_step、control_reading、get_learning_context；每次一个工具、最多三个短教学步骤、限定参数大小/来源/操作数量，无文件系统、网络或任意执行权限。PDF 与板书始终是数据。

response.function_call_arguments.done 可能来自取消/不完整的响应，因此等 response.done completed 后才验证并执行；React 实际提交板书后返回 function_call_output 成功回执，再单独生成同一 TeachingPlan 当前步骤的语音。opId 幂等，冲突参数拒绝，过期重放不能返回成功；工具超时不确认执行。定位只允许实际已展示的步骤，不猜未显示的“第二行”。

放慢通过全局语速偏好控制下一步骤，先 session.update.session.audio.output.speed，等匹配 session.updated，再请求音频；不发送无效的 response.audio.output.speed。停止、新问题和五秒超时都会取消旧设置等待。原文恢复工具回执代表播放队列已接收，播放器失败另行反馈，不表示已经听完。

### 会话寿命、数据与用量

后端复用 Host/Origin、CSRF、会话所有权、版本和限流。每个本地会话最多一个待连/活动实时连接，SDP 上限 64 KiB，连接交换与 hangup 有界；迟到交换成功也清理。前端每十秒心跳，后端三十秒没有心跳关闭、最多十分钟；前端两分钟无交互关闭。页面隐藏/失焦/离线/换目标/停止释放 tracks、RTCPeerConnection、AudioContext、播放器和定时器，不自动重连。

这些是本机策略，不能当作服务商计费硬上限。hangup 超时/网络失败/进程退出无法确认时显示未确认；连接时长只是本机时长，tokens/audio/费用未知就保留未知。前端实时面板仅累计供应商实际返回的 response.usage，不推算音频账单。未上传真实录音，未调用付费接口。

每 100ms 音量状态更新不应无限推迟记录保存，因此自动保存依据记录内容变化调度，不按每次渲染重置计时。持久化保留对话的播放状态；不保存 realtime call ID、凭证、原始音频或麦克风流。未完成/中断语音在导出中仍有标记。

## 慢速朗读与可操作体验（2026-09-29）

按用户“语速还要慢一些、看不出功能”的反馈，先完善 M3 可体验性，不把缺 Key 的真实模型验收跳过后转做 M4。保留 PRD 的真实状态、演示标识和句级恢复要求。

语速范围再次核对本机 SDK 7.23.0，并实际打开 [TTS create](https://developers.openai.com/api/reference/typescript/resources/audio/subresources/speech/methods/create) 与 [Realtime client events](https://developers.openai.com/api/reference/resources/realtime/client-events)：TTS 支持 0.25–4，项目保持上限 2；Realtime session.audio.output.speed 支持 0.25–1.5 且轮次间应用。shared/speechRate.ts 集中下限 0.25，UI、后端 schema、AudioCoordinator 和实时语速一致，不在隐藏层钳回 0.5/0.75。界面上限仍是 1.5，额外提供 0.35/0.5/0.6 档。

运行中的 Windows SpeechSynthesis 不保证接受直接修改 utterance.rate；把 2 倍生成音频再以 playbackRate=0.125 播放也可能遇到浏览器范围/静音限制。因此改速时同步撤销旧输出，从当前未完成句按新速度重新合成；paused 状态不自动发声，继续时才生成。缓存包含速度，重复低速句可以复用。API 模式新速度可能产生新的 TTS 请求，既有费用不能撤销。语速偏好仅存本机 localStorage，不含凭证；存储不可用时当前播放仍可用。

Realtime 的首音等待仍有固定上限；开始播放后的看门狗按速度放宽，0.25× 最多 480 秒，仍受十分钟总会话限制。活跃输出不计两分钟闲置，播放结束重新计时；不取消清除回执/心跳/资源释放限制。

体验入口包含明确动作而非功能罗列。试用选段通过实际 PDF.js 文本层 DOM Range 生成文本、坐标和 sourceId，找不到合适文字时提示手选；打开说明不自动开麦、发声或调用模型。引导只有观察到同来源原文播放、暂停/打断、同 sentenceId 恢复才显示完成；自然读完回到可重播状态，不误报完成。分步板书在 DEMO 明说固定 EMA，API 模式明说会发送选区并计费。图片没有可靠文字时不提供不可完成的朗读打断路径。

顶栏麦克风在等待权限/建立连接时显示“语音准备中”，不将 connecting 当作已经监听。功能说明的 Esc 只关闭弹窗，不清选区。调用分步讲解时关闭原文试用引导，重启试用重新观察真实状态。已有 PDF、笔记、音频书签、课堂与真实 API 适配继续走原实现。

## 文字解题优先，声音独立负责朗读（2026-09-29）

用户明确交互不需要人声输入，专业教材回答应使用最高能力的理论推理模型。本轮据此将默认入口改成打字提问与听讲解；不继续 GPT-Live 集成，保留已有 M2/M3 可选功能及原验收记录，未改 PRD 完成标准。

采用已有 Responses → TeachingPlan → TTS 流程。强模型一次生成 answer、推导板书、speechText，后者保留条件、符号关系和关键论证；TTS 不接受独立解题任务。用户手动点击声音按钮才朗读，不自动付费生成音频。失败不自动重问或换模型。未对任何模型作“专业问题绝对正确”的承诺。

官方已重新搜索并打开：[GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra) 为当前最高能力模型，支持图像输入和 Structured Outputs；[推理指南](https://developers.openai.com/api/docs/guides/reasoning) 说明 effort 和推理 token 预算；[TTS](https://developers.openai.com/api/docs/guides/text-to-speech) 支持自然语气指令与 marin/cedar。质量配置示例为 Astra + xhigh + 32000 tokens / 300 秒，纯本机建议，账号权限未测。模型字段继续留空，不把查过文档等同用户账号已验证。

新增 CHAT_REASONING_EFFORT / VISION_REASONING_EFFORT，空白不传，以保留其他模型兼容性；专用 TEACHING_MAX_OUTPUT_TOKENS（默认16000）和 TEACHING_TIMEOUT_MS（默认180000）仅控制解题，不扩大 TTS/转写/实时请求期限。/api/config 只公开模型参数，不公开 Key。Responses SDK 7.23.0 的 ResponsesParser 对 incomplete 状态不解析半段JSON，本地已核对；服务显式报告截断并保留已知用量。

「从头听」显式重置讲解句索引；暂停/续读保留原粒度。回答的完成提示依据实际播放完成的步骤集合。截图提问显示视觉模型；可选实时模式开启后保留既有文字同会话行为，并在界面明确告知会使用实时模型。

## 桌面软件与官方 ChatGPT 登录（2026-09-30）

用户明确要求双击图标启动本地软件，并希望直接登录 ChatGPT。本轮据此进入桌面封装范围，保留原 PRD 和网页开发方式。选用项目局部 Electron 44.5.0、@electron/packager 20.3.0、esbuild 0.28.2；内置 Express 服务与窗口同进程生命周期，固定 4319 与独立持久化分区。软件自带运行环境，不要求用户安装全局 Node，也不做系统常驻或改全局代理。

重新核验 [Sign in with ChatGPT 本地应用计划授权](https://developers.openai.com/siwc/token-sharing-open-source)：官方提供本地动态客户端注册，商业伙伴 client ID 申请不是这一流程的先决条件。使用自己的 host ID、回环 callback、state/nonce/PKCE、签名 ID token 验证；不读取 ChatGPT/Codex 的已有 cookie/token。模型目录来自授权后的账号，不保证固定模型可用。OAuth 与 API Key 路径独立，拒绝自动跨计费路线重试。

OAuth Responses 使用 store=false、stream=true、input 数组与 instructions，直到完成事件才接受完整教案；不发送该路径禁止的 max_output_tokens 等参数。教学等待上限仍有效，UI 区分预算配置与此路径实际支持。语音接口未获此授权文档确认，仍单独使用用户可选 API Key。

桌面主窗口开启 contextIsolation、sandbox，关闭 Node 集成；IPC 校验主窗口/主 frame/精确来源，外链只走固定白名单；随机实例请求头拒绝其他浏览器访问内置服务。原 Host/Origin/会话/CSRF/限流不移除。权限检查默认拒绝媒体，仅用户明确确认的纯音频请求可用，摄像头拒绝。凭证只由主进程加密保存，使用 Electron safeStorage 的 Windows DPAPI；不宣称能隔离同一 Windows 账户下的恶意程序。

打包采用白名单 staging，只包含生产前端、后端/桌面 bundle 和应用资产，不复制项目目录、.env、测试配置或账号数据。数据目录独立于 release，重建程序不删除学习记录。保存设置前调用与启动相同的配置校验，避免无效 TTS 指令导致下次无法启动。


首次启动在调用 Electron setPath 前创建本软件专用数据目录，并给出失败提示；不要求预建目录。退出前取消上游任务，在有界等待内排空账号和加密文件写入队列；超时仍不承诺远端撤销或磁盘完成。账号退出使在途模型目录请求失效，避免旧账号数据回填。真实 exe 测试从不存在的 profile 开始，避免预创建目录掩盖首次启动问题。

官方协议细节依据：[登录与动态注册](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)、[账号模型与推理](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)、[会话与撤销](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)、[预览限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)。这些资料支持实现选择，不代表本机账号已经授权或真实服务验收通过。


## 桌面登录网络与反馈修复（2026-09-30 13:15）

实际复现 Node fetch 请求公开 OIDC discovery 返回 403/HTML；同机 PowerShell 与 Electron Chromium 请求均能得到 200/JSON。错误发生在 openExternal 之前，不能归因于用户没点对按钮。采用 [Electron net/session fetch](https://www.electronjs.org/docs/latest/api/net) 的 Chromium 网络栈与既有系统网络配置；仅应用内注入，不修改全局代理、TLS 校验或系统安全设置。

使用独立非持久化 provider session，强制 credentials=omit、cache=no-store、redirect=error，保留 AbortSignal 与流式 Response。网页登录 cookie 不作为凭证；OAuth 仍使用自己的 PKCE、state、nonce 与经验证的令牌。注入点覆盖 auth discovery/token/JWKS/refresh/models、ChatGPT Responses、独立 API Key 的问答/TTS/转写与可选 Realtime，网页开发版默认网络方式不变。SDK通过显式 Response 构造器识别 FormData，避免 Chromium 不支持的 data: 探测。

登录等待/失败/成功/取消紧邻按钮并使用 live region；错误出现滚到反馈处，720p 可见。预检失败明确说明登录页尚未打开、HTTP 状态，不回显上游 HTML。保留失败后重试，不因失败切换计费路线。[OpenAI 官方登录流程](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) 的授权/验证步骤未缩减。


## 免费本地 TTS 的选择与实现（2026-09-30）

### 质量目标与方案比较

用户的重点是中文陪读的自然语气与句读，理论回答继续交给单独的强推理模型。用户允许查找免费项目并接入；未授权付费对比请求，也未授权改变现有科研运行环境。

| 方案 | 官方核验与本轮决定 |
|---|---|
| [Kokoro-82M-v1.1-zh](https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh) + [sherpa-onnx](https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/kokoro.html) | 82M、多中文音色、24kHz；可用官方 Node CPU 推理，Windows不需Python/GPU，适合现有桌面包。选为可直接落地试听的轻量方案。作者也说明此版本有训练和声音质量限制，不把它宣传为最高音质。 |
| [Qwen3-TTS-12Hz-1.7B-CustomVoice](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice) / [官方源码](https://github.com/QwenLM/Qwen3-TTS) | 支持中文及自然语言风格控制，更符合用户对语气的长期要求。官方指令控制评测有超过gpt-4o-mini-tts的项目，但不是本机试听、不是全维度音质胜出。约4.52GB权重并需独立Python/PyTorch运行时；本机CPU速度未测，未安装，不把Qwen ASR误当TTS支持。 |
| [Fun-CosyVoice3-0.5B](https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512) | 专业语音生成、读音和风格控制值得后续比较，依赖与参考音频流程更复杂，本轮未部署。 |

不采用把 Microsoft Edge 内部朗读端点当作稳定免费 API 的方法，也不依赖未知额度的在线试用。系统声音保留为明确的低配置备用选项，不暗中替代AI声音。最高目标「比OpenAI更好听」须同文同速度真人比较：人声自然度、断句停顿、中文多音字/数字/英文术语、长句、低速听感。六份本地样音已准备，尚无用户评分。Kokoro不支持界面原先给OpenAI的任意风格指令，因此本地设置不展示无效的「朗读语气」输入。

### 固定来源、隔离与播放

安装脚本 scripts/setup-local-tts.mjs 固定下载官方 sherpa 发布的 kokoro-multi-lang-v1_1.tar.bz2（364816464 bytes），SHA256=a3f4c73d043860e3fd2e5b06f36795eb81de0fc8e8de6df703245edddd87dbad；分段恢复、全文件校验后才解压到项目 local-tts-runtime/model。原始档案与大模型目录忽略Git。打包只复制指定模型/运行库/worker/许可，不复制用户数据或Key。模型Apache-2.0、sherpa Apache-2.0、ONNX Runtime MIT；现版本还含espeak-ng GPL组件，完整包不标成纯Apache，许可保留在assets/third-party-tts和软件resources里。详见其中NOTICE.md。

使用独立、隐形的CPU worker，最多两线程；不安装Python、不访问GPU或修改系统代理。子进程不继承API凭证、NODE_OPTIONS或调试参数；超时/取消只结束本实例启动的进程。文本、voice和WAV均有长度与类型验证，失败消息不泄漏路径/文本。模型ready只代表文件存在，最终以实际合成和播放测试验证可用。

真实Electron测试发现两项仅Node单测无法覆盖的差异：跨V8版本的advanced IPC序列化不兼容，以及Electron不支持原生外部ArrayBuffer。改为有界JSON/base64 IPC，严格解码并检查WAV结构；调用sherpa generate时enableExternalBuffer=false。原生库留在asar外，不打入网页。

本地合成固定原始1×，HTMLAudio.playbackRate统一应用速度且preservesPitch=true；缓存不因播放速度重复合成。本地允许提前生成下一句，只有一个输出播放器；付费云模式不预生成。暂停、停止、新问题、换目标取消未使用结果；迟到结果不能复活。保留标点与原文，不用字符串改写伪造更自然的内容；复杂公式仍需原页校对。最低0.25×只保证播放器接受和音高处理开启，不保证极低速自然度。

免费CPU请求记录local=true，不消耗付费API会话预算或显示「可能已计费」。问答、TTS、麦克风能力独立；没登录或DEMO不再拦住本地合成。旧桌面设置自动补充local引擎与zf_001，保留账号、Key和解题模型。OpenAI仍只在用户显式选择且具备Key时使用，无失败自动代付。

### OpenAI 429反馈修正

核对本机SDK与[官方错误说明](https://developers.openai.com/api/docs/guides/error-codes)，SDK请求标识为requestID，旧request_id仅作受限兼容。支持顶层/嵌套code、type，不回显任意响应字段。429按明确code区分余额、项目/组织预算与临时速率；未知429保留原因不明，不直接推断欠费或限流。测试使用真实SDK+本地模拟响应，没有付费调用。

最终复核补充：预生成失败按请求对象身份丢弃，不污染下一句；到达下一句才做普通前台尝试，禁止重试循环。local/system忽略隐藏云TTS语气配置，切回OpenAI仍严格校验。


## Qwen3 第二种本地语音与语义读法（2026-09-30）

用户反馈 Kokoro 的跨行卡顿和年份读法错误，因此同时处理应用分句与模型选择。依据 [Qwen 官方项目](https://github.com/QwenLM/Qwen3-TTS) 和 [1.7B CustomVoice 模型卡](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice)，选择具有中文和自然语言语气控制的 1.7B CustomVoice；不是语音识别模型，不承担专业理论解答。模型能力介绍不等于本机音质已经超越 OpenAI，没有付费同文对比。

官方 Python/PyTorch 路径需要较大的独立运行时。现找到可在 Windows 原生 CPU 编译的 [qwentts.cpp](https://github.com/ServeurpersoCom/qwentts.cpp)，因此本轮改变上一轮「只研究 Qwen」的决定，实际部署社区 C++ 运行时及 GGUF 量化权重；不将社区实现标为官方二进制。没有安装 Python/Conda/WSL，未修改 CUDA、全局代理或科研进程。

固定源码 6fae92914045cd83364d2845ceaa0f7969727319；GGML 40e16e4a814f7fe851a0c486fb9e8c722e957830。使用已有 C:/BuildTools 的 MSVC 19.44、CMake 3.31.6；全部 GPU backend 关闭、静态 VC 运行库，仅依赖 KERNEL32.dll/ADVAPI32.dll。GGML_NATIVE 构建使用本机 AVX512，当前 exe 是这台电脑的构建，不能承诺任意 Windows 电脑可用。补丁仅限制默认两线程（可明确选四线程）并标识触及生成帧上限，达到上限拒绝截断音频。构建脚本 scripts/build-qwen-tts.mjs 安装到 qwen-tts-runtime/bin；模型与编译器均不在 Git 里。

量化来源 [Serveurperso/Qwen3-TTS-GGUF](https://huggingface.co/Serveurperso/Qwen3-TTS-GGUF/tree/b7ee2e8c7459c3bea99da23e3d178125a7d1713c)，固定 revision b7ee2e8c7459c3bea99da23e3d178125a7d1713c。talker 1,182,631,296 bytes，SHA256 cc328834a631bc08bf9f43e62fa23f8a1383d9b429864ce6690cfb172077fc4a；codec 291,150,624 bytes，SHA256 1883beeed99348fc35e23dd225e9082f93f6f8c109330a33d935baa8acdbfd94。安装脚本分段续传、检查 Content-Range 并核对完整 SHA256 后写 manifest。curl 本机无法连接，改为 Windows .NET HttpWebRequest 使用既有网络设置，无代理改写。模型 Apache-2.0、运行时及依赖许可放在 assets/third-party-tts/NOTICE-qwen.md 及软件资源目录。

每次仅启动本应用拥有的隐藏 CLI 进程：原文 UTF-8 stdin，语气独立参数，输出私有临时 WAV，不启用未经认证的第三方 HTTP server。子进程仅继承必要 Windows 目录变量，不传 Key、PATH 或 NODE_OPTIONS；CPU 两线程，5分钟上限，取消只终止自有子进程，等待退出并清理临时文件。严格验证24kHz PCM16单声道WAV及8MiB上限，截断标记跨stderr片段保持，读取音频后再次检查取消。固定 seed=42 方便同文同风格复现，不据此保证逐字正确。

前后端 speech.engine=qwen 复用唯一 AudioCoordinator、会话版本、防过期、句书签、1×合成/播放器调速和有界缓存，仅免费模式预生成下一句；不会自动切到付费或系统声音。解题账号与模型不随声音改动。CPU生成慢于实时，预取不保证句间零等待；本轮没有侵占GPU以追求速度。

PDF 单换行视为物理排版，中文相邻不插空格、拉丁文字保留词间空格，段落空行/列表/独立公式保持边界，最多300源字符。年份只对1000–2999后接「年」且未命中时长/编号/代码数学上下文的有限情形逐位读；sourceText 完整可还原。采用显式读法处理以免把模型自然度能力误作可靠数字理解。断句及读法改变要求 sentence-v2，不沿用旧句索引。


## GPU 朗读、Windows UTF8 与业界方案（2026-09-30）

用户明确同意检查GPU，覆盖最初PRD“不要求GPU”的默认部署假设；仍保留CPU选项。只用已有CUDA12.9编译，GGML_BACKEND=CUDA0仅设于本应用拥有的语音子进程，关闭其他GPU后端、静态cudart、动态cuBLAS DLL与exe同目录，不修改PATH。当前SM120a构建只验证本机RTX5080，不声称兼容所有NVIDIA卡。manifest记录二进制和两个DLL哈希，保留原CUDA EULA。

原故障并非单一CPU性能问题。上游CLI main未调用既有utf8_init；Windows argv中的中文语气被错误解码，而stdin原文是UTF8。独立补丁修复后同文seed42 CPU/GPU均正常EOS；保留失败和修复报告，不通过换短文本掩盖。CPU/GPU浮点后端生成长度存在差异，同seed不保证逐样本一致，更不等于声音质量一致。

保持一段完整句子输入、下一句预生成、统一播放器与取消。原生流式0.87秒首PCM复验已通过，但浏览器增量播放、缓存完整性、暂停续播和背压尚未联调，实验适配器不合入产品。本轮交付稳定整句GPU生成，避免为追求首包时间再次按PDF换行切句。

专用云TTS也是可选方案：[豆包HTTP Chunked接口](https://docs.volcengine.com/docs/DoubaoVoice/unidirectional-streaming-text-to-speech-http?lang=zh)接受完整文本并返回流式音频，[官方概述](https://docs.volcengine.com/docs/DoubaoVoice/ProductOverview-7?lang=zh)的约600ms首包只是供应商参考；[腾讯实时合成](https://cloud.tencent.com/document/product/1073/94308)使用WebSocket。两者需独立账号/凭证和额度，不把消费者应用免费朗读等同于第三方API永久免费。腾讯[2026年8月计费说明](https://cloud.tencent.com/document/product/1073/34112)按音色等级区分免费量与期限，不能把基础音色额度套给超自然音色。未开通或付费测试。微信官方资料有文章朗读功能，但未找到当前底层模型及缓存方式的可靠公开说明，故不推断。

离线候选[CosyVoice3](https://github.com/QwenAudio/CosyVoice)、[VoxCPM](https://github.com/OpenBMB/VoxCPM)有流式实现，论文/项目硬件延迟不是此Windows本机体验；未安装第二套Python/GPU环境。鉴于当前Qwen GPU已明显加速，先让用户对同文实际试听，再决定是否引入另一个引擎。不能宣称本机音色已超越OpenAI、豆包或腾讯。

3倍速扩展：共享朗读范围0.25–3，UI新增1.75/2/2.5/3并保存；本地始终1×生成、播放器调速/保音高，因此3×不会重复合成或加倍应用速度。云TTS已核对当前SDK及[Speech接口](https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create)支持0.25–4，产品保守开放3；没有付费调用。Realtime保留既有1.5上限，UI说明实际限速，绝不把3发送给实时接口。


## 2026-09-30：原位变速、公式转读法和独立豆包语音

- 把声音质量、文本读法和播放控制分开处理。Qwen/Kokoro及豆包生成原速音频，AudioCoordinator只修改同一个HTMLAudio的playbackRate，保留currentTime、暂停状态和下一句预取；OpenAI按供应商速度生成与系统speechSynthesis仍保留原来的句首改速边界，界面分别说明。
- 不把“音色变化”解释为已发现自动换引擎。现有实现没有自动fallback，但每句独立的生成式合成仍可能声线/语气漂移，高倍速也会缩短下一句准备时间。本轮固定所选voice，不声称仅修改播放器就能消除模型漂移；真人同文比较未完成。
- 引入有界纯解析器，将明确的LaTeX/Unicode公式转成中文符号读法；分式显式说明分子与分母边界。它不推断字母的理论含义，不恢复PDF丢失的二维结构，不执行LaTeX或外部命令。未知命令/操作数缺失/乱码/不明确分母范围要求校对；取消旧checkbox直接放行原始公式的路径。字幕与书签原文保留，校对窗口显示真正送入TTS的文本。
- pronunciation/segmentation升级sentence-v3，旧v1/v2书签失效，避免把旧句索引硬套到新分段。已知公式展开过长时同样要求缩短或改写；播放与预取入口均检查。
- 用户授权联网并优先尝试官方免费额度，增加火山引擎豆包Speech2.0独立可选声音，而不改变专业理论解答模型或当前Qwen GPU/UncleFu设置。专用Key只在本机加密vault/后端环境中保存，public config仅暴露存在状态；OpenAI Key与解题账号独立。
- 核验依据：[官方HTTP接口](https://docs.volcengine.com/docs/DoubaoVoice/unidirectional-streaming-text-to-speech-http?lang=zh)、[字节官方示例](https://github.com/bytedance/agentkit-samples/blob/main/skills/byted-text-to-speech/scripts/text_to_speech.py)。使用固定openspeech.bytedance.com的V3单向HTTP接口、X-Api-Key、新资源seed-tts-2.0；官方示例同时给出SSE变体，本实现使用NDJSON HTTP变体。公式参数enable_latex_tn/latex_parser=v2保留，但本应用优先发送可审核的中文读法。
- 云响应有120秒超时/8MiB上限、完整结束帧验证和取消；PCM包成完整WAV。未接前端流式播放，不宣传“秒出声”。未知用量为null，不把原文字数当作供应商账单。无启动/保存自动试听、自动重试、无自动回退、不预生成云端下一句。
- 没有核实每个新账号的Speech2.0免费额度，不能把旧版免费额度或腾讯其他音色额度套用。界面要求用户在[官方Key控制台](https://console.volcengine.com/speech/new/setting/apikeys)确认服务/音色/免费额度，免费用完可能计费；本软件无法读取云账户余额。当前没有真实豆包凭证与免费额度确认，真实接口和听感待验，不能承诺优于OpenAI。
