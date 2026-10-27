# 轻读 / QingRead · 截图朗读

小型 Windows 悬浮工具：框选屏幕 → 本机识字 → 微软 Bing 或豆包声音朗读。暂停/继续、原位调速 0.25–3×，详细选项放在设置中。

## 使用
双击桌面“轻读”快捷方式，或运行项目内 release/QingRead-win32-x64/QingRead.exe。打开设置，可选择「Bing 翻译朗读 · 无需 Key（实验）」，勾选微软联网朗读许可，点「保存并试听」。也可以继续使用原豆包配置。之后点“截图朗读”。快捷键 Ctrl+Shift+R；框选时 Esc 取消。

朗读后可用第二行的“上一段 / 重听本段 / 下一段”反复听，不必重新截图。读完仍保留本次声音；停止或开始新朗读会清除缓存。未生成的段落仍需联网准备。

已有旧软件豆包配置会尝试在本机迁移，不显示密钥。保存设置不消耗额度。云朗读发送识别文字且可能计费，以火山引擎账户为准。

## 开发
npm install 后 npm start 即可编译打开桌面。
npm run typecheck / npm run lint / npm test / npm run test:e2e / npm run desktop:package / npm run test:desktop。
npm run dev 仅开发界面预览。

浅蓝色图标源文件为 assets/qingread.svg；npm run icons 可重建 PNG 和多尺寸 Windows ICO。

正文识字不需要大模型；明显公式可跳过。复杂排版、专业缩写、多音字可能出错。图片语义描述/智能公式讲解未实现。真实音质和首音延迟需用户试听。

旧 PDF-AI-Teacher 保留在同仓库 master 与 archive/pdf-ai-teacher-2026-10-27 标签。详情见 PRD.md 和 docs。

Bing选项为当前Edge PDF翻译面板的中文晓晓音色。无需Key，但网页服务可能限流或变化，不保证长期无限免费。图片只在本机识字，主动朗读的文字发往你选择的服务。
