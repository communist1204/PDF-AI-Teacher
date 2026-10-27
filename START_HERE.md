# 从这里开始

现在构建“轻读 / QingRead”：框选屏幕 → 本机 OCR → 豆包朗读。先读 AGENTS.md 和 PRD.md。

旧版私有备份：https://github.com/communist1204/PDF-AI-Teacher ，master 与 archive/pdf-ai-teacher-2026-10-27 标签；原提交 03e359b70021cba2e32a5be56d6a0aa702245eb6，已读回远程核验。新分支 codex/screen-reader。不要恢复旧教学/本地模型范围。

开发：npm install；npm start（编译并打开桌面）。打包：npm run desktop:package。
检查：npm run typecheck、npm run lint、npm test、npm run test:e2e、npm run test:desktop。
npm run dev 仅界面预览，没有桌面截图/真实语音桥接。

Key 在桌面设置填写并由 Windows 加密，不发到聊天、不提交 Git、不放前端变量。设置保存不产生调用；首次允许云朗读后，主动截图识别的文字才发火山引擎。

本机项目路径已改为 D:\QingRead。开发时请打开这个目录；GitHub 按用户选择保留原仓库名。软件显示名为轻读 / QingRead。
