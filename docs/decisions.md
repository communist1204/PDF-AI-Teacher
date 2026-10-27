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
