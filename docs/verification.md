# M0/M1/M2/M3 验收记录

## 2026-10-04：豆包入口恢复与本机新 Key 配置

- 修改前完整读取项目约定与需求；根仓库起始 HEAD 3278ec6，工作区干净。Node 24.19.0、npm 11.17.0、Git 2.50.1.windows.1。后端使用独立 worktree，最小改动 cherry-pick 为 8b809fb。只操作本项目，不改 Conda/CUDA、代理或训练进程。
- 静态/单元：`npm run typecheck`、`npm run lint`、`npm test -- --reporter=dot` 通过，38 文件 / 952 项测试。覆盖豆包选择保留、独立 Key 替换、专业偏好保留与两引擎配置。新桌面验证脚本 lint 初次发现 localStorage/sessionStorage 全局声明缺失，改为显式 window 属性后 lint 通过。
- 浏览器：`npx playwright test tests/e2e/doubao-settings.spec.ts tests/e2e/desktop-settings.spec.ts tests/e2e/retired-speech-ui.spec.ts tests/e2e/cosy-voices.spec.ts tests/e2e/cloud-speech-ui.spec.ts tests/e2e/cloud-rate-position.spec.ts tests/e2e/cloud-wait-ui.spec.ts` 初次 32/33 通过。唯一失败为旧高级 API 文案断言；更新成两类 Key 的正确指引后，`npx playwright test tests/e2e/desktop-settings.spec.ts` 4/4 通过。共 33 个相关用例最终通过，非全量 e2e。云音频为模拟 WAV，不能视为豆包真实服务通过。
- `npm run desktop:package` 实际通过（包含 typecheck、Vite build、桌面 build、Windows 打包）。Vite 提示已有 bundle 超 500KB，开发测试提示 HMR 配置弃用；未阻断构建，不为消除提示扩大本次修复范围。
- `node scripts/verify-desktop-doubao-settings.mjs`：真实打包 EXE、隔离 profile、两条固定假 Key；新增/替换后清空、Windows 加密文件不含假 Key 明文、公共设置与浏览器存储不回显；关闭重开保留豆包/音色/语气；切回本机六音色保留 Key；显式删除生效。0 次 TTS 请求、0 个页面错误。证据：[结果 JSON](doubao-settings-verification.json)、[豆包配置窗口](screenshots/doubao-restored-desktop-720.png)、[应用按钮窗口](screenshots/doubao-restored-actions-720.png)。两张 1280×720 实际页面截图已查看，输入、音色、语气和保存/应用按钮可滚动到达。
- `node scripts/verify-desktop.mjs --packaged` 通过：PDF 真实选区、演示问答/KaTeX、关闭恢复笔记、单窗口、回环访问保护和桌面加密验证；[结果](desktop-smoke.json)。Computer Use 原生工具初始化失败，改用项目 Playwright/Electron 实际交互，不以终端成功代替 UI 检查。
- 未读取用户真实 Key、未请求真实豆包服务、未真人试听。本轮不能确认新 Key 权限/余额、实际延迟或音质。自动审批对外发授权的首次拒绝及用户随后明确同意已记录于 decisions；最终恢复以主动朗读为触发条件，无启动/保存自动朗读。

## 2026-10-03：科研TTS资料与测试输入准备

- 实际打开ACL/AAAI会录、作者仓库、模型卡、推理代码与硬件基准；核验结论见 [research-tts.md](research-tts.md)。作者成绩均标明设备/条件，没有写成5080实测或本产品通过。
- nvidia-smi只读查询：RTX5080，16303MiB，总使用2269MiB、利用率2%（单次快照）；未停止任何进程，未修改Conda/CUDA/驱动。
- 新增八条原创中文短测例，长文复用已有readest-audition.txt；未生成声音，测例status为not-run。Node实际解析JSON并校验8条唯一id、非空文本/观察项与长文文件存在，全部通过；git diff --check通过，只有既有LF/CRLF提示。这不是语音质量或延迟测试。
- GitHub元数据API调用出现WebException，未取得锁定SHA/精确实时社区计数。官方公开页面浏览成功；未把失败当成研究数据。
- 本轮只改研究文档和测试输入，不重跑产品build/typecheck/lint/unit/e2e，也无UI功能变更。真实安装、声音、延迟、长文与GPU兼容性全部待验；未读私有Key/PDF、未请求付费API。

## 2026-10-03：ChatGPT Pro／微信朗读接入研究（非功能交付）

- 完整项目约定与需求已读取，开始时 Git 干净，HEAD c9684ab；本轮只更新四份研究/进度文档。
- git diff --check 通过；仅出现既有 Windows LF/CRLF 提示，无空白错误。
- 实际打开官方 Voice、SIWC Models and inference / app-server / token reference、腾讯云实时合成与计费、腾讯微信同声传译示例。公开资料支持范围及未确认项见 [研究说明](free-cloud-tts.md)。
- 静态审计：doubaoTts.ts:126–174 聚合 PCM/WAV，provider.ts:112–133 聚合 MP3，api.ts:39–42 完整 blob()，playback.ts:34–44 创建 HTMLAudio；App.tsx:147 仅豆包预取并使用 prose 模式。已核对下一句预取的触发与上限，未测真实延迟。
- 未执行新的 build/typecheck/lint/unit/e2e：运行代码未改，此轮只做资料与静态审计；既往测试不作为本轮新测试。没有界面修改，也未进行本轮浏览器交互验收。
- 真实 Pro 语音集成、微信同款声音、腾讯 API 调用、真人听感、首音和高倍速连续性均未测。未读取凭证、调用收费接口或签署授权；不以模拟音频/客户端语音存在证明新能力已接入。

## 2026-10-03：Readest 桌面与上游源码准备

- 用户反馈：上轮网页版长文“效果还不错”；未把该反馈扩大为全部多音字正确或桌面语音通过。
- releases/latest 返回 v0.12.10，Windows X64；portable 101337600 bytes，SHA256 与 GitHub asset digest 相同：288faaa55119211338494e2d631b6f228c82ace1cfbff3978389854bb7b54d09。详见 readest-download.json。
- 原始 git clone 和 curl 大文件请求停滞；仅中止本次下载会话，改用官方 codeload ZIP 与 Invoke-WebRequest 完成，不改代理。补齐固定 revision 子模块，保留许可证，源码版本见 readest-source.json；未把依赖安装包或 Git 历史声称为已下载。
- 官方程序实际启动，PID 32420，窗口标题 Readest - readest-audition，Responding=true；桌面及项目内启动快捷方式已创建，见 readest-launch.json。启动不自动播放。
- UI 自动化初始化仍报 helper/sandbox 故障，没有目视验收窗口内部布局、导入状态、音色切换、倍率、真实音频或免费额度。以上桌面听感与交互为待验。
- 源码构建未执行：本机未检出 Cargo/Rust，未安装全局工具，交付使用官方预编译程序。本项目只有文档、材料、.gitignore 变更，未重跑既有产品 build/typecheck/lint/unit/e2e，不引用旧通过数冒充本轮测试。
- 未调用收费语音、操作安全放行、签署数据授权、改原软件配置或迁移私有 PDF/账号。下载源码不等于已完成问答/板书融合。

## 2026-10-03：Readest 试听入口与长文

- 项目初始 Git 干净，HEAD 239805e；已读取 AGENTS/PRD/START_HERE。新增原创长文 docs/readest-audition.txt 和本节文档，没有改产品代码。
- 已执行 Edge `--new-window https://web.readest.com`，启动命令成功退出；官方网页与入门/朗读说明可通过网络读取。
- 浏览器 CUA 初始化失败；电脑操作工具重置后仍报 `windows sandbox failed: helper_unknown_error: setup refresh had errors`。实际 Readest 页面、登录/导入、声源选择与播放 UI 验证受阻，没有声称已导入或听到声音。
- 真人试听待验：2026年是否二零二六年；3.5%与12:30；银行/行业/行走；重新/重庆/重量；还款/还有；八段衔接有无不自然长停、漏读、重复或音色切换。
- 未调用真实 TTS 或收费服务，未安装软件。仅材料/文档变更，未重跑产品 build/typecheck/lint/unit/e2e；上轮测试结果不计入本轮。

## 2026-10-03 补充：Readest 与现有提取流程只读核验

读取Readest官方reading/listen说明及发布记录，确认文字PDF选区、Ctrl+R选区读完停止、默认Edge TTS。未确认仅当前物理页自动停止的专门按钮，未在用户PDF实测Readest或声音。只读检查本项目PdfReader.selectCurrentPage和getTextContent调用，确认本页/选区朗读输入来自PDF文字层。工作代码未改，未重新运行构建或测试；上一节功能变更的884单元/后端与98浏览器结果仍为上轮记录，不能写作本次新增测试。

## 2026-10-03：退休语音与免费替代调查

环境：Windows / Node24.19.0 / npm11.17.0 / Git2.50.1。任务初始Git干净d8cc909，读取AGENTS/PRD/START_HERE；并行编辑分别使用独立worktree与明确文件责任。

| 检查 | 实际结果 |
|---|---|
| typecheck / lint | 通过。新增语音请求兜底时曾漏传两个参数，tsc发现后改为完整参数转发；最终桌面构建再次通过类型检查。 |
| 单元与后端 | 33文件884/884通过。覆盖旧vault迁移、退休HTTP路径拒绝、浏览器不触碰系统语音、云失败不回退及已有状态机。 |
| 浏览器 | 最终全量98/98通过（53.5秒）。首轮96项92通过、4失败，原因是旧夹具未显式配置云音频；修正夹具后受影响10/10通过，再加入2项旧书签/课堂关闭声音回归，最终全套通过。 |
| 测试迁移 | 通用暂停/续读/倍速/取消/课堂/RTC覆盖保留，原speechSynthesis夹具换为显式cloud mock。退休模型设备和等待UI断言换为无退休选项、旧配置拒播、关闭时零请求。未用删除通用测试规避失败。 |
| build / desktop:package | 通过；原Vite >500kB chunk警告保留。桌面resources只有app.asar，主包搜索无LocalTtsProvider/QwenTtsProvider/sherpa及两套runtime路径。 |
| 真实桌面 smoke | 通过：独立无Key档案、真实PDF鼠标选区、演示板书公式、声音选项仅none/doubao/openai、Windows凭证加密、单实例、回环限制和关闭后服务退出。0页面错误，见 desktop-smoke.json。首轮旧脚本重开后还点击示例按钮，与自动恢复功能冲突；改为断言自动恢复后通过。 |
| EXE重开阅读恢复 | verify-desktop-reading-reopen.mjs通过：第2页和笔记自动恢复，0远程/模型/语音请求，0页面错误；声音保持停止。终端验收摘要见 desktop-speech-retirement-reopen.json（临时原始报告随后被E2E清理）。 |
| 目视检查 | 实际EXE的桌面设置720p截图已检查，声音关闭提示与保存/应用可见。截图位于 screenshots/desktop-settings-720.png；PDF与板书位于 screenshots/desktop-workspace.png。 |
| 真实接口与听感 | 未测新的腾讯/Azure/Edge/Readest中文声音，未调用付费API、未登录新账号、未签署豆包数据授权。不将模拟WAV、源码检查或营销声称当成真人听感通过。 |

项目内已删除local-tts-runtime、qwen-tts-runtime及明确的Qwen模型/构建下载缓存、Kokoro归档分片。npm prune --offline --ignore-scripts清理2个退休的项目依赖，随后884项单元/后端、typecheck和lint再次通过。Windows系统语音、全局依赖和用户其他项目未修改。历史声音样本及回归源码保留，不再作为运行选项。正常桌面恢复记录见 speech-retirement-running.json。

日期：2026-09-29。环境：Windows；Node 24.19.0；npm.cmd 11.17.0；Git 2.50.1；Microsoft Edge 154.0.4258.37（Playwright 本机 channel=msedge）。
**本记录将真实本地功能、模拟模型/音频、真实付费接口、真人听音分开。**

## 实际执行摘要

| 命令 | 状态 | 证据 |
|---|---|---|
| npm.cmd run fixtures | 通过 | 生成 public/sample.pdf，两页自制中文材料，可选择文字；未打包商业教材 |
| npm.cmd run typecheck | 通过 | tsc --noEmit，退出 0 |
| npm.cmd run lint | 通过 | ESLint，退出 0 |
| npm.cmd test | 通过 | 12 test files / **274 tests passed**，1.27s |
| npm.cmd run build | 通过 | Vite 生产构建；存在 >500kB chunk 体积提示，不是编译错误 |
| npm.cmd run test:e2e | 通过 | **46 passed (32.0s)**，6 个本机 Edge worker |
| node scripts/verify-production.mjs | 通过 | 独立回环 4318 启动生产构建、打开 PDF、选区、演示教案；0 pageErrors；只关闭该脚本启动的进程 |
| npm 安装审计 | 通过 | 初次安装报告 0 vulnerabilities；只装项目局部依赖 |
| Git diff / 凭证检查 | 通过 | 自有代码 diff --check 通过；原需求未修改；.env 忽略；前端 bundle 无凭证模式命中 |

最新单元测试覆盖 PDF/坐标/提取、音频与竞态、课堂状态机、学习记录与恢复快照、会话/教案、Realtime 工具/控制器及后端 mock 集成。共 12 文件、274 项，没有任何测试依赖真实 Key。后文 M1/M2 历史记录保留当时计数。

基础场景端到端测试摘要（本次新增项另见文末）：

```text
中文 PDF 真实鼠标选区 → 演示教案 → 公式表格及来源: passed
发送请求的选区匹配，换页不替换锁定上下文: passed
同名不同内容的 PDF 丢弃前一本书的迟到回答: passed
音频模拟：同一句暂停续播，文字打断后恢复未完成句，无旧声复活: passed
模型危险文本和 LaTeX 不执行，显示安全内容: passed
真实区域截图预览，旋转缩放后来源矩形仍能定位: passed
后端错误清楚显示且不自动切换为假回答: passed
真实浏览器本机语音能力诊断（不评价扬声器听感）: passed
刷新恢复会话版本，本书笔记按指纹保留: passed
PDF 内嵌 JavaScript 保持不执行: passed
10 passed (15.8s)
```

## PRD 验收 ID

“通过”的范围严格限于证据栏；演示回答不能用于判定真实模型理解正确。

| ID | 状态 | 本轮证据与边界 |
|---|---|---|
| A01 | 通过 | 自制中文 PDF 真渲染、两页、真实鼠标选择；PDF 在浏览器读取。复杂商业教材未测 |
| A02 | 通过 | 本地选区与实际发送 JSON 一致，演示板书引用跳回真实来源；**真实模型回答未测** |
| A03 | 通过 | 延迟问答时翻页，原问题仍使用第 1 页快照 |
| A04 | 通过 | 实际 PNG 裁剪预览、发送数据一致、归一化坐标与旋转缩放定位；**视觉理解/模糊符号澄清未测** |
| A05 | 通过 | 无 .env 为醒目 DEMO，后端无 Key 且 DEMO=false 返回未配置，不假装成功 |
| A06 | 未测 | mock 验证暂停同一对象/续句/单输出/高亮；真实本机语音有 onstart/stop 事件；真实 TTS 与真人听音未测 |
| A07 | 通过 | 浏览器音频 mock 验证输入文字立即停音，手动继续恢复未完成句；**不等于真人听感验证** |
| A08 | 通过 | 实际 KaTeX 公式与表格、步骤定位、来源按钮；LaTeX 复制按钮使用模拟剪贴板验证原始字符串；系统剪贴板权限未单独验收，失败有手动复制入口。教学正确性真实模型未测 |
| A09 | 通过 | 同名不同内容 PDF，取消/延迟响应不进入新黑板；后端旧 generation 拒绝 |
| A10 | 未测 | M2 已实现；真实 MediaRecorder + 合成音输入、模拟转写后草稿编辑和同一课堂发送通过；真人中文与真实转写/公式读回未测 |
| A11 | 通过 | Edge 模拟权限拒绝显示中文恢复提示，PDF/文字入口仍可用；真人设备权限弹窗未测 |
| A12 | 未测 | 陪读已实现；自动化 20 次文字打断/续句及教学步骤恢复通过，不等于连续 20 分钟真人学习验收 |
| A13 | 通过 | 实际 IndexedDB 保存、刷新后重新选同一 PDF 恢复笔记/书签/步骤且不自动播放；内容指纹隔离同名不同书，版本不符拒绝恢复 |
| A14 | 未测 | M3 已实现。实际本机 WebRTC / 合成输入 / 模拟模型验证停音、清除等待与未播标记；真人插话、供应商未播历史修剪、听感一致性未测 |
| A15 | 未测 | 已实现可见板书 ID 的白名单定位，错误/歧义目标拒绝；工具与播放绑定模拟测试通过。真人自然表达与模型澄清质量未测 |
| A16 | 通过 | 本机原生 RTC 回环：停止/换目标/清音频超时释放合成 tracks 和连接，无自动重连；生命周期和迟到设备另有 unit。官方 hangup、真人设备及网络条件未测 |
| A17 | 通过 | 工具超时、失败、幂等和过期 opId 单元测试；原生 RTC 回环验证 DOM 板书先于 ACK、ACK 先于语音请求。模型实际行为未测 |
| A18 | 通过 | mock 覆盖超时、认证/权限/模型/额度错误、取消和有限请求；浏览器验证中文错误与不假降级。真实断网/限额未测 |
| A19 | 通过 | .env 未创建且被 Git 忽略，后端配置不返回 Key，前端 bundle/源码检查与模拟密钥脱敏测试通过 |
| A20 | 通过 | PDF 内嵌 JS 未执行；React 文本/KaTeX javascript 链接不执行；实时模型仅有当前选区/已显示板书白名单工具，不含任意执行/文件/网络工具；schema、来源、版本均校验。真实模型抗提示注入能力未测 |
| A21 | 通过 | 实际 JSON/Markdown 下载、严格 JSON 导入、删除一本保留另一本；导出只含白名单，无 Key/会话凭证/录音 |
| A22 | 通过 | 未配置能力独立报错，TTS/视觉不继承文字成功；模拟接口验证，真实账号权限未测 |

## 真实接口 / 音频单列

| 项目 | 状态 | 原因 |
|---|---|---|
| OpenAI Responses 文字 | 未测 | 无 Key，未授权付费测试 |
| OpenAI 视觉裁剪理解 | 未测 | 无 Key，未授权付费测试 |
| OpenAI TTS | 未测 | 无 Key，未授权付费测试 |
| 浏览器本机语音引擎事件 | 通过 | 非 mock 生产 smoke：6 个本机声音（3 个中文）；短句出现“准备声音→正在朗读”，停止后“待机” |
| 中文发音、公式准确性、实际无叠音 | 未测 | 需要用户真人试听；事件/模拟测试不证明扬声器实际效果 |
| OpenAI 录音转写 | 未测 | 适配已实现，无 Key，未授权付费测试 |
| 真实 MediaRecorder 管线 | 通过 | 合成音/静音 MediaStream 输入，未使用真人麦克风；转写 HTTP 为 mock，DEMO 不上传 |
| 真人麦克风、中文识别与 20 分钟学习 | 未测 | 需要真实设备、最小付费样本与真人验收 |
| OpenAI Realtime 官方连接、回声、真人直接开口打断 | 未测 | M3 适配已实现；无 Key，未授权付费测试，真人听音未做 |
| 本机原生 WebRTC / AudioContext | 通过 | 实际 Edge 两个 RTCPeerConnection 回环；合成输入、静音远端轨道；模型事件与 HTTP 为 mock，不能代表官方连接 |

真实语音事件原始信息见 [production-smoke.json](production-smoke.json)。短样本约 2.2 秒，没有付费调用。

## 实际页面与截图

已实际查看截图并修正 720p 的垂直空间。中文文本、真实选区、公式、区域预览均可见；内容长时在各栏独立滚动，支持折叠对话。

- [桌面工作台](screenshots/workspace-desktop.png)
- [1280×720](screenshots/workspace-1280.png)
- [公式裁剪、旋转与来源定位](screenshots/formula-region.png)
- [句级书签（音频 mock）](screenshots/reading-bookmark.png)
- [生产构建页面](screenshots/production.png)

## 已遇到并修复 / 保留的问题

- npm.ps1 执行策略限制：改用 npm.cmd，未改系统策略。
- 沙箱 helper setup refresh errors：项目命令经自动审查运行，不改系统或项目外文件。
- 开发中未合并模块导致首次 typecheck 找不到模块；合并后复测通过。
- 首次 lint 报全角空格、浏览器 globals、空 catch：修复后通过，没有删除测试。
- 修复刷新会话版本倒退、取消先到时旧请求仍启动、同页书签跳转清空进度、跨页同文误高亮、暂停时 play Promise 拒绝误清音频。
- 首次完整 git diff --check 发现自有文件末尾空行和上游许可证行尾空格：自有文件已修复；public/pdfjs 原始许可证按原样保留，最终空白检查明确排除此第三方目录。
- 生产包含 PDF.js/KaTeX，Vite chunk 体积警告保留；当前本地应用可用，不把它隐藏成无警告构建。
- 500 页、大文件、密码文档、复杂多栏/脚注与长时内存验收未测。文本质量警告会提示核对原页，不静默声称正确。

## 用户真人验收最小步骤

打开示例或一页自己的合法中文 PDF：选段并核对预览，朗读后暂停/继续，朗读中输入文字问题，查看板书，点击继续确认从未完成句恢复；检查声音清楚且无叠音。再在本机配置 .env，明确愿意产生少量 API 费用后测试短文字、一张局部公式、一个短句。记录实际模型、浏览器、错误/request ID 与听感；不要分享 Key。

## 网页无法打开的排查（2026-09-29）

初查：4317 无监听，HTTP 连接失败。启动本项目服务后：127.0.0.1:4317 监听正常，首页/API 均 HTTP 200，DEMO 模式。独立 Edge 检查 title="PDF AI Teacher · 学习工作台"、appVisible=true、pageErrors=[]；服务在检查结束后继续运行。初次检查脚本受 PowerShell 内联引号影响而语法失败，改用项目内临时脚本后通过；不是应用错误。

## 用户反馈回归（2026-09-29 19:08）

在实际 Edge 中执行 15 项 e2e，全通过；开发服务隔离到 4320，未中断日常 4317 服务。最终 typecheck / lint / build 通过，单元与模拟后端 69/69；生产 smoke 于 19:08 使用独立 4318，全程 DEMO，0 pageErrors、0 providerCalls。构建仍有 PDF.js / KaTeX 大 chunk 提示。

本轮新增或强化的实际浏览器验证：

- 点选区提问先弹窗；空问题不可发；选提示词、改草稿、关闭弹窗均不调用 ask；自定义文本在两次请求中逐字匹配。
- 文字与框选的原文/PNG 来自真实 PDF；自定义问题与正确选区一起发送。板书追问弹窗同时显示板书目标。
- 取消按钮、阅读器工具栏按钮与 Esc 清除高亮、DOM 选择、截图、锁定目标和右侧目标标签；无目标时不会继续发旧选区。历史板书保留，同一处重新选择成功。
- 在途请求取消后未出现迟到板书；旧响应版本拒绝另有 SessionGuard 单元测试。该浏览器场景主要验证 abort，不声称模拟了无法取消的真实服务。
- 框选拖动中 Esc 后放开鼠标，不生成新截图。
- 音频 mock：暂停/继续保持同段，文字打断后句首续读；第二句取消选区后目标消失、继续按钮可用，继续仍播放第二句且不重新锁定提问目标。
- 设置页明确显示本机语音未接通自然模型；不把语气配置或构建通过标为真实听感通过。

新增后端模拟覆盖：官方 mini-TTS 的 instructions、tts-1 无 instructions、未知/兼容端点能力声明、配置冲突错误、安全元数据、语气变化隔离缓存；没有真实请求。

已实际查看 [问题编辑弹窗](screenshots/selection-question.png)、[720p 工作台](screenshots/workspace-1280.png)和[清除后的页面](screenshots/cleared-selection.png)。弹窗有预览、编辑框、发送按钮与演示说明；720p 操作没有被底部朗读栏遮挡。

真人中文听感、gpt-4o-mini-tts 实际逐字保真、账号模型权限、GPT-Live / 麦克风 / 实时插话均未测。不能承诺声音与真人完全相同。无 .env / Key，未执行任何付费调用。

本轮结束时仅重启已核实的本项目旧服务，新的后台开发服务继续监听 127.0.0.1:4317；首页 HTTP 200，/api/config 返回 demo 且含新增语音元数据。未创建真实 .env、未调用付费 API。用户需刷新页面并重新导入 PDF；电脑重启后仍使用 npm.cmd run dev 启动。

## M2 集成验收（2026-09-29 20:21）

最终执行：typecheck、lint、build 均退出 0；Vitest 9 文件 / 140 项通过；Playwright 28 项通过（27.6 秒、3 workers、Edge 154.0.4258.37）。生产 smoke 于 20:20:19 使用独立 4318 端口，真实本机 SpeechSynthesis 短句出现开始/停止事件，0 pageErrors、0 providerCalls；原始数据见 [production-smoke.json](production-smoke.json)。没有执行付费接口测试。

新增实际浏览器场景：

- 陪读原文结束 → 生成同一教案 → 先显示当前步骤与图示再播放；每步停顿，文字打断后恢复原步骤；刷新重新选择 PDF 后恢复但不自动播放。音频输出为 mock。
- 校对后的文本生成新版本；保存第二句阅读位置并恢复，讲解后可返回独立原文书签。
- 连续 20 次文字打断/句级恢复，无旧声音恢复；此测试约 7.6 秒，不替代 20 分钟真人学习、内存或听感验收。
- 实际 JSON/Markdown 下载，导出校验无凭证；删除当前书保留另一本，再导入恢复；额外敏感字段的非法记录被拒绝。
- 模拟 IndexedDB 配额失败保留内存和导出入口；刚输入笔记立即刷新后内容保留。
- 真实 MediaRecorder/AudioContext 配合合成音与静音流；转写响应为 mock，只填草稿、可修改再发送；没有把合成输入记为真人麦克风通过。
- 录音取消与结束释放 tracks，等待权限时取消后迟到的 tracks 也释放；权限拒绝、静音和 DEMO 本地丢弃录音有清晰提示。

已实际检查 [M2 陪读页面](screenshots/m2-classroom.png)与 [1280×720 工作台](screenshots/workspace-1280.png)：陪读控制、受限图示、当前步骤与录音入口可见，无操作重叠；小屏通过折叠陪读设置与栏内滚动保留阅读区域。

开发中失败与修复保留记录：首次完整回归 14/15，发现快速刷新丢失新笔记，增加同步恢复快照后通过。首轮新增 M2 场景 8/11，分别发现示例图示未插入、IndexedDB 异步配额异常未进入失败分支、静音录音返回空字节时提示不准确，已逐项修复。复核还修正派生来源 ID、重复 stepId 的旧音频匹配、导入/删除与保存竞态。所有最终测试已重跑，没有删除失败用例。

真人最小验收：重新打开 PDF，选短段开始陪读，打字追问后继续；实际按麦克风录一小句并取消，观察设备释放。配置本机 .env 并自行确认费用后，再测一条中文转写、一个短句 TTS 与一次文字解释，最后完成 20 分钟学习测试。真实教学正确性、中文声音自然度、公式发音、扬声器无叠音与账号权限仍未测。GPT-Live 实时对话属于 M3，本轮未接入。

最终复核追加两项回归：导入/删除操作锁跨设置面板关闭重开仍生效，期间不能重复删除或重开保存；超出 8 MiB 的多截图记录仍可通过保持 schema/来源白名单校验的 Markdown 导出文字和板书。上述计数已更新为最终 140/28。仅重启已核实的项目旧 PID 28840，新服务 PID 8844 继续监听 127.0.0.1:4317，首页 200、配置为 demo 且含独立转写能力字段；.env 不存在。

## M3 集成验收（2026-09-29 21:12）

最终执行：独立 typecheck、lint、build 均退出 0；Vitest **12 文件 / 240 项**（866ms）；Edge **35/35**（28.6 秒、4 workers）。生产 smoke 在 21:11:49 使用独立 4318，0 pageErrors、0 providerCalls；本机真实 SpeechSynthesis 开始/停止事件通过，真人听感未测。Vite 仍提示 PDF.js / KaTeX 大 chunk，未隐藏告警。原始 smoke 更新在 [production-smoke.json](production-smoke.json)。本轮没有安装新依赖或执行真实付费请求。

### 测试层次与新增证据

- 后端 Realtime 24 项注入 provider 模拟：官方 multipart 会话参数、Location/call ID、所有权/CSRF/Host/Origin、独立配置、重复连接、旧 generation、心跳/超时、迟到交换后关闭、hangup 未确认状态；全部不访问 OpenAI。
- 工具 36 项：白名单、严格参数、来源/版本、超时、操作数量、重复 opId、参数冲突、过期重放与回执；不完整/取消响应不执行工具由控制器测试补充。
- 控制器 23 项：本机/服务端声音检测先后顺序、迟到转写、失败/取消回复、生成与播放分离、板书提交/ACK/语音顺序、续讲被新问题抢先、焦点步骤绑定、清除超时、权限等待时离开页面；语速 ACK 与取消/超时；旧 play 拒绝/onplaying/onerror 在快速重连后不影响新会话。该层 DOM/RTC/网络均为 mock。
- AudioCoordinator 共 39 项，包含实时外部音源 lease 的互斥、旧 lease 释放隔离和原文书签保留。另保留全部 M0/M1/M2 回归。
- 新增七项实际浏览器场景，见下表。测试从真实 PDF 鼠标选择进入，不直接注入应用状态。

| 场景 | 实际部分 | 模拟部分及边界 |
|---|---|---|
| 先板书回执再声音、每步暂停 | 原生 RTCPeerConnection 成对回环、RTCDataChannel、远端 MediaStream/HTMLAudio、React DOM 和 KaTeX | 服务事件/工具教案、HTTP、静音音频；不评价生成内容和听感 |
| 打断清除等待后接文字问题 | 浏览器输入、实际数据通道、转写状态标记 | cleared 延迟 800ms；验证回执前没有下一 response.create |
| 迟到工具/旧转写 | 原生通道向实际 UI 发送旧事件 | 模拟取消时序；旧内容不出现，清选区释放设备 |
| 服务端清除超时 | 2.5秒实际计时、原生 RTC 与 tracks 关闭 | 故意不发 cleared；上游断开 HTTP mock |
| 原文播放器与实时交接 | 原文 HTMLAudio、第二句锚点、原生 RTC 输出，恢复同一句 | TTS 返回静音 WAV；服务端控制工具为模拟 |
| 无 Key 本机打断演练 | AudioContext 分析合成声、实际暂停/续读 UI、设备释放；零 ask/tts/transcribe/realtime-connect 请求 | 输入振荡器；SpeechSynthesis 输出 mock，未录真人 |
| 结束实时后切回 TTS 陪读 | 同一教案的下一步骤先显示、再经真实 HTMLAudio 播放 | 静音 WAV 与模拟服务；麦克风保持关闭 |

已实际打开并查看 [M3 实时回环页面](screenshots/m3-realtime.png)、[M3 本机演练 1280×720](screenshots/m3-local-720.png)。选区、当前公式、输入框、麦克风关闭标识可见；展开语音后对话和控制区分别可滚动。小屏控件超出时在栏内滚动，固定底部播放栏未遮挡页面。截图中的 API 模式来自测试配置覆盖，教案明确含“模拟”文本，不能作为真实 API 成功证据。

### 开发中失败与修复

- 首轮新增浏览器测试 3/4：测试回环在通道关闭后仍尝试发送事件，触发 pageerror；harness 增加 readyState 检查后通过。未删除用例。
- 首次合并旧控制器测试 225/233：8 项在新增语速回执门控处超时；补齐默认模拟 ACK，并新增四项专门检查等待/取消/超时，最终全部通过。
- 首次完整浏览器回归 33/34：旧文案断言仍要求“实时插话尚未接入”；改为验证 Realtime 未配置和真实效果待验，保留原场景。
- 官方协议复核纠正语速位置，应使用 session.update 而非 response.audio.output.speed；未曾发起真实请求，因此没有伪称观察到供应商报错。
- 修复双重 VAD 使有效转写过期、取消响应被误认播放完成、清除期间旧续讲抢先、焦点步骤不一致、待权限期间离开未释放、旧播放器迟到回调关闭新连接；均补对应回归。
- UI 实检修正语音面板挤占对话记录；集成复核修正实时结束后切回 TTS 的下一步板书仍被旧显示上限隐藏，新增第七个浏览器场景。

### M3 真人与真实服务待验清单

A14/A15 保持未测；A16/A17 的“通过”严格限于表中本地证据。没有真实模型/网络延迟 p50/p95，没有真人开口到静音延迟数字，不能把模拟时钟或本机回环当作达成 ≤300ms 人声目标。

最小顺序：先无 Key 本机演练，确认麦克风允许/拒绝/停止释放；再由用户在本机配置 Key 和独立实时模型，自行确认少量费用，用一段合法 PDF 做短连接。确认老师正在讲时说一个问题，检查立刻停声、回答针对选区、下一步先显示板书。依次试“解释第二行”“等等”“继续原文”“慢一点”，核对原文句书签；测试一次短噪声/咳嗽和错误目标，不能编造用户问题或乱定位。结束、切换窗口和断网时检查麦克风关闭、没有后台自动重连，并核对服务端关闭状态。随后再做有/无耳机回声、中文数学发音与 20 分钟学习验收。记录模型/SDK/浏览器/网络/错误 request ID，不记录 Key。

最终仅重启已核实的本项目 PID 8844，新后台 PID **31892** 监听 127.0.0.1:4317，首页 HTTP 200；配置为 demo，Realtime 模型留空、能力 unsupported（演示不发请求）。.env 不存在且被忽略；原 AGENTS/PRD/START_HERE 相对 M2 基线无差异，前端 bundle 密钥模式无命中（rg 返回 1 表示没有匹配）。未修改其他项目或全局环境。

## 低倍速与功能体验回归（2026-09-29 21:58）

最终 typecheck / lint / build 均退出 0；Vitest **257/257**（12 文件，1.05 秒）；Playwright **43/43**（30.5 秒，5 workers，Edge 154.0.4258.37）。未新增依赖，无 .env，无真实收费请求。生产构建的大 chunk 提示保留。

新增 17 项单元/模拟接口：0.25 参数穿透共享 schema、受保护本地 TTS 路由与 SDK 请求构造；低速缓存隔离/复用；播放中切速旧声音先停、同句重新生成、HTMLAudio 仍以倍率 1 播放；暂停改速不自动恢复、迟到旧声音不能复活；本机 utterance.rate 和 Realtime session ACK；慢速长步骤不被闲置计时误关、仍保留播放与总时长上限。均为模拟输出/接口，不声称真人听感。

新增八项真实浏览器场景：

1. 功能体验 → 自制 PDF → 实际 DOM Range 选区，预览与选择相同；0.25× 参数进入模拟 utterance，实际页面播放/暂停/同一句继续；刷新记住语速，不自动播放；无 ask/tts/transcribe/realtime-connect 请求。
2. 原文播放中改到 0.25 从本句重播；暂停后改 0.35 仍暂停，再继续才发声，模拟输出始终最多一个。
3. 演示板书入口明确固定内容，直接展开逐步讲解；先一步后下一步；Esc 关闭功能说明不清原选区。
4. 体验入口开启本机麦克风检测，实际 AudioContext 分析合成声音并暂停；没有实时服务连接。
5. 实际原生 WebRTC 回环中，0.25 session.update 经过模拟 ACK 后才创建语音 response。
6. 短段自然读完不会写成体验完成，可重播再试暂停。
7. 图片框选时禁止进入依赖文字朗读的麦克风引导，并说明原因。
8. 模拟权限尚未返回，界面只显示准备中，不声称已经监听；可立即取消。

生产 smoke 在 **21:55:40** 使用最终 dist 和独立 4318：包装原生 speak 仅记录实参并照常调用真实本机语音，submittedRates=[0.25]；观察到“准备声音→正在朗读→待机”，0 pageErrors、0 providerCalls。该证据证明参数和引擎事件；没有测量人耳听到的时长比例、自然度或真人公式发音。详见 [production-smoke.json](production-smoke.json)。

已实际查看 [功能体验弹窗](screenshots/feature-guide.png) 和 [0.25 倍速与续读引导 1280×720](screenshots/slow-reading-720.png)：有直接操作按钮与演示边界说明，底部语速清晰可选，引导未覆盖播放控制。阅读区与对话保留各自滚动；完成后可关闭引导释放空间。

本轮首个完整浏览器回归 40/40。随后代码复核发现自然结束引导卡住、图片目标不可朗读及权限期间虚报开麦，修复并保留新增回归，最终 43/43；没有删测试掩盖问题。首次脚本编辑受 Windows BOM/行尾影响的匹配已在正式类型检查前修正。M3 真实接口/真人 A14/A15、A12 二十分钟、复杂长书等验收状态不变。

仅重启核实的本项目 PID 31892，新后台 PID **28116** 监听 127.0.0.1:4317；首页 HTTP 200，demo 模式，.env 不存在。原 AGENTS/PRD/START_HERE 未改。用户现在只需刷新 → 顶栏「功能体验」→ 走一遍，或直接把底部语速调低。电脑重启后仍执行 npm.cmd run dev。

## 文字理论解答与独立自然朗读（2026-09-29 23:50）

按用户新偏好，主入口为打字问理论→同一 TeachingPlan 的答案和黑板→「听这次讲解」；麦克风功能默认收起。真实模型仍未接通，不将模拟教案用于判定理论正确性。

最终执行：typecheck / lint / build 均退出 0；Vitest **12 文件、274 项通过（1.27s）**；完整 Edge E2E **46 项通过（32.0s，6 workers）**。Vite 仍保留 >500 kB chunk 提示。生产 smoke 于 23:44:50 在独立 4318 使用最终构建，真实本机 SpeechSynthesis 收到 rate=0.25，观察到准备→朗读→停止，0 pageErrors、0 providerCalls；不代表中文听感验收。见 [production-smoke.json](production-smoke.json)。

新增或加强的证据：

- 后端新增 17 项模拟测试：文字/图片分别传 reasoning.effort；留空省略参数；教学 token 预算和独立超时；TTS/转写/Realtime 超时不被教学配置延长；不完整教案明确拒绝、保留已知 usage，不自动换模型；公开配置不泄露凭证。
- 新增 3 项实际浏览器场景：真实 PDF 选区与自定义文字请求；回答不自动出声；点击朗读使用同次讲解稿、不重复 ask、不访问麦克风/转写/Realtime；第二句暂停后从头回第一句；逐步继续、打字停音、恢复独立原文书签；TTS 失败保留答案，缺少 TTS 时仍可文字解答。
- 上述问答和 TTS HTTP 为模拟；输出使用真实 HTMLAudioElement 播放测试静音 WAV，句末事件由测试推进。截图模型名称和内容明确为 mock / 接口模拟，不算真实供应商语音或专业理论测评。
- 设置显示实际模型/推理强度/token/超时；兼容模型未配置 reasoning 时不会臆造支持。麦克风演练从隐藏的对话栏进入仍展开正确面板。
- 已实际查看 [桌面回答朗读](screenshots/text-teacher-desktop.png) 与 [1280×720 回答朗读](screenshots/text-teacher-720.png)：朗读按钮、当前步骤和底部暂停/停止均可见，分栏长内容独立滚动，没有遮挡播放控制。

首次完整回归为 44/46，保留失败原因：一项设置断言使用旧文案，更新为当前独立文字/TTS 的说明；另一项快速换书时笔记为空。后三次定向重跑复现后检查 trace：新书记录仍在加载、main 处于 inert，笔记框却先变为 enabled，自动化 fill 没有产生实际输入；空值在删除前已存在。现将笔记框禁用到该书 recordReady，测试同时等待目标书页数和 ready、核对输入值并检查该书 IndexedDB 持久化，再做删除/导入。没有删除测试或重写无证据的存储逻辑，最终完整 46/46 通过。

日常服务只重启了已核实的本项目 PID 7956，新 PID 31632 监听 127.0.0.1:4317。23:50 的实际 Edge 检查：HTTP 200、默认文字入口可见、麦克风折叠、设置显示当前后端 16000 tokens / 180 秒；pageErrors=[]，没有 ask/TTS/转写/Realtime 请求。见 [dev-smoke.json](dev-smoke.json)。服务保持运行；电脑重启后仍需 npm.cmd run dev。

未测：GPT-6 Astra 账号权限、真实复杂理论推导质量、真实 TTS 中文自然度和公式读法、真人听音；没有 .env、没有真实 Key、没有付费调用。README 与 .env.example 中的 Astra+xhigh+marin 是配置建议，未声称当前已启用。原 PRD 验收标准和此前 A06/A10/A12/A14/A15 等真人待验状态不变。


## Windows 桌面与 ChatGPT 登录（2026-09-30）

本轮范围来自用户明确要求：双击图标打开独立本地软件，使用 ChatGPT 账号登录；继续以文字理论问答和独立朗读为主。原 AGENTS/PRD/START_HERE 完成标准未修改。先检查了项目文件与 Node/npm/Git，再核对官方接口并实施；并行 auth 与 UI 在独立 worktree 完成后集成。

### 最终执行结果

| 检查 | 实际结果 | 证据边界 |
|---|---|---|
| typecheck / lint | 均退出 0 | 类型、规则检查；desktop:package 内再次执行 tsc |
| npm.cmd test | 15 文件，316/316，1.21 秒 | 2026-09-30 11:37；含 OAuth/Responses 模拟与凭证退出保存回归 |
| npm.cmd run test:e2e | 49/49，34.4 秒，7 workers | 实际 Edge 页面，新增三项桌面 bridge 场景；桥接与模型返回模拟 |
| npm.cmd run desktop:package | 退出 0 | Vite + esbuild + Electron 44.5.0 Windows x64；保留 >500 kB chunk 提示 |
| npm.cmd run test:desktop -- --packaged | 退出 0 | 11:37:50，实际 exe、首次不存在的 profile、真实 PDF/KaTeX、单实例、真实 Windows 加密、关闭重开恢复 |
| npm.cmd run test:desktop:restart | 退出 0 | 11:37:52，实际 app.relaunch；设置应用、localStorage 保留、窗口关闭后端口退出 |
| 生产网页 smoke | 退出 0 | 11:25:11，真实 SpeechSynthesis 收到 0.25，事件准备→发声→停止；0 pageErrors / 0 providerCalls |
| 普通账户首次启动/快捷方式 | 通过 | 11:38:29，在正常应用数据目录启动；实际创建桌面图标，登录入口可见，账号 signed_out / demo |

原始记录：[桌面 smoke](desktop-smoke.json)、[真实自动重启](desktop-restart.json)、[普通账户首次启动](desktop-first-run.json)、[生产网页](production-smoke.json)。最后两项桌面脚本不预建数据目录。测试凭证是显式 fake 值，未进行真实授权或付费调用。

已实际打开并查看 [桌面工作台](screenshots/desktop-workspace.png)、[登录设置](screenshots/desktop-settings.png)、[720p 设置](screenshots/desktop-settings-720.png)、[普通账户首次打开](screenshots/desktop-first-run.png)。独立窗口没有浏览器地址栏；PDF、三栏黑板和提问入口正常，设置可滚动至保存/重启按钮；账号登录和独立声音配置含清楚说明。浏览器页面与原生窗口均有实际检查，不能仅用控制台无错误代替。

### 测试层次

- OAuth 的外部发现、授权码交换、令牌续期、撤销和模型目录为注入 mock；回调是实际动态回环 HTTP，JWT 使用实际测试密钥签名/校验。覆盖 state/nonce/PKCE、签名/issuer/audience/expiry、注册映射、账号切换时轮换凭证、取消/超时、失效/暂时错误、退出清理、关闭时等待已开始落盘。
- ChatGPT Responses 模拟验证官方请求参数、stream 完成才接受 TeachingPlan、不完整响应拒绝、不会静默切换 API Key 计费。语音走独立 API Key provider，不将 OAuth token 发给音频路径。
- vault 单元测试的 cipher 是测试替身；实际 exe 另用真实 Windows DPAPI 保存 fake 凭证，文件中没有其明文，公开设置不回传 Key，重开后成功读取存在状态，最后清除测试 Key。
- 实际 exe 验证 nodeIntegration=false、contextIsolation=true、sandbox=true；额外浏览器直连内置端口返回 403。关闭窗口后请求失败，第二次启动恢复原书笔记；重复 exe 进程退出、原窗口仍为一个。
- 重启测试只在测试进程启用动态本机调试端口；交付普通桌面启动不添加调试参数。账号、Key 和学习记录不打入 asar 或 Git。

### 开发中失败与修复

- 首次打包对下载缓存配置不当，重复下载 Electron 遇到 ECONNRESET；改用已下载的官方运行时缓存并校验随包 checksums，随后打包成功。首次在包生成前启动 exe 的测试失败随之解决。
- 桌面 smoke 初稿使用旧笔记框名称/未展开笔记，断言失败；修正为实际可见入口后保留全部验证。真实重启脚本误用了不存在的 Browser.waitForEvent，改成 Browser 的 disconnected 事件等待后通过。
- 新增脚本 lint 暴露浏览器全局变量与计时器声明、三元表达式规则问题；改为 window.localStorage、显式导入和 if/else，最终 lint 通过。未删除场景或屏蔽这些检查。
- 类型检查和 auth 集成中曾有缺模块、SDK requestID 命名等失败，合并完成并按本机 SDK 类型修正后通过。
- 最终只读复核发现预创建测试目录掩盖首次 setPath 风险，以及退出账号目录回填、退出未等待凭证写入问题。先建自身目录、使旧目录请求失效、退出有界排空写入队列，并以真实首次启动/重启和新增凭证轮换关闭用例回归。最终数量为 316/49。

### 仍未验收

没有真实 ChatGPT 授权、账号资格/模型列表、真实 Responses、专业理论质量、供应商 TTS 中文自然度或真人听音证据。登录能力按官方本地应用协议实现，不表示每个账号均有资格或额度；默认 Astra/xhigh 仅建议，授权后以账号列表和支持参数为准。自然语音依旧需要用户本机可选 API Key；不把 ChatGPT 登录和 TTS 授权等同，不收集现有 ChatGPT/Codex token。

本地程序没有购买代码签名证书，其他电脑分发/安装提示未测；本机已实际双击等效启动。尚未做 20 分钟真人学习、复杂长书/扫描书的完整验收，原 A06/A10/A12/A14/A15 等真人待验状态保留。原网页数据与桌面分区隔离，可先从网页导出 JSON 再导入桌面；不保存原 PDF 文件，重新打开同一本书恢复记录。

最小用户操作：双击桌面 PDF AI Teacher → 使用 ChatGPT 登录并在官方浏览器授权 → 核对可用解题模型并应用重启 → 打开 PDF 提问。若要自然 AI 朗读，再在本机高级设置填写可选语音 Key 并自行确认一次最小音频请求。真实 Key 不应发送到聊天。

最终交付状态（11:41）：桌面快捷方式目标已核实，正常启动的 exe 保持打开，主窗口句柄存在，未带调试参数；外部访问 4319 返回预期的 403。见 [运行状态](desktop-running.json)。asar 白名单核查共 277 条目，未发现额外目录或测试凭证，.env 不存在；见 [发布包核查](desktop-package-check.json)。白名单脚本初稿漏列预期 LICENSES.txt，出现一次误报，补入许可文件后通过，未删掉软件许可。


## 登录点击后无弹窗：真实复现与修复（2026-09-30 13:15）

### 根因与补齐的证据

上一轮桌面验收只检查登录入口存在，OAuth 为 mock，没有真正触发公开网络请求→系统浏览器这一整条路径，因此不能覆盖本次问题。实际复现：Node fetch 对公开发现地址返回 403、text/html（646ms）；同机 PowerShell 200（3.2s），Electron 独立 session.fetch 200/JSON（691ms）。原逻辑在读取发现配置失败后抛错，未执行 openExternal；UI 在设置底部显示错误，首屏看起来无反应。

现使用桌面专用 Chromium 网络，保留官方地址、TLS 校验、无 cookie/无重定向及取消；通过 createApp 注入后续模型和声音请求，避免只修登录而漏掉问答。错误反馈移到登录按钮下方并可重试。没有更改全局代理或其他程序。

### 本轮执行

- typecheck / lint / build / desktop:package 均通过；最终 Vite 2018 模块，原大 chunk 提示仍存在。
- Vitest：15 文件、318/318（1.26 秒）。新增 403 HTML 预检失败不打开浏览器、不泄露正文、可重试；新增 createApp 注入同一传输、OAuth 与独立声音 Key 分离。
- 全部 Edge E2E：50/50（32.8 秒，7 workers）。新增 720p 失败反馈完全可见、按钮恢复、再次点击成功；网络/桥接结果模拟。
- node scripts/verify-desktop-network.mjs --online：实际 Electron Chromium session + 本地 HTTP + SDK，请求不带已种下的测试 cookie、强制拒绝302跟随、取消关闭连接、form body、SSE、音频字节与 multipart 均通过。仅 discovery 请求真实 OpenAI 并收到200；无账号令牌、无付费请求。见 [网络 smoke](desktop-network-smoke.json)。去掉 --online 可仅跑本机。
- node scripts/verify-desktop-login.mjs：实际打包 exe、真实点击登录按钮、真实公开 discovery、调用原始 shell.openExternal 成功；仅记录官方 origin/path，不保存完整查询参数。系统默认 Edge 后续窗口标题实际为「使用 ChatGPT 登录 PDF AI Teacher - OpenAI」。见 [登录启动证据](desktop-login-opened.json)。这证明官方登录页面已打开，未填写账号或完成授权；测试会话随后取消。
- 最终真实桌面 smoke 与 app.relaunch 复跑通过：首次启动、单实例、Windows 加密、PDF/公式/笔记恢复、关闭服务仍正常。见更新后的 desktop-smoke.json / desktop-restart.json。

已实际查看 [720p 失败反馈](screenshots/desktop-login-failure-720.png)，错误在登录按钮下方并完全可见；[真实登录等待](screenshots/desktop-login-opened.png) 是实际 exe 截图。默认浏览器页面以实际窗口标题确认；浏览器/Computer Use 工具启动失败（sandbox helper read failure），未取得其页面截图，未假报已检查授权完成状态。

过程记录：网络会话改名时漏改一个 permission handler，首次 typecheck 失败，修正为 windowSession 后通过。第一版 Windows GUI 探测未等待子进程完整退出，未把空输出视为成功；改为 Node spawn 等待后拿到明确200。两项 UI 工具初始化失败已保留上述边界，不绕过授权或填写凭证。没有删测试。未授权的专业答案、声音与真人验收仍为未测。

使用方式：软件已重新打包到原 exe 路径，桌面图标不需更换；重新打开软件再点击「使用 ChatGPT 登录」。刚才自动检查打开的旧测试页面已取消，应使用软件新打开的页面授权。


## 免费本地中文语音与429提示（2026-09-30 16:27）

本轮按用户要求替换必须充值的默认朗读路径，接入本机CPU运行的Kokoro；没有发出付费请求，也没有读取既有ChatGPT/Codex凭证。模型和依赖已实际安装，声音存在于最终桌面包中。下列真人待验项目继续保留，不用自动测试替代音质评判。

### 最终执行与证据

| 检查 | 实际结果 |
|---|---|
| npm.cmd run typecheck | 通过，最终本地声音配置和异步播放器类型检查退出0 |
| npm.cmd run lint | 通过，包含新增安装、worker和真实桌面验证脚本 |
| npm.cmd test | 18文件、360/360通过（16:22，1.29s） |
| npm.cmd run test:e2e | 57/57通过（16:25，35.0s）；Edge真实PDF/选区、音频和网络按各场景标明模拟或真实 |
| npm.cmd run desktop:package | build + Electron构建 + 打包通过；2019 modules，原有大chunk提醒仍存在 |
| node scripts/verify-local-tts-desktop.mjs | 最终打包exe、真实CPU模型+真实HTMLAudio解码/时间推进，首音2363ms，无Key，0.25×且preservesPitch=true；暂停同句续播、真实跨句交接只有一个输出、停止释放全部audio src，0 pageErrors |
| npm.cmd run test:desktop -- --packaged | 真实首次启动、单实例、回环403、PDF/公式/笔记保存、Windows加密测试凭证、重开恢复、关闭服务均通过（16:19） |
| npm.cmd run test:desktop:restart | 实际app.relaunch、设置应用和学习存储保留、关窗停服务通过（16:19）；使用独立测试profile |
| npx.cmd tsx scripts/verify-local-tts.ts | 六种中文音色均真实生成24kHz/PCM16 WAV；初次4.4–4.8秒生成约24–27秒样音，热启动短句0.71–0.80秒；真实worker取消后重新生成成功 |
| 最终包内容检查 | asar282项仅白名单应用内容；原生运行库仅sherpa两包；发布模型与安装模型逐字节hash一致、worker与源文件一致、第三方许可齐全，没有账号数据或API Key |

原始证据：[六音色合成数据](local-tts-smoke.json)、[桌面真实播放](local-tts-desktop-smoke.json)、[软件包检查](local-tts-package.json)、[桌面基础检查](desktop-smoke.json)、[真实自动重启](desktop-restart.json)。桌面基础报告里的realModelAndTts未测指该基础脚本没有调用云模型；免费本地TTS由独立真实播放脚本验证，不能混淆。

真实桌面播放测试将音量设0，验证CPU合成、WAV解码、时间推进、pause/resume、音高保持开关和清理。为了快速到达下一句，在实际HTMLAudio元素上seek到句末触发真实ended；没有用假音频事件冒充解码。该测试不代表扬声器听感或完整自然播放20分钟。未登录/未带真实Key的隔离profile与普通用户数据独立，交付软件不带测试调试参数。

已实际查看：[朗读第二句](screenshots/local-tts-real-desktop.png)、[免费声音设置](screenshots/local-tts-settings.png)、[720p设置](screenshots/local-tts-settings-720.png)。选区高亮、逐句字幕、0.25×、免费标签和模型就绪状态正确；720p设置可滚动，音色和免费模式可见。没有仅凭终端无异常宣称UI完成。

### 覆盖与修复过程

- 新增本地worker离线验证14项：声音白名单、文本/速度限制、单任务、JSON/base64/WAV格式和长度校验、取消/超时/迟到结果/子进程故障/退出，禁止凭证与调试环境继承。真实native推理由两个独立smoke补充，mock不代表音质。
- 本地路由覆盖无Key/DEMO也可真实输出、显式缺模型失败、不自动切付费/系统声音、WAV缓存按文本和voice复用、免费记录不消耗付费会话预算、解题仍独立。
- 音频覆盖本地只预生成下一句、下一句交接不重复生成、停止丢弃迟到结果、付费路径不预生成、0.25仅应用一次。最终复核发现快速pause→resume可能在上游取消尚未排空时得到409，失败预取污染下一句。现按对象身份清理失败预取，真正到达该句才正常请求；已采用的失败预取也只转一次前台请求，不循环重试。补3项竞态回归。
- 设置迁移覆盖老版本无ttsEngine/localTtsVoice，保留测试账号/Key/解题模型。另修正local/system被隐藏的旧OpenAI语气校验阻止保存的问题，补2项；OpenAI模式仍严格校验。
- 429测试通过真实SDK+模拟fetch覆盖11种返回及请求标识，另有隐私单测、余额不足/未知原因720p浏览器提示；无自动重试、不曝光原始响应。截图：[余额不足](screenshots/tts-credit_balance_exhausted-720.png)、[原因未明](screenshots/tts-unrecognized_limit-720.png)。真实账单由用户截图提供，本轮未访问个人账单。
- 单连接模型下载过慢，改为固定官方资源的分段恢复并校验全部SHA256后解压；未修改系统代理。Node模型smoke最初通过，但真实Electron报503。进一步发现advanced IPC的V8版本不兼容及原生external ArrayBuffer限制，改JSON/base64和enableExternalBuffer=false后，真实exe合成/播放才通过；保留[当时失败截图](screenshots/local-tts-desktop-failure.png)。
- 初版音频测试暴露结束回调重复生效，已在最后句结束时取消旧回调；TypeScript还发现Buffer类型和标签变量错误，修正后全量通过。
- 浏览器初次53/57、随后55/57：既有fixture未声明mock TTS能力、旧系统声音文案、错误提示前缀不匹配；补真实测试配置与断言后57/57。一次与桌面打包并行运行导致Vite扫描发布目录中的DLL出现EBUSY，明确忽略release/runtime/test-results等生成目录，最终测试与打包顺序执行。不删测试掩盖失败。

### 未完成验收与最少使用步骤

人耳自然度、情感/停顿、术语和多音字、长教材20分钟稳定听感、与OpenAI同文对比均未验收。Kokoro是已装好的免费轻量候选，不声称超过OpenAI；Qwen3-TTS/CosyVoice3未安装，不能把研究记录当作已具备功能。真实专业模型账号权限/答案正确性也没有在本轮获得验证。

普通使用：双击原桌面PDF AI Teacher → 打开PDF选文字 → 朗读所选。无需充值/Key。设置→朗读声音→本地中文音色，可选六种并应用重启；先用1×比较，喜欢后再放慢。六个同文样音：[女声001](audio/kokoro-zf_001.wav)、[女声002](audio/kokoro-zf_002.wav)、[女声003](audio/kokoro-zf_003.wav)、[男声010](audio/kokoro-zm_010.wav)、[男声011](audio/kokoro-zm_011.wav)、[男声012](audio/kokoro-zm_012.wav)。用户只需给出喜欢的音色，以及读音或停顿不合适的具体句子，无需提供Key。
交付运行状态（16:28）：正常桌面窗口已重新打开，使用原用户配置，未带测试profile或调试参数；没有自动播放或自动提出问题。见 [启动记录](local-tts-running.json)。


## Qwen3 真实本机朗读与跨行年份修复（2026-09-30 17:12）

| 检查 | 实际结果 |
|---|---|
| npm.cmd test | 21文件、423/423通过，17:08；新增36项断句/年份与27项Qwen生命周期/路由测试 |
| npm.cmd run typecheck / lint | 通过，最终完整检查退出0 |
| npm.cmd run build / desktop:package | 生产网页、Electron与桌面打包通过；既有大chunk提示保留 |
| npm.cmd run test:e2e | 62/62通过，39.4秒；含5项Qwen界面场景，音频与bridge mock明确区分 |
| node --import tsx scripts/verify-qwen-tts.mjs | 三音色真实CPU、2线程、seed42生成24kHz/PCM16 WAV；停止生成后临时目录为空；详见 qwen-tts-smoke.json |
| node scripts/verify-qwen-desktop.mjs | 最终exe、隔离无Key profile，真实选区/校对、跨行整句、年份送入文本、WAV/HTMLAudio、0.25×/保音高、暂停原位续播、停止/取消、720p全部通过，0 pageErrors |
| 原生构建 | 原有工具链、CPU-only、C ABI probe、依赖审计和补丁校验通过；未安装系统组件 |
| 发布包 | 两份GGUF的完整SHA256、exe哈希、6份许可通过，asar288项未含私有配置或临时音频；见 qwen-package.json |

真实桌面样句为校对后的「2026年，我们\n一起读书。」，只发送一次「二零二六年，我们一起读书。」；字幕保留原文本。首音6258ms，真实音频2.88秒，0.25×播放时间推进，暂停恢复没有第二次生成。生成期间停止的界面响应12ms，服务端记录免费任务取消，1500ms观察期无迟到播放；不以该短观察宣称全天候稳定。年份规则和送入内容已验证，人耳实际读音仍未验收。

[真实桌面报告](qwen-desktop-smoke.json)、[三音色合成报告](qwen-tts-smoke.json)、[发布包校验](qwen-package.json)、[用户设置应用](qwen-applied.json)。已实际查看 [播放界面](screenshots/qwen-desktop-playing.png) 与 [720p声音设置](screenshots/qwen-desktop-settings-720.png)，Qwen标签、资源状态、语气输入和滚动布局可见。音频检查使用静音；没有冒充真人听感。

同文样音：[Serena](audio/qwen-serena.wav)、[Vivian](audio/qwen-vivian.wav)、[Uncle Fu](audio/qwen-uncle_fu.wav)。句子为「2026年，我们一起阅读这本书，\n先理解概念，再看一个例子。」；原始1×合成约12.4–12.8秒，音频7.36–7.76秒。较早随机seed的Serena样本长达21.04秒，说明输出存在变异，未把时长当音质评分；最终固定seed用于复现，不自动修剪内部停顿或编造语义识别结论。

过程问题与修正：完整lint初次发现新增import前保留BOM和验证脚本缺少global声明，已修复。Electron CDP对实际200音频的response.body返回空；再尝试fetch(blob:)被现有CSP拒绝，没有放宽产品CSP。最终验证捕获真实URL.createObjectURL的Blob并直接arrayBuffer读取，确认它就是实际播放器使用的WAV。中间一次CRLF文本替换未去掉原变量导致验证脚本重复声明，随后修正，失败记录保留在test-results隔离目录。E2E会清理test-results，所以最终可试听音频另保存在docs/audio。没有删除测试掩盖失败。

取消回归包含读盘期间停止、子进程退出后才释放任务、超时、跨chunk/大量stderr后的截断标记，以及免费DEMO/缓存/禁止云回退。真实桌面使用正常原生模型补足模拟进程测试；真实账号、付费接口、专业回答、长书20分钟、中文多音字与「超过OpenAI」仍未验收。

普通使用：双击原桌面图标。当前已通过软件UI选好Qwen3/Serena，解题设置及Key存在状态保留，未读取或输出密钥；重新选择一小段，先用1×朗读。模型都已打包，不需执行安装命令。开发者重建可用 npm.cmd run tts:build:qwen、npm.cmd run tts:setup:qwen、npm.cmd run desktop:package；仅前两步需要已有C++工具链/公共模型下载。

交付状态（17:16）：已用原用户配置正常重开桌面窗口，无调试参数或测试profile，未自动播放；见 [正常启动记录](qwen-running.json)。工具环境本身带ELECTRON_RUN_AS_NODE=1，首次直接启动未出窗口；最终仅从该次启动子进程环境去掉此变量后，窗口标题和响应已确认，不修改系统环境。


## GPU 朗读与 3 倍速最终验收（2026-09-30 18:00）

| 检查 | 实际结果 |
|---|---|
| npm.cmd run typecheck / lint | 最终产品代码完整通过 |
| npm.cmd test | 21 文件、439/439 通过（17:56，1.77s）；增加GPU设备/缺DLL/不回退及3倍速回归 |
| npm.cmd run test:e2e | 72/72 通过（43.7s）；含等待停止、设备配置、3倍速/保音高/持久化和Realtime独立上限 |
| npm.cmd run desktop:package | 最终3倍速版本生产构建、Electron构建和打包通过；既有大chunk提醒保留 |
| 原生GPU基准 | 34字冷进程2.016s、重复新进程1.776s；107字完整长句3.133s生成25.76s WAV，全部EOS |
| 真实桌面短句 | 点击到原生HTMLAudio playing事件 1394ms，3.04s音频，0.25倍速/保音高/暂停原位继续/停止通过 |
| 真实桌面长句+3倍速 | 118字符含标点，一次整句请求；点击到真实playing事件 5078ms，43.36s原速WAV，HTMLAudio.playbackRate=3、preservesPitch=true；暂停续播不重生成、单输出、取消通过 |
| 真实GPU三音色 | Serena1.68s→7.60s音频；Vivian1.69s→8.08s；Uncle Fu1.83s→10.00s，24kHz PCM16正常，取消清理通过 |
| 发布包 | GPU exe+2份cuBLAS DLL、CPU修复exe、2份GGUF完整SHA256核对；7份许可，asar288项未含私有配置/临时音频 |
| 原用户设置 | 通过软件UI选GPU，保留用户当前Uncle Fu音色/语气、解题模型、账号选择及Key存在状态；重开确认speech.device=cuda |
| 正常交付窗口 | 18:00正常配置启动，窗口响应；无测试profile/调试参数，没有自动朗读或提问 |

证据：[CPU/GPU同文基准](qwen-cuda-benchmark.json)、[UTF8修复CPU基准](qwen-utf8-file-benchmark.json)、[隔离环境真实provider](qwen-gpu-provider.json)、[真实桌面短句](qwen-gpu-desktop-short-smoke.json)、[真实桌面长句3倍速](qwen-gpu-desktop-three-smoke.json)、[三音色](qwen-gpu-voices-smoke.json)、[发布包](qwen-gpu-package.json)、[用户设置](qwen-gpu-applied.json)、[正常启动](qwen-gpu-running.json)。

已实际查看[GPU声音设置](screenshots/qwen-gpu-desktop-settings-720.png)、[3倍速真实播放](screenshots/qwen-gpu-desktop-three.png)、[720p等待状态](screenshots/qwen-wait-720.png)。设置可滚动、GPU与音色可见，播放条3×/所选原文字幕/暂停按钮明确。浏览器E2E的网络与WAV模拟不充当GPU推理证明；上述独立Electron检查使用真实模型、真实WAV解码和播放事件，但音量为0，不代表人耳验收。

首音测量修正：最初桌面长句报告qwen-gpu-desktop-slow-smoke.json的9191ms包含把2MiB真实Blob送回CDP进行校验的开销，不是纯首音时间。最终脚本直接在真实HTMLAudio playing事件记时，将8940ms的验证完成时间与5078ms的首音时间分开。没有把原生stream首PCM约0.87s冒充产品首音。当前应用仍是完整句子WAV，端到端流式播放未接入。

失败记录：原CPU文件/流式同34字曾0xC0000409，见qwen-file-benchmark.json、qwen-stream-benchmark.json。修复Windows argv UTF8后原句重新成功，CPU/GPU文件与原生流式都通过。原生编译使用现有工具链约十余分钟，未安装/修改CUDA、驱动、Conda或训练环境。GPU运行显存增量约2.6GiB，任务结束释放；没有停止其他进程。一个新GPU错误文案单测曾因PowerShell管道编码导致替换未生效而失败，显式UTF8后修正并完整复验。

人耳自然度、语义重音/多音字/专业符号准确性、长书20分钟稳定听感，以及与OpenAI/豆包/腾讯的同文盲听比较仍未验收。云TTS、真实专业解题账号与付费接口未测、未产生付费请求。更高倍速只验证播放器与音高保持开关，不承诺3×同样自然或可懂。可试听[当前Uncle Fu GPU样音](audio/qwen-gpu-uncle_fu.wav)、[GPU教材长句](audio/qwen-gpu-desktop-long.wav)。

最少操作：已经正常重开软件，打开PDF重新选一段→朗读所选；底部语速可选0.25–3×。以后双击原桌面图标即可，不需Key、终端或重新安装。开发者：npm.cmd run dev；重建桌面npm.cmd run desktop:package；GPU本机编译npm.cmd run tts:build:qwen:cuda；真实复验node scripts/verify-qwen-desktop.mjs --device cuda --long --rate 3。


## 原位变速、公式朗读与官方豆包适配验收（2026-09-30 23:50）

| 检查 | 结果与范围 |
|---|---|
| npm.cmd test | 最终26文件、664/664通过（23:42，1.78秒）；含有界数学解析/整段管线/Unicode上下标/中央输出拦截、独立云TTS和凭证迁移 |
| npm.cmd run typecheck / lint | 完整通过；只读和脚本改动后再次定向检查 |
| npm.cmd run test:e2e | 最终83/83通过（48.2秒），真实Edge页面/鼠标PDF选区；模型、云响应和大部分声音使用明确mock |
| npm.cmd run desktop:package | 最终生产网页、Electron构建和打包通过；已有大chunk提示与开发Vite HMR弃用提示保留 |
| node scripts/verify-speech-continuity.mjs --save-wav | 最终exe、隔离无Key profile、真实Qwen CUDA/UncleFu、静音HTMLAudio，32.437秒完整通过，0页面错误、0renderer云请求 |
| 原位变速 | 1→2时currentTime0.826215→0.843632；2→0.5时1.494972→1.495544；0.5→3时1.757437→1.778455，始终同一Audio，无seek、无同句重生成 |
| 三句连播 | 118/51/48字符分别只一次生成；首句32.72秒原速音频。后两次3×自然ended→playing为14.2ms和14.4ms；这是播放器交接，不含音频内部的静音停顿 |
| 公式真实管线 | 原文「式子为 $\frac{1}{1-\beta^t}$。」送入Qwen前变成「式子为 分数开始，分子为一，分母为一 减 贝塔 的 t 次方，分数结束。」；原字幕保留LaTeX。实际生成453164字节、9.44秒WAV |
| 豆包服务 | 41 provider合同测试+新集成/vault/UI回归；固定官方host、无Key不请求、不回退、取消/超时/额度错误、跨速度缓存、未知字符用量null通过。真实免费额度、接口连通性、音质均未测 |
| 发布包核验 | CUDA exe/两份cuBLAS DLL/两份GGUF及CPU exe哈希通过；7份许可；asar288项不含私有配置或临时音频，见speech-package.json |
| 正常启动 | 原用户profile重开，仅移除启动子进程的ELECTRON_RUN_AS_NODE，未改变系统环境；无debug/test参数，无自动朗读或提问。正常窗口标题与响应见speech-running.json |

实际查看了[公式预览](screenshots/math-reading-preview-720.png)、[未知公式校对](screenshots/math-reading-review-720.png)、[豆包设置](screenshots/doubao-settings-720.png)与[真实GPU变速页面](screenshots/speech-rate-change-720.png)。1280×720逻辑窗口可滚动，上一句/下一句和速度可操作；Electron在本机1.5DPI保存的截图为1920×1080物理像素。设置截图中凭证状态来自测试bridge，不能当作真实豆包已配置。

证据：[真实连续播放报告](speech-continuity.json)、[发布包核验](speech-package.json)、[第一句样音](audio/speech-continuity-first.wav)、[第二句](audio/speech-continuity-2.wav)、[第三句](audio/speech-continuity-3.wav)、[公式样音](audio/speech-formula.wav)。真人听感和发音正确性未验收，样音不证明“优于OpenAI”。此轮没有付费请求。

过程失败保留：第一轮全E2E为67过/14失败，7项旧文案、整页公式checkbox旧流程、后段会话容量耗尽导致页面无配置。开发StrictMode的并发getConfig曾创建重复会话，已合并仅在途初始化请求（不提高128会话上限），补成功/失败后可重新获取状态测试。整页PDF中的丢失帽符NUL不允许直接读，原测试改为验证真实校对流程，未删除覆盖。第二轮81过/2失败：一处测试文本替换未落盘已修；另一处刷新后未等待配置mock完成即销毁context，现等待实际声音状态后结束。两文件19项定向复验全过，最终83全过。测试失败截图/上下文保留于.model-cache/speech-e2e-first-failures和执行记录。

真实桌面首轮因720p下目标行未滚入PDF可见区域而拖选失败，0语音请求；保留test-results/speech-continuity-profile中的failed报告。脚本改为先scrollIntoViewIfNeeded后真实鼠标拖选，第二轮完整通过。未降低产品选区或播放断言。正常窗口外的HTTP请求被桌面guard拒绝，未放宽安全配置。

当前边界：OpenAI及系统声音尚沿用原来的句首改速；本地Qwen/Kokoro和豆包支持原位改速。Qwen逐句生成的模型音色/语气变动与音频内部停顿仍不能承诺完全消除。豆包没有凭证所以没有真实试听；不把模拟响应、官方支持LaTeX或14ms软件交接当作自然人声保证。开发启动npm.cmd run dev，双击release/PDF AI Teacher-win32-x64/PDF AI Teacher.exe运行桌面；重建npm.cmd run desktop:package。


## 2026-10-01：自动重开书籍/页码、模型公式认读验收

- 环境：Node v24.19.0、npm 11.17.0、Git 2.50.1.windows.1；任务开始 Git clean，根 AGENTS/PRD/START_HERE 已读。
- npm run typecheck：通过；npm run lint：通过；npm run build：通过；npm run desktop:package：通过（Vite仍有既有>500kB bundle体积警告，不影响产物）。
- npm test：747/747 通过（28文件）。首次与E2E并行启动导致Playwright清理共用test-results，使Qwen fake-child写WAV报ENOENT；已改顺序执行，全量通过，未改测试断言掩盖错误。
- npm run test:e2e：92/92 通过，51.6秒，真实Edge/IndexedDB/PDF.js/HTMLAudio。新增5项自动恢复场景和4项自动认读场景；GPT及TTS响应用显式mock，不代表真实模型准确性或听感。
- 首轮全量E2E 87通过/5失败：2项旧测试仍在刷新后点击已消失的示例按钮，2项旧声音选择器匹配新增恢复卡，1项新增框选测试误用图片CSS。已更新自动恢复期望、独立恢复卡样式及真实图片定位，保留原验证断言；失败trace/screenshot/context留在.model-cache/reading-first-e2e-failures，最终全量通过。
- 新认读流程验证：未识别公式打开窗口自动一次请求；body只有选区上下文/PNG及Envelope，无历史/额外整书；中文稿一键进入实际播放器；uncertain禁止采用；关闭取消且迟到响应不改内容/不播音；纯图片框选可以识别，已采用稿再次打开不重复请求。PNG裁剪与播放器是真实本机能力，模型结果为mock。
- node scripts/verify-desktop-reading-reopen.mjs：真实生产打包EXE、隔离profile、无Key、无mock PDF。选择自制sample.pdf，翻到PDF第2页并写笔记，关闭窗口确认进程退出/4319释放，再重启同profile；不点击选书或导航，恢复同SHA/页2/笔记，canvas非空像素和文本层均验证。0模型/声音请求、0上游网络请求、0页面错误。报告：[desktop-reading-reopen.json](desktop-reading-reopen.json)。
- 已目视检查720p自动识别窗口与真实桌面恢复画面。证据：[reading-assist-preview-720.png](screenshots/reading-assist-preview-720.png)、[desktop-reading-reopen-720.png](screenshots/desktop-reading-reopen-720.png)、[reading-restore-settings-720.png](screenshots/reading-restore-settings-720.png)。模型名mock-vision表示模拟，不是用户真实配置。
- 未测：真实GPT对用户教材的识别准确率、真实账号/云费用、新朗读稿的真人听感、加密PDF自动重开密码流程、大PDF接近100MiB的实际磁盘压力。没有声称本轮验证了真实云接口。

用户最少步骤：双击原软件图标；更新后先打开一次自己的书，之后自动恢复。遇到复杂公式点「朗读所选」，模型已配置时自动准备稿件，再点「使用并朗读」；未配置时进入GPT设置，Key只在本机填写。

交付时已启动普通用户配置的新版桌面窗口，PID 26600，标题「PDF AI Teacher · 学习工作台」、Responding=true；没有测试profile/调试参数，没有改账号或声音配置。见 [reading-running.json](reading-running.json)。


## 2026-10-01 16:55：跳过公式与豆包单句提前准备

环境：Windows、Node24.19.0、npm11.17.0、Git2.50.1，Edge真实浏览器/HTMLAudio，Electron44.5.0打包应用。范围仅本项目；未读取凭证、调用付费云接口或变更科研/Conda/CUDA/代理/训练进程。

|检查|实际结果与证据|
|---|---|
|npm run typecheck / npm run lint|通过。首轮lint发现新正则3处冗余转义，已修复并复验。|
|npm test|30文件、819项全部通过。公式投影43项、句源/版本测试、79项音频控制、记录导入导出及课堂恢复均包含。|
|npm run test:e2e|95用例；最终全套94通过，唯一失败为workspace旧自动弹窗断言，与新需求冲突。原改写因换行匹配没有落到该文件，第二次仍失败；随后明确修正入口为主动校对，保留暂停/文字打断/续读所有断言。|
|Playwright定向复测|npm run test:e2e -- tests/e2e/workspace.spec.ts -g '同一句暂停续播'：1/1通过。其余94项已在最终产品代码上通过，未删除失败测试；合计95用例完成验证。|
|真实PDF与UI|1280×720实页检查：原文选区保留公式，提示跳过数量，点击后没有自动识别窗口，播放器/上一句/下一句/停止可见。见screenshots/prose-reading-skip-720.png。主动校对仍提供AI入口，打开不会调用，见screenshots/reading-assist-preview-720.png。|
|默认不调用识别|真实PDF选择正文+公式与纯公式两类E2E，reading-assist/ask请求为0；只把可读正文送入模拟TTS，纯公式不请求TTS。图片选区也不会自动识别。|
|连续播放与取消|350ms模拟接口延迟、真实HTMLAudio完整WAV；第二句请求在第一句播放时发生，句末到下一句playing为42.6ms，复用同一次生成、无叠音；第三句预取停止取消，迟到响应不播放。详见prose-doubao-continuity.json，realCloudTest=false。|
|变速/暂停/导航|云预取暂停保留一个槽、0.25–3倍速不重头、不重发当前/预取请求；下一句直接消费槽位；停止、重选、外部音源、提问和迟到响应安全性均验证。|
|生产与桌面|npm run desktop:package通过（包含npm run build/typecheck、前后端打包）。仍有既存>500kB前端chunk警告，不影响构建。|
|桌面退出重开|node scripts/verify-desktop-reading-reopen.mjs通过：真实exe、本机隔离无Key档案，关闭释放进程/端口，自动恢复PDF第2页和笔记，远端/API用量0、pageErrors0；见desktop-prose-reopen.json。|
|真实云/听感|本轮未测真实豆包接口、首音延迟、音色/韵律或人耳连续听感；不把静音WAV模拟当成真实语音，不保证所有网络无缝。|

程序已恢复到普通用户配置运行，见prose-reading-running.json。已有账号和音色不变。以后双击原图标即可；选两三句混合文字并点击「朗读所选」实听，不需手改公式或等待GPT。公式过滤是本地启发式，损坏PDF若丢失全部数学标记仍可能漏检。旧严格读法的句锚点不沿用；书/页码照常恢复。暂停可能让最多一条已发出的下一句合成完成，停止前已产生的额度不能撤销。


## 2026-10-01：截图板书响应与选文听书并行

环境：Windows，Node24.19.0/npm11.17.0/Git2.50.1；任务开始Git干净，AGENTS/PRD/START_HERE已读取。代理使用独立worktree并划分文件，完成后cherry-pick集成。未修改其他项目、Conda/CUDA、代理或训练进程。

|检查|实际结果|
|---|---|
|npm run typecheck|通过；最终desktop:package中的tsc --noEmit再次通过。|
|npm run lint|通过；最终代码复验通过。|
|npm test -- --reporter=dot|33文件874/874通过。新增流式provider/collector32项、HTTP通道隔离22项、课堂分离版本1项。|
|npm run test:e2e|初次全套99/99通过，54.6秒。旧“Esc取消选区应取消回答”用例改为显式取消解答，保留迟到结果/拖框清理断言，满足新需求。|
|最终受影响回归|补上“播放/恢复已有讲解不取消问答”边界后，执行board-concurrency、classroom-m2、realtime-m3、text-teacher四文件，24/24通过，24.9秒。含新增3项；累计102个不同浏览器用例完成验证，未称最终102在同一次全套执行。|
|关键并行场景|真实PDF截图第1页发问，清选区、切跟随、翻第2页、选文朗读；问答main未cancel，TTS为speech，原截图来源保持不变。返回后板书引用第1页，当前选区/音频对象/播放位置继续。|
|取消与重试|草稿不取消回答；取消解答不停止当前声音且拒绝迟到板书；换书同时取消两条任务。失败重试问题、截图、上下文相同；坏schema降级warning显示失败而非可听的成功回答。听既有讲解/停止/继续保持后台提问。|
|服务器HTTP|真实Express路由+模拟provider：两个活动任务并行；两方向独立取消、迟到取消、不允许旧版本、重复请求不增额度、共享速率/预算、刷新版本恢复、Origin/CSRF及lane限制、会话失效/dispose同时释放均通过。|
|Responses读取|SDK解析模拟SSE：delta/done/output_item/content_part、completed完整优先、空completed回补、commentary/reasoning剔除、拒答/断线/incomplete/超限及坏JSON；无真实云请求。|
|UI目视检查|检查实际Edge截图的等待卡、原图页码、失败重试、数学板书和1280×720播放器布局。证据：[等待时继续读第2页](screenshots/board-concurrent-pending.png)、[旧截图板书与新段朗读](screenshots/board-concurrent-reading-720.png)、[原题重试](screenshots/board-question-retry.png)。声音使用真实HTMLAudio解码的静音WAV，答案为显式mock。|
|构建及交付|npm run build与npm run desktop:package通过。保留既有Vite大chunk警告，未改完成标准。关闭经路径核实的本项目窗口后更新包，未全局杀进程。|
|生产桌面退出重开|node scripts/verify-desktop-reading-reopen.mjs通过：真实EXE、隔离无Key档案、真实PDF第2页及笔记恢复，0远程请求、0模型/TTS请求、0页面错误。见[desktop-board-reopen.json](desktop-board-reopen.json)。|
|真实接口/听感|本轮未测真实ChatGPT/GPT教材解题、模型延迟、豆包云语音或真人听感；没有把mock或结构校验通过称为真实教学能力通过。|

对应验收：A02/A03/A04/A08/A09/A18/A20本地与模拟回归通过；真实模型部分仍待用户复验。普通用户桌面已重新打开，见board-reading-running.json。保持原账号、模型、音色与私有配置；重试一次新截图问题，等待时可选其他段落朗读。开发启动npm run dev；正常使用双击原图标。停止前已发生的云请求可能仍有用量，手动重试不保证免费。

## 2026-10-04：CosyVoice 3 实际安装、GPU合成和桌面播放

环境：Windows、Node24.19.0/npm11.17.0、Python3.11；RTX5080 16GiB、驱动591.86、torch2.8.0+cu128。只在本项目安装虚拟环境、固定官方源与5.43GB所需权重；未改其他项目/训练进程/全局环境。前后端代理在独立worktree提交后合并。

|检查|实际结果与边界|
|---|---|
|安装与依赖|权重大小/hash校验通过；pip check通过；真实CUDA张量计算返回2.0。旧Whisper的隔离构建缺pkg_resources曾失败，以项目venv内setuptools80.9.0和no-build-isolation解决。|
|真实GPU合成|`py -3.11 -u scripts/verify-cosy-runtime.py`：首次ready10.767秒；39/57/319字首PCM1.712/1.001/1.016秒，音频8.84/12.72/62.32秒，生成4.411/5.930/28.537秒。模型torch已分配显存3313MiB（不代表进程总显存或峰值）。|
|真实音频解码|三个MP3均由ffmpeg成功解码，非零PCM，峰值0.9712/0.9315/0.9854；头部近静音约206/100/266毫秒，不能用第一字节冒充真人听到的首音。见[本机数据](cosy-runtime-verification.json)。|
|真实取消|`py -3.11 -u scripts/verify-cosy-runtime.py --cancel-only`：首token前取消、输出首块后取消均成功；中途取消排空116毫秒，同一worker随后首PCM1.010秒，无重新冷加载。见[取消记录](cosy-cancellation-verification.json)。|
|最终unit/integration|`npm test`：37文件911/911通过；模型协议/HTTP使用mock，含流式返回、CPU拒绝、错误、迟到响应、取消不缓存partial、EOF后预取和旧owner回调隔离。|
|Edge E2E|`npm run test:e2e`完整103/103通过；最后预取修正后代理独立worktree再跑Cosy+Doubao7/7。真实MSE解码自制正弦MP3验证未EOF先播、原位变速/暂停、断流、取消、缓存。未将这些模拟音频计为模型质量验收。|
|静态检查和打包|typecheck、最终lint、build、desktop:package通过。初次lint误进入独立Readest第三方目录而失败，显式忽略`.external`和模型runtime后通过；未移除产品源码或测试。保留Vite大chunk警告。Python三个脚本py_compile通过。|
|普通桌面smoke|`node scripts/verify-desktop.mjs --packaged`通过：真实PDF选区、演示KaTeX、窗口单实例、回环隔离、Windows加密、重启笔记；无云模型请求。|
|真实GPU桌面|`node scripts/verify-desktop-cosy.mjs`通过。隔离无Key档案、真实已打包EXE，首次点击到playing11.129秒含加载；HTTP未结束先播；两句22.344秒+7.584秒在1×播放中无非起始waiting事件；句间交接22毫秒。前后句、0.25/3×原位变速、暂停续播、停止24毫秒、0页面错误。见[桌面记录](cosy-desktop-verification.json)。|
|界面检查|已打开并目视检查[真实桌面](screenshots/cosy-real-desktop.png)、[已加载模型状态](screenshots/cosy-real-settings.png)，PDF、声音来源、播放器和状态可见。|
|失败修复记录|首轮隔离进程未继承USERPROFILE导致ModelScope计算home失败；补充必要路径环境并将缓存限定项目后通过。真实桌面最初发现首句未EOF就预取下一句，被speech lane拒绝；改为EOF后预取，复测通过。中途取消最初触发上游零长度RTF日志除零；改为只在取消排空时丢弃哑块并保留清理，真实取消复测通过。最初桌面脚本在读完全部句子后点击禁用的“上一句”失败，改为先重播再检查前后句，未修改产品来迎合断言。|
|用户配置|通过正常桌面设置接口保存cosy；原账号模式、文字/视觉模型、云Key存在状态保持一致，没有读出/打印Key。|
|未测|真人音质、长教材多音字/语义发音、与OpenAI/豆包盲听、20分钟真人学习；没有测试真实云服务。固定示例音色不表示声音商用权已核实。|

当前A06/A07/A18音频的本机实测与自动化部分通过，真人听感仍待用户。运行与复现见[CosyVoice说明](cosyvoice-setup.md)。首次加载后约1–2秒首块是本机小样本结果；高倍速、GPU竞争或其他文本可能等待更久，不承诺全场景不卡顿。
## 2026-10-04：六音色接入与官方音色库试听（上一版，用户已淘汰）

- 已执行：`npm run typecheck`、`npm run lint`、`npm test`（935项／38文件）、`npm run test:e2e`（108项完整Edge）、`npm run desktop:package`均通过。构建仍提示较大的前端chunk，不影响构建成功。`py -3.11 scripts/test-cosy-voices.py` 7项通过，覆盖参考缺失、损坏、未知ID、路径越界、重复条目、manifest恢复；安装脚本重复执行后全部哈希通过。
- 真实本地GPU：`py -3.11 scripts/verify-cosy-voices.py` 对6个声音用同一169字段落合成，首MP3 1.04–1.34秒（不含9.9秒模型加载），声音31–36秒、生成11.6–13.9秒。回切已用音色参考编码0ms，未加载第二个模型。数据在[六音色GPU记录](cosy-voices-verification.json)，原音频在被Git忽略的`cosy-tts-runtime/verification/voices/`。哈希不同不是人耳能区分声线或好听的证明。
- 真实取消：`py -3.11 scripts/verify-cosy-runtime.py --cancel-only`通过，首token前取消1ms、中途取消113ms，同进程随后成功发声，见[取消记录](cosy-voices-cancellation-verification.json)。
- 真实打包桌面：`node scripts/verify-desktop-cosy-voices.mjs` 用独立本地测试配置，对6个音色逐个真实GPU合成并通过HTMLAudio/MSE播完；首个冷启动11.32秒，后5个点击到播放1.07–1.36秒，独立复测均无中途waiting。切换/关窗停播、单一音源、保存后重启恢复新音色通过，见[桌面记录](cosy-voices-desktop-verification.json)及[实际界面截图](screenshots/cosy-six-voices-desktop.png)，截图已查看。
- 保留失败：第一次桌面测试与8个Edge测试worker同时运行，默认音色在1.13秒和3.16秒播放位置出现waiting，见[并行负载失败记录](cosy-voices-desktop-stress-verification.json)。结束其他测试后同脚本独立重跑通过；不承诺任何系统负载下都不卡。未删除断言或替换为mock。
- 模拟与真实边界：108项E2E包含真实PDF、真实MSE媒体管线，但云模型/音频fixture仍是模拟；没有新调用ChatGPT、OpenAI或豆包。六音色新增预览的问答并行、晚到声音拒绝和原文续读由自动测试验证。计划补做的新增音色完整PDF两句GPU播放测试被用户新指令中断，未执行，不计通过；此前默认声音的真实PDF播放记录仍保留。
- 用户主观结果：随后明确反馈当前六个声音不够好听，声音质量未获认可。未做“优于豆包/OpenAI”的结论，没有真人盲听或长篇教材发音正确率评测。转向用户先选音色。
- 新试听入口核验：公开[CosyVoice官方音色库](https://help.aliyun.com/zh/model-studio/cosyvoice-voice-list)不登录即可显示216个audio元素（含不同模型，不代表216个唯一音色）。独立Edge测试实际播放「龙三叔」样音，音频长19.52秒且currentTime前进，未填Key/提交PDF/请求合成；[研究demo新地址](https://qwenaudio.github.io/cosyvoice3/)也可访问。内置浏览器/Windows助手启动失败（kernel退出），改为默认浏览器打开公开链接，并用项目Playwright独立浏览器验证，未操作用户登录资料。

## 2026-10-04：用户所选六种声音的本机参考版

- 范围：只保留六个 local_long* 参考音色与关闭朗读；云参数本身不是下载后的本地音色。参考文件为用户从官方公开目录选定的六份试听，完整解码并校验。未调用云 TTS、使用真实 Key、改动科研环境或训练进程。
- 安装复现：六份源/解码文件 SHA-256 全部通过。将本项目明确的 local_longfei_v3.wav 临时移到同目录备份后，实际重新下载和解码，结果与原文件逐字节一致，再清理备份；安装器再次幂等执行成功。符号链接目标拒绝，旧安装器五份 AISHELL WAV 在新文件验证成功后移除。
- Python：8项参考校验测试通过，覆盖六个新ID、坏文件/清单/路径、旧ID拒绝；worker与安装/验证脚本 py_compile 通过。
- 六声音真实GPU：同一169字段落、RTX5080、0.5B模型，首次ready19.048秒。首MP3为2.397/1.658/1.412/1.662/1.422/1.465秒，音频28.08–33.72秒，RTF0.382–0.466；回切首个声音参考编码0ms，短句首MP3 0.870秒。完整数据：[真实参考合成](cosy-local-references-verification.json)。不是官方网站样音回放。
- 真实取消：首次token前1ms、中途111ms完成取消，同一模型随后生成成功，见[参考版取消数据](cosy-local-references-cancellation-verification.json)。
- 生成内容粗检：本机Whisper small转写六段新生成音频，没有英文系统提示或原参考整段串入。龙飞完整转写和17–29秒局部转写都缺少“权重小的部分影响更少”，记为疑似漏读，界面明确提示先试听；不能将ASR结果当作真人语音正确率或好听的证据。[原始转写记录](cosy-local-references-asr-check.json)。
- 首次真实桌面失败：默认参考音色在播放位置0.788秒发生waiting；该次测试已停止，保存[失败记录](cosy-local-references-desktop-initial-failure.json)。说明RTF小于1不等于首块接续无卡顿，需补起播缓冲。
- 自动化初轮：typecheck/lint通过；unit 943通过、4项仍断言旧“配置在线朗读”提示而失败，按当前“启用本机朗读”更新后947/947通过。完整Edge108项初轮107通过，唯一retired-speech-ui旧下拉选项断言失败；改为用户要求的none/cosy后相关8/8通过。未删除测试或放松无声音回退约束。
- 构建：本轮初版 build/desktop:package 成功；保留已有Vite大chunk提示。后续起播缓冲修复、最终打包与真实桌面复验结果补充如下。
- 最终缓冲修复：本机MSE在开播前等待2秒可播放储备（按倍速折算），短句EOF即放行，暂停/停止撤销待播放请求。最终lint、包含typecheck的build、desktop:package及952项unit全部通过。新增及相关18项unit、11项Edge/MSE浏览器回归在独立worktree通过；这些浏览器检查是分批执行，没有声称最终109项在同一次全量执行。
- 修复后真实六音色桌面：独立无Key档案、真实打包EXE与本机GPU，对同一约130字段落逐个播放至结束。首次含模型加载11.934秒，其余2.106–2.453秒开播；六次均无中途waiting。换声音/关设置即停、单音源、保存重启恢复龙安昀本地参考通过，零页面错误。[最终桌面证据](cosy-local-references-desktop-verification.json)，[实际界面](screenshots/cosy-local-references-desktop.png)已目视检查。首次失败仍保留，不承诺所有负载下都不卡。
- 真实PDF播放复验：`node scripts/verify-desktop-cosy.mjs`通过，使用隔离档案、自制PDF选区及明确校对的两句正文，龙安洋本地参考实际GPU生成。冷点击到开播11.898秒、HTTP未结束先播放；两句21.504秒/6.048秒无中途waiting，句间交接15ms，0.25/3×原位变速、暂停续播、前后句与停止15ms通过，零页面错误。见[读书链路数据](cosy-local-reference-reading-verification.json)，[实际PDF界面](screenshots/cosy-local-reference-reading.png)已查看。
- 最终交付：已更新原EXE，并启动正常用户档案窗口，进程3100响应且有可见窗口，见[启动记录](cosy-local-references-running.json)。测试使用隔离档案，没有用测试Key/书籍/语速覆盖用户偏好。最终源码diff检查通过。
- 未完成验收：真人音色偏好、与云端原版相似程度、长教材漏读/错读和20分钟真人连续试听；龙飞疑似漏词保留为已知限制。没有测试或请求任何真实云TTS，未承诺比豆包/OpenAI更好。
