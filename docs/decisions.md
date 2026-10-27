# 决策 · 2026-10-27

1. 先备份后重建：远程 SHA 已与本地核对，master 与恢复标签不改；新分支 codex/screen-reader。
2. Electron 本地页面＋有限 IPC，取消 Express/本机端口和网页启动顺序。未修改全局代理、Conda、CUDA 或其他项目。
3. 首版仅保留用户认可的豆包 2.0，不重新堆放用户否定的本地声音。沿用官方 HTTP 适配器：openspeech.bytedance.com/api/v3/tts/unidirectional，X-Api-Key，seed-tts-2.0，PCM/WAV 24kHz。官方参考 https://docs.volcengine.com/docs/DoubaoVoice/unidirectional-streaming-text-to-speech-http?lang=zh 。本次抓取超时，沿用原已核验实现并模拟协议测试，不宣称新的真实接口验证。
4. 本机 OCR 快读正文，断行合并、年份处理、跳明显公式；图片语义/复杂公式理解暂未实现。
5. 固定合成原速，播放器原位变速；短首块和有限预取。实际首音/连续性仍需用户网络试听，不能保证零等待。
6. 仅主动允许云朗读后发送框选识别文字；截图不发云、不默认落盘。旧凭证只在主进程迁移豆包字段，旧文件保持原样。
7. 删除旧测试因对应功能已明确废弃，不是掩盖失败。截图/豆包协议保留，并添加新播放器、设置、会话与界面测试。
8. 2026-10-27 统一品牌为轻读 / QingRead 0.2.1，使用自绘 SVG 浅蓝图标与配套界面。PNG/多尺寸 ICO 由项目脚本重建，不引入外部图片版权或远程依赖。用户明确只改本地文件夹和软件名，GitHub 仓库名称不改。
9. 品牌与存储分开：Windows 应用标识与 EXE 改为 QingRead，%APPDATA%/ScreenReader 保持不变；PDF-AI-Teacher 旧 vault 迁移入口保留，不读取或展示用户真实 Key。保留 .gitignore 中旧运行时目录保护，避免未来误上传私有缓存；这不代表保留旧引擎。
10. Edge PDF 翻译面板发声与整页“朗读”不可混为一谈。官方 PDF 功能介绍未提供该面板扬声器的开发接口或准确 voice ID；无法保证第三方接入同一声音。参考：https://explore.microsoft.com/en-us/edge/features/pdf-reader?form=MT0160 。Translator Text V3 不包含 TTS，官方建议使用 Speech：https://learn.microsoft.com/en-us/azure/ai-services/translator/text-translation/how-to/migrate-to-v3 。
11. 正式微软接入可使用 Azure Speech REST/SDK：https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech 。官方定价 F0 普通 Neural TTS 每月 50 万字符免费，不等于无限、不覆盖所有语音模型：https://azure.microsoft.com/en-us/pricing/details/speech/ 。需要自己的 Azure 资源/凭证，注册条件和支付验证以 https://azure.microsoft.com/en-us/pricing/purchase-options/azure-account 为准。当前没有接入，不声称已试听或与 Edge 音色相同。
12. 社区 edge-tts 为非微软官方客户端；开源代码不构成服务免费额度、稳定性或支持承诺，不作为“官方免费接口”悄悄接入。其 README 也记录自定义 SSML 受上游限制：https://github.com/rany2/edge-tts 。


13. 0.3.0通过本机Edge资源和当前Bing网页确认PDF翻译小喇叭来源，选用其晓晓和-20%基础语速，而非Edge整页Read Aloud。详见edge-translation-research.md。
14. Bing作为实验选项，保留豆包；无需用户Key，只用匿名非持久化分区建立网页会话，不读取浏览器登录资料，不声称官方开发API支持或无限免费。
15. 微软和豆包分别授权；旧设置缺少新字段时仍为doubao且allowBingCloud=false。MP3使用正确MIME并沿用单播放器，调速无需重新生成。
16. Electron Session.fetch的manual地区跳转会取消；参照https://www.electronjs.org/docs/latest/api/client-request 和 https://www.electronjs.org/docs/latest/api/net/核验。GET逐跳域名/路径守卫、POST禁止重定向，使用当前本机实际cn.bing.com入口。失败不会转向收费声音。
17. 设置保存互斥，试听绑定独立用户意图；停止/新任务使旧试听失效，保存自身取消不会误杀新试听。原PRD验收标准保持不变。

## 0.4.0 回听和截图展示
- 使用“段”作为导航单位，与已有 TTS 合成块一致。没有准确句级时间戳时不伪称逐句定位，不为导航把所有句子拆成独立云请求。
- 完成的音频 URL 保留到本次朗读结束后的主动停止/替换；128 MiB 总量约束。暂停后的导航属于用户明确播放操作，从目标段开头播放。position 与 playAttempt 分别阻挡迟到段落和旧 play Promise，generation/epoch 继续保护跨任务响应。请求仍最多同时 2 个，只预取当前位置后 2 段。
- 截图黑屏原因：旧窗口深色底、40% 黑遮罩、loadFile 结束不代表异步截图已经解码。采用隐藏空窗口预热/复用、带 frameId 的图片完成信号，decode 后两帧绘制再展示；固定隐藏等待由 180ms 改成 60ms，经真实桌面 OCR 验证。
- 预热不捕获屏幕。选区完成或取消时隐藏窗口并清掉原图、NativeImage 和拖选状态；保留的仅是空窗口。显示器窗口并行加载并等待全部 settle，避免部分失败导致重试向未就绪页面发图。
- 依据 Electron 官方窗口展示与捕获文档：https://www.electronjs.org/docs/latest/api/browser-window 、https://www.electronjs.org/docs/latest/api/desktop-capturer 。快捷键不再先显示再隐藏主工具条，裁剪复用 PNG 编码结果。

## 0.5.0 图片先整理、语音后播放
- Windows OCR 只输出行文本并丢失空间关系；本轮按用户新要求增加可选视觉适配器，原第一版边界与既有验收标准不改。
- 固定使用 OpenAI Responses API https://api.openai.com/v1/responses，gpt-5.4-mini，reasoning.effort=none，PNG input_image/detail=high，text.format=json_schema/strict，store=false，max_output_tokens=6000。不启用工具、不传聊天历史、不基于错误 OCR 进行猜测。store=false 不代表服务端零保留承诺。
- 官方文档已实际查阅：https://developers.openai.com/api/docs/models/gpt-5.4-mini （支持图片输入、结构化输出及 none）；https://developers.openai.com/api/docs/guides/images-vision ；https://developers.openai.com/api/docs/guides/structured-outputs 。模型账户权限及真实速度仍待测。
- 截图先分类为 prose/table/image/formula；表格以数组保留对应关系，本地限制行列数并拒绝长度错位，按行渲染朗读稿。模型报告模糊字形时要求人工核对，禁止以完整成功名义读半份或错误结构。
- 图片中的文字是数据，不改变任务，不执行生成内容。截图只使用主进程保存的本次 crop ID；新增独立图片许可与主进程 Key，不复用语音许可，不读取 ChatGPT/Edge 登录。切换模式、撤销图片许可、更换 Key、停止和新截图均取消旧识图。
- 请求 45 秒超时、响应 1 MiB 限制；拒绝重定向，错误脱敏，不自动重试、不偷偷退回本机 OCR。免费本机路径仍可单独使用。
- 域名过滤采用保守规则：仅独占一行或句末来源标记。ASCII 句末必须有空白，避免误把 www.arxiv.org 中的点当句号；不一律删除字母或无空格中文后文。
