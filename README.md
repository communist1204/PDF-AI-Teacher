# PDF AI Teacher

Windows 本机运行的中文 PDF 学习工作台。已实现 M0/M1 与 M2 功能：真实阅读选区、文字问答、结构化黑板、自然 TTS 适配、逐段陪读、录音转文字提问、学习记录恢复与导出。当前优先文字理论解答与独立自然朗读；已有 M3 OpenAI Realtime / WebRTC、实时插话和本机打断演练保留为可选入口。真实 API、真人插话与 20 分钟学习验收仍待完成。

## Windows 桌面版

双击桌面 **PDF AI Teacher** 图标，或运行项目内 `release/PDF AI Teacher-win32-x64/PDF AI Teacher.exe`。它自带 Electron/Node 运行环境，打开独立软件窗口并自动启动内置服务；关闭最后一个窗口就退出服务。无需先打开终端或浏览器。保留整个软件文件夹，不要只移动 exe。软件使用独立的 4319 回环端口，不占用网页开发版 4317。

登录等待或错误会直接显示在按钮下方，可以取消或重试。桌面联网使用独立 Chromium 网络会话，不修改全局代理或读取现有浏览器登录凭证。

首次使用：点击「使用 ChatGPT 登录」，在系统浏览器完成官方授权，返回软件核对账号可用的解题模型，再点「应用并重启」。登录后可用模型由账号返回；不会假装拥有 Astra 权限或静默换成更弱模型。没有登录也可用 PDF、笔记和明确标注的演示。

ChatGPT 登录授权用于符合资格的文字/看图解题请求，按 ChatGPT 计划限制使用；不读取你的聊天历史或现有登录文件。桌面朗读现默认使用免费本地 Kokoro 中文模型，无需登录、API Key 或充值，声音在 CPU 上生成，所选朗读文字不上传。设置可切换三种女声和三种男声，保存并应用后生效。只有主动选择 OpenAI 朗读才需要独立语音 Key / API 额度；登录凭证不冒充 TTS Key，也不会自动切到付费声音。

设置和本软件的账号令牌保存在 `%APPDATA%\PDF-AI-Teacher`，使用 Windows 账户加密。设置不回读 Key，不把它写进浏览器 localStorage、学习记录或导出。退出账号会清除本机该账号凭证；是否撤销服务端授权以实际确认结果为准。关闭或重启不会自动删除 PDF 学习记录；重新选择同一本 PDF 可恢复。旧网页记录与桌面记录独立，可用原有 JSON 导出/导入迁移。

开发者重建桌面包（普通使用不需要）：

```powershell
npm.cmd ci
npm.cmd run desktop:runtime
npm.cmd run tts:setup
npm.cmd run tts:build:qwen
npm.cmd run tts:setup:qwen
npm.cmd run desktop:package
npm.cmd run test:desktop -- --packaged
npm.cmd run test:desktop:restart
```

本机软件包未购买代码签名证书；分发到其他电脑时的安装提示未验收。实际登录、账号资格、专业答案与中文听感须由你授权后实测，详见 docs/verification.md。

## 网页开发版启动

需要 Node.js 22.13+；本机验证为 24.19.0。在本项目 PowerShell 终端执行：

```powershell
npm.cmd ci
npm.cmd run dev
```

打开 http://127.0.0.1:4317 。保持启动终端运行，Ctrl+C 停止本项目服务。关闭终端或电脑重启后，重新运行 `npm.cmd run dev`。使用 npm.cmd 可避免 Windows npm.ps1 执行策略限制，无需改系统策略。

没有 .env 时默认 DEMO_MODE=true：PDF 和学习记录为真实本地功能；教案是明确标注的固定样例，声音使用本机语音。演示录音不上传、不自动转写，不冒充真实 AI。


## Qwen3 朗读（新增）

这台电脑现已安装 Qwen3-TTS 1.7B CustomVoice，支持中文语气描述。声音设置 → 朗读方式 →「Qwen3 本地语音」，可选 Serena / Vivian / Uncle Fu；应用并重启后生效。当前电脑已选好 Qwen3 GPU，并保留你选择的音色，双击原图标、重新选一小段就能试听。免费本机运行，不用 Key 或充值，理论解题设置独立。声音设置中新增 CPU / NVIDIA GPU 运算设备选择；此电脑 RTX 5080 已有独立 GPU 运行库，语音模型仍为 Qwen3 CustomVoice。

跨行的同一句不再按每行拆音频；日历年份「2026年」送去朗读时转成「二零二六年」，PDF和字幕仍保留原文。有限规则不能处理所有歧义、公式与多音字，可用「校对朗读文本」。断句升级后请重新选段，旧句索引不再强行恢复。

RTX 5080 原生实测：34字完整句约2.0秒生成9.2秒音频，107字长句约3.1秒生成25.8秒音频；同34字CPU两线程约13.3秒。实际等待还受句长、显卡负载影响。等待时显示真实经过秒数，可随时停止。底部语速现可选0.25–3×，新增1.75、2、2.5、3×；本地播放保音高，实时语音另按1.5×上限明确提示。中文语气参数的 Windows 编码问题已修复。先用1×试听 [GPU短句](docs/audio/qwen-cuda-short-cold.wav) 和 [GPU教材长句](docs/audio/qwen-cuda-long.wav)。实际听感、读音准确性与OpenAI对比仍待人耳判断。Kokoro轻量声音仍可切回。

普通使用已带好模型。开发者重新构建时，使用现有Visual Studio C++ Build Tools（默认C:/BuildTools，可用进程环境PDF_AI_VS_ROOT指定），先运行 npm.cmd run tts:build:qwen，再运行 npm.cmd run tts:setup:qwen，最后桌面打包。GPU版增加 npm.cmd run tts:build:qwen:cuda，使用已有CUDA12.9，当前构建仅验证RTX5080/SM120a，不修改系统CUDA或Conda。模型约1.47GB，下载按固定revision与SHA256校验；qwen-tts-runtime留在asar外。当前二进制针对本机CPU指令集编译，其他电脑须重编并验证。网页开发版在私有.env设置 TTS_ENGINE=qwen、QWEN_TTS_DEVICE=cuda（无兼容GPU时cpu）、QWEN_TTS_VOICE=serena、可选QWEN_TTS_INSTRUCTIONS；无需改解题模型。

## 免费本地中文朗读（Kokoro轻量选项）

本机已安装 Kokoro-82M-v1.1-zh（sherpa-onnx 1.13.8，CPU 两线程），桌面包包含模型。双击原桌面图标 → 打开 PDF → 选中文字 →「朗读所选」。声音设置中选择「免费本地 AI 声音」，可切换 zf_001 / zf_002 / zf_003 女声及 zm_010 / zm_011 / zm_012 男声；默认 zf_001。更换音色后点「应用并重启」。无需配置 Key，也不用打开终端。

停顿保留原文标点；只预生成下一句，减少句间等待。语速在播放器统一调节并保留音高，避免合成和播放重复减速；最低 0.25×。自然度比较请先用 1×，极低速会改变节奏。暂停原位续播，停止/提问后按未完成句续读。遇到教材公式请用「校对朗读文本」核对读法。

同一段自制教学文字的六个真实样音在 [docs/audio](docs/audio)，合成耗时与音频检查见 [本机记录](docs/local-tts-smoke.json)。这些是 AI 合成语音，真人听感尚未验收；不宣称超过 OpenAI 或能按任意风格指令表演。解题模型和声音完全分开，选择免费声音不会降低解题模型配置。

开发者在网页模式使用时：先运行 npm.cmd run tts:setup，再在本机 .env 设置 TTS_ENGINE=local、LOCAL_TTS_VOICE=zf_001，重启开发服务。未配置此变量的网页演示仍用系统声音。安装脚本仅下载固定来源、校验 SHA256 的免费模型和项目局部运行库，不安装 Python、不修改 Conda/CUDA。其他语音方案的取舍及许可见 [decisions](docs/decisions.md) 和 [第三方声明](assets/third-party-tts/NOTICE.md)。

## 当前主流程：文字解题 + 自然朗读

按最新使用偏好，日常交互以打字为主：选中 PDF 原文或框选公式 → 输入问题 → 解题模型生成回答、推导、板书和口头讲解稿 → 点击回答下方「听这次讲解」。每步结束等待「继续这次讲解」；「从头听讲解」从第一个步骤的第一句重播，暂停与原文书签仍独立保留。文字追问会停掉当前声音。

文字/视觉模型负责理论正确性与专业细节，TTS 只朗读同一次解答的讲解稿，不再次生成答案，也不决定换成更弱的解题模型。语音服务失败保留文字和板书，不自动重问。仅需打字和听讲时，无需配置麦克风转写、Realtime 或 GPT-Live；这些已有可选入口默认折叠。

未登录或未配置本机凭证时，不能把演示样例当成专业解答。设置会显示实际配置的模型、推理强度、回答 token 预算和最长等待；配置存在也不代表账号权限或听感已通过验证。

## 先花一分钟试一遍

点击顶栏「功能体验」→「用练习走一遍」（已有 PDF 时显示「带我试读与续读」）。引导依次带你选真实文本、播放、暂停、从原句继续；不会自动开麦或播放，也不会把未做的步骤标为完成。

底部语速现在提供 **0.25 / 0.35 / 0.5 / 0.6 / 0.75 / 1 / 1.25 / 1.5×**，记住本机选择。正在朗读时改速，会停止旧声音并从当前未读完句重播；暂停时改速仍保持暂停，点继续才生效。实时讲解从下一步骤应用新速度。

选区旁可直接点「读并讲」。功能体验里还可启动分步板书或本机麦克风打断；无 Key 时板书是明确标注的固定 EMA 样例，不会针对任意问题变化。解题可以使用 ChatGPT 登录；本地 AI 朗读免费；OpenAI 声音和实时语音是需要独立 API 配置的可选项。

## 体验 M2

1. 打开示例或自己的 PDF，选择文字或框选区域。点击「针对选区提问」可每次编辑问题，再发送；右侧输入也可直接提问。
2. 选中文字后展开左下「课堂陪读」，选择逐句、逐段或只讲所选，再点「开始陪读」。可选只朗读、读并讲、只讲解。读并讲先播当前原文，再用同一 TeachingPlan 逐步展示黑板并播放讲解，每步后等待你继续。
3. 输入问题或点击「语音转文字提问」会停止当前输出、保留位置。结束录音后先检查转写草稿，纠正 beta、theta 等术语，再发送。录音最长 60 秒、4 MiB；取消、停止、离开页面会释放设备。
4. 回答后点「继续陪读」回到中断的教学步骤；普通朗读中断后点底部继续。正在听讲解时，独立原文书签可通过「回原文继续」恢复。默认不自动恢复；设置中可明确开启问答后自动继续陪读。
5. 对照 PDF 点击「校对朗读文本」，修正错字或数学读法；校对版本只用于本次朗读/陪读，原 PDF 不变，旧版本续读位置重置。
6. 「取消选中」或 Esc 清除文字、截图、高亮与提问目标，停止当前任务；保留教案和独立阅读书签。弹窗内 Esc 先关弹窗。
7. 黑板可复制公式、查看受限计算图、按来源跳转、追问或「讲这一步」。清空当前黑板仅隐藏当前显示，不等于删除学习历史。

课堂仅处理你选择的范围，不自动读完整本书。扫描 PDF 可以渲染/框选，但没有可靠转写时不能逐字朗读。复杂公式需核对原页。

## 体验 M3

1. 先选择 PDF 文字或框选区域，再展开右侧「可选：麦克风与实时语音」和其中的「实时语音」。没有 Key 可点「本机打断演练」并允许麦克风：朗读时检测到声音便暂停，点底部继续可回到原句。演练不上传、不识别你说了什么、不生成回答；噪声也可能触发暂停。
2. 配置独立实时模型后，点「开启实时语音」。连接期间，麦克风音频、所选内容和已显示黑板会发送到 OpenAI，并产生 API 费用。可以自然提问，也可以在同一课堂打字。
3. 模型先提交经过校验的教案，应用显示当前步骤并确认后才请求这一小步语音。每步结束等待你继续。可试「这一行为什么这样变」「放慢一些」「继续讲解」「回原文接着读」；实际识别和教学效果需要真人验收。
4. 开口或打字立即停止当前声音，并请求服务端清掉未播放音频；未确认清除时关闭连接，避免旧声音恢复。被打断的语音转写有标记，不能当作全部听过。实时讲解不覆盖独立原文书签。
5. 顶栏「麦克风开启 · 点击关闭」或「停止实时会话」释放输入和输出。换选区、切换窗口/隐藏页面、断线也会关闭；两分钟无交互、单次十分钟后结束，须手动重连。服务端是否确认关闭会另行显示。

本版使用 OpenAI Realtime，**未接入协议不同的 GPT-Live**。采用“确认有效提问 → 校验并显示板书 → 口述当前步骤”的节奏，声音自然度、插话延迟、扬声器回声尚未真人验证，不能保证等同 ChatGPT 语音体验。实时速度在下一步骤开始前应用；正在输出时先打断再继续。原文精确朗读仍走独立 TTS。

## 保存、恢复与导出

- 学习记录默认按 PDF 内容指纹保存到当前浏览器 IndexedDB；待提交快照暂存 localStorage，成功入库后清除，防止刚编辑就刷新丢失内容。
- 保存页码、选区、对话、教案、笔记、原文句级书签与教学步骤。不保存 PDF 文件、麦克风录音、服务会话凭证或 Key。
- 刷新/重启后重新打开同一 PDF，自动恢复记录，声音保持停止。同名但不同内容的 PDF 不会混用；断句/解析版本变化时明确要求重新选择。
- 设置 → 学习记录：导出 JSON、导出 Markdown、导入 JSON、删除本书记录。导入校验版本/来源/页码/书签，只接受本应用白名单结构。
- 删除需确认，范围包含这本书的对话、板书、笔记与书签；不改原 PDF 或其他书，删除后暂停本书自动保存，可显式重新开启。
- 每条记录最多 8 MiB、最多 50 本，不自动删除其他记录。实际浏览器配额可能更小，失败时保留当前内存并提示先导出。截图累计使 JSON 超过上限时，仍可导出不含截图的 Markdown 保留文字和板书。
- 不同浏览器、设备或 localhost 端口的数据不自动共享。清理站点数据会清除本机记录。

## 本机配置 API

仅在还没有 .env 时复制模板：

```powershell
Copy-Item .env.example .env
```

在本机编辑 .env，填写自己的 OPENAI_API_KEY、账号可用的 CHAT_MODEL / VISION_MODEL。不要把 Key 发到聊天、前端环境变量或提交 Git。质量优先的文字/看图解答与自然声音可参考下面这组配置；模型名称已查官方文档，但你的账号可用性尚未验证。GPT-6 Astra 是当前官方最高能力模型，xhigh 是本项目针对复杂教材的建议起点；支持 max，但更高强度不保证每道题都正确，仍应检查假设、维度和推导。模型/权限错误会直接报告，不自动换模型。

```dotenv
DEMO_MODE=false
CHAT_MODEL=gpt-6-astra
VISION_MODEL=gpt-6-astra
CHAT_REASONING_EFFORT=xhigh
VISION_REASONING_EFFORT=xhigh
TEACHING_MAX_OUTPUT_TOKENS=32000
TEACHING_TIMEOUT_MS=300000
TTS_MODEL=gpt-4o-mini-tts
TTS_VOICE=marin
TTS_INSTRUCTIONS=像面对面陪读的中文老师，温和自然，按句意停顿，避免播音腔。
```

API Key 填在同一私有文件的 OPENAI_API_KEY 中；OPENAI_BASE_URL 保持官方地址。可以将音色改为 cedar 后重启试听。TTS_MODEL 中的 mini 只负责发声，不是理论解题模型。更高推理强度与更大输出预算可能增加等待和费用；预算包含模型内部推理，不是屏幕字数。文字/视觉推理强度留空则不发送 reasoning 参数，适合自行配置其他兼容模型；不同模型支持的强度不同。教学默认 16000 tokens / 180 秒，可按上面示例调整；语音仍用独立 REQUEST_TIMEOUT_MS，不会跟着延长。

官方依据：[GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra)、[推理参数](https://developers.openai.com/api/docs/guides/reasoning)、[自然朗读](https://developers.openai.com/api/docs/guides/text-to-speech)。本项目没有真实付费测试，专业解答质量与中文听感仍待验。

以下是**可选**麦克风功能的原有配置，不需要语音输入可留空：

```dotenv
DEMO_MODE=false
TTS_MODEL=gpt-4o-mini-tts
TTS_VOICE=marin
TTS_INSTRUCTIONS=语气自然温和，像面对面陪读，适当停顿，避免播音腔。
TRANSCRIPTION_MODEL=gpt-transcribe
# M3 独立配置；仅支持官方 OPENAI_BASE_URL
REALTIME_MODEL=gpt-realtime-2.1
REALTIME_VOICE=marin
REALTIME_TRANSCRIPTION_MODEL=gpt-4o-mini-transcribe
```

以上为 2026-09-29 官方文档示例，**未验证你的账号权限、中文听感或实际转写准确率**。修改后重启服务、刷新网页。文字、看图、TTS、录音转写、实时语音分别配置，不把某个兼容文字服务当成全能力服务。Realtime 的实时输入转写与 M2 的录音文件转写不同：不要把 TRANSCRIPTION_MODEL 的 gpt-transcribe 直接填到 REALTIME_TRANSCRIPTION_MODEL。本版后者支持 gpt-4o-mini-transcribe、其 2025-12-15 快照、gpt-4o-transcribe 或 whisper-1。启动应用不会自动连接付费实时会话。

自然 TTS 支持语气指令；可尝试 marin / cedar，官方说明声音侧重英语优化，不保证中文听感等同真人。tts-1 / tts-1-hd 不支持 instructions；未知模型或兼容地址需先查文档，再显式设置 TTS_SUPPORTS_INSTRUCTIONS=true。

真实 API 费用独立于 ChatGPT 订阅。选择「读并讲」会在读完本段后请求教案；每个语音步骤只生成当前需要的句子，不后台预生成整章。API 模式下结束录音会上传该录音转写，之后仍需确认文字才发送问答。界面显示可取得的用量、模型和取消状态；无价格信息时明确无法估算。本轮没有付费测试。

## 检查与生产构建

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd test
npm.cmd run build
npm.cmd run test:e2e
node scripts/verify-production.mjs
npm.cmd start
```

E2E 用 Microsoft Edge、独立演示端口 4320；生产 smoke 用 4318；日常服务为 4317，可并行运行。测试不自动杀其他进程。测试截图位于 docs/screenshots，HTML 报告位于 playwright-report。

生产 `npm.cmd start` 需要先构建 dist，仍使用项目局部 tsx 和后端源码。端口冲突时停止自己启动的本项目实例，或在 .env 配置 APP_PORT。

## 验收边界

[进度](docs/progress.md)、[决策](docs/decisions.md)、[验收](docs/verification.md)区分本地功能、模拟接口/合成输入、真实付费接口和真人听音。

目前通过本地自动化验证，不代表 M2/M3 真人验收完成。M3 浏览器测试实际建立的是本机两个原生 RTCPeerConnection，模型事件和服务响应为模拟、输入为合成声音；它不能证明官方服务连接或真人插话效果。仍需真实中文麦克风、真实转写/TTS/Realtime、20 分钟学习、回声与中文公式发音验收。服务端未确认关闭时不承诺已停止计费；连接时长不是供应商计费时长。
