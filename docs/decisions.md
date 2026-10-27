# 决策 · 2026-10-27

1. 先备份后重建：远程 SHA 已与本地核对，master 与恢复标签不改；新分支 codex/screen-reader。
2. Electron 本地页面＋有限 IPC，取消 Express/本机端口和网页启动顺序。未修改全局代理、Conda、CUDA 或其他项目。
3. 首版仅保留用户认可的豆包 2.0，不重新堆放用户否定的本地声音。沿用官方 HTTP 适配器：openspeech.bytedance.com/api/v3/tts/unidirectional，X-Api-Key，seed-tts-2.0，PCM/WAV 24kHz。官方参考 https://docs.volcengine.com/docs/DoubaoVoice/unidirectional-streaming-text-to-speech-http?lang=zh 。本次抓取超时，沿用原已核验实现并模拟协议测试，不宣称新的真实接口验证。
4. 本机 OCR 快读正文，断行合并、年份处理、跳明显公式；图片语义/复杂公式理解暂未实现。
5. 固定合成原速，播放器原位变速；短首块和有限预取。实际首音/连续性仍需用户网络试听，不能保证零等待。
6. 仅主动允许云朗读后发送框选识别文字；截图不发云、不默认落盘。旧凭证只在主进程迁移豆包字段，旧文件保持原样。
7. 删除旧测试因对应功能已明确废弃，不是掩盖失败。截图/豆包协议保留，并添加新播放器、设置、会话与界面测试。
