# 轻读 / QingRead · 截图朗读

小型 Windows 悬浮工具：框选屏幕 → ChatGPT 看图整理朗读稿 → 当前 Bing 或豆包声音朗读。暂停/继续、上一段/重听/下一段、0.25–3× 原位调速。复杂公式默认跳过。

## 开始使用
1. 双击桌面“轻读”，或项目内 release/QingRead-win32-x64/QingRead.exe。
2. 打开设置，默认“ChatGPT 智能看图 · 使用订阅额度”，点击 Continue with ChatGPT，在系统浏览器完成官方登录和订阅用量授权。账号可用模型从服务器返回的目录选择，不要求 API Key。
3. 勾选“允许将我主动框选的图片发送至 OpenAI 整理朗读稿”，点击“保存识别设置”。保留原来的声音来源和文字发送许可；新用户需另选声音并授权。
4. 点“截图朗读”或 Ctrl+Shift+R，框选想听的区域。Esc 取消。表格按行组织，正文尽量忠实保留，跳过来源徽标和图中零散标注；不确定内容先提示核对。

ChatGPT 登录使用已授权的订阅额度，有用量上限，并非无限免费。设置提供官方用量页入口；请在官方设置中关闭超额使用付费余额。轻读不自动切换付费 API。订阅登录不等于获得 OpenAI TTS 权限，声音仍使用所选服务。

## 朗读与备用方式
- 每张截图走同一智能整理流程，不先用本地规则猜是否需要 GPT。
- 同一截图、账号、模型和公式选项的成功结果最多缓存 4 份，仅在内存。回听、前后移动和调速复用已经准备的内容；新段落的声音可能仍需联网。
- 选“本机快速识字 · 免费备用”可只用 Windows OCR，不发送图片；复杂表格和插图顺序可能不正确。不会在 GPT 失败后静默降级。
- 高级选项保留独立付费 OpenAI API，需自己配置 API Key；不能抵扣 ChatGPT 订阅。
- Bing 翻译朗读使用晓晓，无需 Key，属于实验接入，可能限流或变化。豆包使用本机已保存的 Key，受账号权限和额度限制。

## 数据与验证
只处理主动框选区域，不后台录屏。图片、识别文字和音频不写入历史记录；登录凭证由本应用独立管理并使用 Windows 加密，不读取 ChatGPT、Codex 或浏览器的登录资料。保存设置不请求识图或语音。

0.6.0 已完成模拟认证、识图数据流和桌面流程验收；真实账号授权、真实 GPT 看图准确率与首音等待尚待用户登录后验收。模型可能识别错误，不能保证零等待。

## 开发
npm install 后 npm start 编译并打开桌面。
npm run typecheck / npm run lint / npm test / npm run test:e2e / npm run desktop:package / npm run test:desktop。
npm run test:e2e 会先构建，避免测到旧界面。npm run dev 仅开发预览。

项目位于 D:\QingRead。图标源文件 assets/qingread.svg；npm run icons 可重建 Windows 图标。
旧 PDF-AI-Teacher 保留在同仓库 master 与 archive/pdf-ai-teacher-2026-10-27 标签；不恢复原教学产品。
