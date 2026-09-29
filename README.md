# PDF AI Teacher

本机运行的中文 PDF 学习工作台，当前交付 M0/M1 基础版。支持真实 PDF.js 阅读与选区、公式区域预览、结构化教案黑板、文字问答、所选原文朗读和句级续读。语音提问与实时插话属于后续 M2/M3。

## 启动

需要 Node.js 22.13+（本机验证版本 24.19.0）。在本项目 PowerShell 终端执行：

```powershell
npm.cmd ci
npm.cmd run dev
```

**先启动服务，再打开网页；使用期间请保持启动终端运行。** 关闭终端或重启电脑后，需要重新执行上面的启动命令。打开 http://127.0.0.1:4317 。用「示例」打开项目自制中文 PDF，或选择/拖入自己的文件。终端 Ctrl+C 停止本项目服务。Windows 执行策略限制 npm.ps1 时使用 npm.cmd，无需更改系统策略。

未创建 .env 时默认明确演示模式：本地 PDF、选区、板书可验证；示例教案不是模型回答。演示朗读使用浏览器提供的本机中文合成声音，缺少本机中文语音时会说明原因。它不代表 OpenAI TTS 或 Realtime 已接通。

## 本机配置 API

```powershell
Copy-Item .env.example .env
```

只在本机编辑 .env，填写自己的 OPENAI_API_KEY，以及账号实际可用的 CHAT_MODEL、VISION_MODEL、TTS_MODEL。设置 DEMO_MODE=false 并重启服务。不要把 Key 发到聊天、放进前端变量或提交 Git。

模型名不预填为“已验证”默认值；.env.example 提供字段说明；模型请依据官方模型目录与自己账号的权限选择。配置后状态仍为“待验”，不能据此认定账号具有权限。真实请求由你点击触发，可能产生独立于 ChatGPT 订阅的 API 费用；本轮未调用付费接口。首次只测试短选区、一张局部截图和一句朗读。

## 使用

1. 选择 PDF 文字，检查左下原文预览；公式/图片可切换框选模式，先查看局部截图。
2. 点击「讲解这里」或输入问题。发送预览说明当前会离开本机的数据；默认不会上传整书。
3. 黑板可查看步骤、复制 LaTeX、回到原文、选步骤追问。演示固定样例会显著注明。
4. 「朗读所选」直接使用确认的原文，不用模型改写。复杂公式先核对。暂停同一声音可原位继续；停止或提问后从未完成句句首恢复。
5. 翻页不会替换已锁定的讲解；新选区/新文档取消旧任务。手动点击「继续朗读」才恢复原文。
6. 本书笔记只保存在当前浏览器 localStorage，按文件内容指纹区分；不发送给模型。会话、教案与阅读书签本轮仅内存保存，刷新后清空。

扫描 PDF 可显示并框选，但没有可靠转写不能逐字朗读。复杂双栏和数学抽取需对照原页。M1 使用当前单页渲染、按页提取，不在后台索引全书。

## 检查与生产构建

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd test
npm.cmd run build
npm.cmd run test:e2e
npm.cmd start
```

E2E 使用本机 Microsoft Edge，由测试启动演示服务。运行前停止端口 4317 上本项目的 dev 服务；测试不会自动杀其他进程。测试截图在 docs/screenshots；HTML 报告在 playwright-report。

`npm.cmd start` 提供已构建 dist，仍需要项目局部 tsx 和后端源码。前后端同一回环端口。若端口已占用，停止你刚启动的本项目实例或在 .env 指定 APP_PORT。

## 验收边界

详见 [验收记录](docs/verification.md)、[设计取舍](docs/decisions.md)、[阶段进度](docs/progress.md)。

真实模型文字/视觉/TTS、真人听感、麦克风和实时打断未测。不能将浏览器音频 mock、演示教案或构建成功当作真实 AI/真人音频通过。
