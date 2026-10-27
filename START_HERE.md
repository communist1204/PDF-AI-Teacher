# 从这里开始

现在构建“轻读 / QingRead”：框选屏幕 → ChatGPT 智能整理 → 当前声音朗读；本机 OCR 为手动备用。先读 AGENTS.md 和 PRD.md。

旧版私有备份：https://github.com/communist1204/PDF-AI-Teacher ，master 与 archive/pdf-ai-teacher-2026-10-27 标签；原提交 03e359b70021cba2e32a5be56d6a0aa702245eb6，已读回远程核验。新分支 codex/screen-reader。不要恢复旧教学/本地模型范围。

开发：npm install；npm start（编译并打开桌面）。打包：npm run desktop:package。
检查：npm run typecheck、npm run lint、npm test、npm run test:e2e、npm run test:desktop。
npm run dev 仅界面预览，没有桌面截图/真实语音桥接。

Key 在桌面设置填写并由 Windows 加密，不发到聊天、不提交 Git、不放前端变量。设置保存不产生调用；首次允许云朗读后，主动截图识别的文字才发火山引擎。

本机项目路径已改为 D:\QingRead。开发时请打开这个目录；GitHub 按用户选择保留原仓库名。软件显示名为轻读 / QingRead。


0.3.0已增加Bing翻译朗读（晓晓），来源见docs/edge-translation-research.md。独立微软许可默认关闭；豆包配置保留。真实网络验收显式运行node scripts/verify-bing.mjs --live，仅发送自制短句；普通单测/e2e不调用云语音。

0.4.0 新增上一段/重听本段/下一段，读完可用内存音频回听。截图窗口仅预热空界面，主动捕获并解码完成后显示；验收见 docs/verification.md。

0.5.0 增加可选 GPT 智能看图（gpt-5.4-mini/Responses/none），图片许可默认关闭，OpenAI Key 只在本机设置里填写。看图与语音费用分别计算，保存设置不发起看图请求。没有真实付费 API 验收授权时只运行本地与模拟测试。

0.6.0：按最新用户要求，每张截图默认走 ChatGPT 智能整理，通过本应用独立的官方 Sign in with ChatGPT 授权使用订阅额度，不读取其他应用登录。账号凭证在主进程独立加密；API Key 路径保留高级手动选项，绝不自动收费回退。首次需登录、允许图片发送并保存；旧语音设置保留。详见 README 与 docs/verification.md。
