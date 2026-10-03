# 免费云语音候选与试听

## 2026-10-03：回到本软件，核验 ChatGPT Pro 与微信朗读

用户已试听 Readest 并认为效果不错；本次明确回到 PDF-AI-Teacher，探索能否利用现有 Pro 订阅或微信消息朗读，实现自然、快速、连续的中文朗读。本节覆盖此前仅凭 Edge 来源排除 Readest 的听感推断；真人反馈优先，但不代表两软件已融合。

### ChatGPT Pro

- [官方 Voice 说明](https://learn.chatgpt.com/docs/features/voice)确认 ChatGPT 桌面端存在 GPT-Live 语音并支持 Pro。产品内语音可用，不等于其声音引擎、识别功能或订阅权益可直接复制到外部阅读器。
- 不能笼统说订阅完全不能用于第三方软件：[Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)允许合资格应用以自有 OAuth 授权调用公开 Responses 端点。当前公开支持路径未提供将 Pro 内置朗读权益用于 Audio Speech/Realtime 的说明。文字/图片推理授权不作为语音授权证据。
- [SIWC 的 app-server 配置](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)同样使用公开 Responses provider；[通用 app-server 文档](https://learn.chatgpt.com/docs/app-server)允许已有本机/开源应用继续原有登录方式，但本轮未找到当前、正式支持第三方 Pro 朗读的 voice RPC 文档。Codex 客户端已有 Voice，不足以证明可作为本软件的受支持 TTS 接口。没有探测未公开端点或读取其他应用凭证。
- [Audio Speech API](https://developers.openai.com/api/docs/guides/text-to-speech)有正式流式生成能力，可在完整文件生成前开始播放；这是独立接口，不承诺与 ChatGPT 内置 Voice 同音色或享有相同套餐权益。

### 微信与腾讯云

- 未找到微信聊天消息朗读向 Windows 第三方软件开放同款音色/API 的官方证据。不能依据腾讯品牌相同就声称听感相同。
- 腾讯官方[微信同声传译示例](https://github.com/Tencent/Face2FaceTranslator/blob/master/pages/index/index.js)使用 requirePlugin('WechatSI') 与 textToSpeech，是小程序插件形态，不是本机 Node 通用语音接口。
- [腾讯云实时语音合成](https://cloud.tencent.com/document/product/1073/94308)是可接入的 WebSocket 流式服务。官方[计费页](https://cloud.tencent.com/document/product/1073/34112)列大模型音色 10 万字符、超自然大模型音色 2 万字符免费包，每账号一次、领取后 3 个月；不是永久免费。本轮没有领取、开通后付费或发起真实请求。

### 本软件等待的已知原因与建议

本机 PDF.js 已提取文字，默认 prose 模式本机过滤公式，无需先请求 GPT 识别。豆包 NDJSON/PCM 在 doubaoTts.ts 内完整聚合成 WAV；OpenAI 在 provider.ts 内完整聚合 MP3；HTTP 路由等待全部完成，前端 api.ts 再等待 response.blob()，playback.ts 最后创建 HTMLAudioElement。不是端到端流式。

豆包仅在当前句开始播放后提前生成一句，下一句 Blob 到达后未提前准备播放器；3×播放缩短缓冲可覆盖的时间。OpenAI当前没有同样的预取。因此不能把等待一概归咎于语音模型，也不能以换引擎代替播放链路改进。

建议先用腾讯官方可试听中文声音和同一原创长文做对照，再决定接入；播放侧采用真正增量传输/播放、按可播放时长管理有界预备缓冲、固定音色、按语义断句、公式继续跳过。PCM 流式变速还需保调实现与浏览器验证，不以简单切 WAV 或 AudioBufferSource.playbackRate 代替现有保调播放。

验收需分开测点击到首音、供应商首帧、句间非预期静音、1×/2×/3×缓冲、停止与原位调速；实际声音质量由同文真人试听判断。本轮只核验资料与代码，未改播放功能、未调用真实云语音，也没有声称已接入或已消除卡顿。

## 较早反馈：排除 Edge 音色（后续 Readest 实听反馈见上文，2026-10-03）

用户已实际试过 Edge 并认为效果不满意，不再推荐其作为声音候选。Readest 的现行官方朗读说明明确：在线默认仍为 Edge TTS；因此换 Readest 不能保证改善该用户不喜欢的音色，上一轮推荐需要据此收回。

Readest 文字型 PDF 支持文字选区；选后 Ctrl+R 只朗读选区、读完停止。普通耳机按钮从当前段继续，公开说明未确认有“只读当前物理PDF页并自动停”的独立按钮。扫描PDF不应直接承诺可朗读，需可用文字层或额外OCR。[阅读说明](https://www.readest.com/docs/reading)、[朗读说明](https://www.readest.com/docs/listen)。

已只读核对本项目：PdfReader.selectCurrentPage 使用本页PDF文字层生成 whole-page 目标，用户点“选本页文字”再“朗读所选”即可把本页作为朗读范围（最多12000字符，超出提示分段）。拖选则只处理选区。直接正文朗读本地跳过公式，不调用GPT识别；已有语音仍须可用额度。整书正文导出/OCR流水线尚未实现，本轮仅核验，不新增代码或安装Readest。

核验日期：2026-10-03。用户选择先试听腾讯中文声音。本次仅查询官方资料；未注册账号、签署数据授权、开通后付费或调用真实语音 API。声音自然度需要用户听测，不能凭音色名称或免费额度保证与豆包一样好。

用户进一步明确：只需选中 PDF 正文后自然连续地朗读，公式可以跳过，也接受已有软件。后续选型以这个目标为准，不为了更换模型增加操作步骤。

## 已有软件如何满足这个目标

- **Edge 自带大声朗读**：官方支持 PDF 全文或选区朗读、Natural 声音及调速。它的在线自然声音不同于本项目退役的系统离线声音。可先用同一段正文做免费试听对照。未查到把 Edge 消费者朗读服务正式作为免费 API 嵌入 Electron 的授权文档。[官方功能](https://www.microsoft.com/en-us/edge/features/read-aloud)、[免费阅读工具](https://www.microsoft.com/en-us/edge/learning-center/read-with-immersive-reader)。
- **Readest**：现成阅读器支持选中文字后 Ctrl+R 朗读和句间导航。免费计划有 AI 朗读，但官网未明确免费时长数值，不能承诺无限。其公开播放器实现会缓存、提前解码和调度音频；值得借鉴这些设计，但不能把其 Edge 消费者端点当成官方开放 API。[朗读说明](https://www.readest.com/docs/listen)、[套餐](https://www.readest.com/pricing)、[播放器源码](https://github.com/readest/readest/blob/main/apps/readest-app/src/services/tts/BufferedTTSClient.ts)、[Edge 接入源码](https://github.com/readest/readest/blob/main/apps/readest-app/src/libs/edgeTTS.ts)。
- **Read Aloud 扩展**：支持 PDF，开源播放器会提前准备下一段；自然云声音可能需要付费或自备账号，不是装扩展就取得免费额度。[官方仓库](https://github.com/ken107/read-aloud)、[预取源码](https://github.com/ken107/read-aloud/blob/master/js/speech.js)。

这些是资料与源码核验，尚未在用户教材上验证选区顺序、中文听感及长段连续性。最省事的试法：用 Edge 打开同一 PDF，选一段正文，使用大声朗读，在声音选项中选择标有 Online / Natural 的中文声音，以 1× 对照豆包听感。若版本未提供选区菜单，可从工具栏开启大声朗读后选择起点。

## 短视频配音为什么看起来不卡

并非所有作者都在付费调用豆包 API。CapCut 有编辑器内免费配音及导出，部分高级音色需要 Pro；剪映官网虽列出文本朗读，但不能把海外 CapCut 的免费范围直接套给国内剪映。[CapCut 官方工具](https://www.capcut.com/tools/ai-text-to-speech)、[剪映官网](https://www.jianying.com/)。

微软 Clipchamp 个人免费版也包含文字转语音与纯音频导出，底层使用 Azure AI Speech。先输入文字生成声音，存为时间轴素材，再剪辑导出。[官方套餐对比](https://support.microsoft.com/en-us/clipchamp/feature-comparison-between-clipchamp-for-work-and-personal-versions)、[操作说明](https://support.microsoft.com/en-gb/clipchamp/how-to-use-the-text-to-speech-feature)。

基于这个工作流可以推断：观众播放的是事先完成的音轨，生成等待发生在发布前，不会出现在成片里。因此“视频没有卡顿”不能证明合成接口即时或免费。编辑器免费权益也不等于第三方应用免费 API。手动生成、导出再播放虽然可行，但会增加用户每次选段的操作，本轮不作为默认流程。

## 先试听腾讯

打开[腾讯语音合成官网](https://cloud.tencent.com/product/tts)或[合成音频控制台](https://console.cloud.tencent.com/tts)。官方[音色列表](https://cloud.tencent.com/document/product/1073/92668)说明：点击对应音频头像可试听，合成自定义文本则需控制台。优先比较专业梓欣（602005）、温柔小柠（603004），以及阅读女声智菊（501002）。

试听时先用 1×，重点听完整句的语气、逗号与句号停顿、数字和中英文混读。可以在有免费额度的控制台用同一段自制文字比较：

> 2026年，我们开始学习神经网络。每个神经元只关注图像的一小块区域，而不是整张图片。这种局部连接减少了参数量。请先理解这句话，再继续看下一段。

腾讯目前提供超自然音色 2 万字符、大模型音色 10 万字符、基础及精品音色 800 万字符，均为一次领取、3 个月有效；800 万额度不能用于所有大模型音色。需实名后在控制台领取，并检查后付费开关。较新的计费页写明免费用完停服，购买或开启后付费才继续；旧购买说明针对已开通付费版写有默认后付费，因此必须核对自己的账号状态。[计费说明](https://cloud.tencent.com/document/product/1073/34112)、[资源包管理](https://cloud.tencent.com/document/product/1073/56352)、[旧购买说明](https://cloud.tencent.com/document/product/1073/78325)。

本软件尚未接入腾讯。确认满意音色后再做 API 适配；正式 TextToVoice 单请求中文长度有限，需要适配现有分句、预取和取消机制，不能直接更换接口地址。[腾讯 API 文档](https://cloud.tencent.com/document/product/1073/37995)。

## 其他官方候选

| 服务 | 免费范围 | 适用性与限制 |
|---|---|---|
| Azure Speech F0 | 普通 Neural 语音每月 50 万字符 | 适合持续月度使用；保持 F0 资源档位，勿当成 S0 或 HD 音色免费。通常需手机号和非预付费银行卡注册；免费账号试用结束需处理订阅状态。 |
| 阿里云百炼 CosyVoice | 北京地域各模型 1 万字符、90 天 | 适合短试听；实名账号可能转按量收费，可启用“免费额度用完即停”。不是每月赠送。 |
| MiniMax | 未核实到可持续承诺的免费语音 API 额度 | 网页体验积分不等于 API 免费额度，暂不作为免费 API 推荐。 |

依据：[Azure 定价](https://azure.microsoft.com/en-ca/pricing/details/speech/)、[F0 配额](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-services-quotas-and-limits)、[Azure 免费账号说明](https://azure.microsoft.com/free/)、[CosyVoice 定价](https://help.aliyun.com/zh/model-studio/model-pricing)、[百炼免费额度及停用开关](https://help.aliyun.com/zh/model-studio/new-free-quota)、[MiniMax 定价](https://platform.minimax.cn/docs/guides/pricing-paygo)。

Azure 可以在[官方音色库](https://speech.microsoft.com/portal/voicegallery)试听 XiaoxiaoNeural、YunxiNeural 和 YunyangNeural。[官方音色能力表](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support?tabs=tts)。当前未接入 Azure，未验证本机网络与中文听感。

## 豆包数据授权奖励

用户截图显示字数包已用 20,000/20,000、剩余 0、过期时间“—”，证据支持额度耗尽，不能确定是过期。活动横幅确实说首次授权赠语音大模型额度、可抵扣后付费用量，但没有显示赠送数量、有效期或完整数据条款。

需在该活动说明中核对：是否覆盖语音合成 2.0、奖励字数及期限、一次性还是续赠、哪些输入/输出会被授权、用途与撤回条件。公开资料未找到精确对应的完整条款，不能把火山方舟 token 协作活动套用于豆包语音。打开详情阅读即可，未确认前不提交签约。

豆包新版入门说明明确免费余量耗尽后可能按后付费继续计费，有资源包则优先消耗资源包；本软件不能查询或保证余额。[官方快速入门](https://docs.volcengine.com/docs/DoubaoVoice/QuickStartNewConsole?lang=zh)。
