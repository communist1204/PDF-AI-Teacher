# 验收 · 2026-10-27

## 备份和范围
git ls-remote origin refs/heads/master 与原本地 HEAD 均为 03e359b70021cba2e32a5be56d6a0aa702245eb6。恢复标签 archive/pdf-ai-teacher-2026-10-27 推送成功。只上传跟踪源码/自制测试资料，未上传个人设置、模型、运行时。旧版 961 项测试不计入新版验收。

## 环境
Windows；Node 24.19.0，npm 11.17.0，Git 2.56.0.windows.3。仅项目局部依赖；没有修改其他科研仓库、Conda/CUDA、全局代理或训练进程。

## 实际执行
| 检查 | 结果 |
| --- | --- |
| npm run typecheck | 通过 |
| npm run lint | 通过 |
| npm test | 6 个文件，83 项通过 |
| npm run desktop:build | 类型检查、Vite 前端和 Electron 主进程构建通过 |
| npm run test:e2e | 5 项通过，Edge 无头浏览器，生产构建页面 |
| npm run desktop:package | Windows x64 产物生成成功 |
| npm run test:desktop | 开发桌面通过 |
| SCREEN_READER_TEST_EXE 指向打包 exe 后 npm run test:desktop | 打包桌面通过，含 asar 解包 OCR 脚本 |
| 实际 UI | 已查看工具条、设置、识字预览截图，文字可读、无布局溢出遮挡；设置可滚动 |

## 验证内容与证据
- 本机真实桌面框选自制中文/英文文稿，Windows OCR 读出“这是我们自己编写的测试文字”和 2026 年。Esc 取消框选，窗口恢复。
- 隔离测试配置，启动无真实 Key、云许可关闭，不读取用户旧凭证。
- 对真实 HTMLAudio 播放本地生成的静音 WAV：暂停、继续、3× 即时变速保持原位置，停止生效。合成接口被测试替身替换，不是豆包真实试听。
- 原位变速不发起重新合成，预取最多两个请求；暂停未完成 play Promise 不误报失败；取消后迟到结果不启动声音；撤销云许可停止本地声音；保存设置不把新速率覆盖为旧值。
- 旧凭证迁移、坏配置保护、并行写入和密钥不回传使用模拟加密器测试。实际 Windows 加密设置已在桌面重启后读回。
- docs/desktop-verification.json 与 docs/packaged-verification.json 为执行记录。
- docs/screenshots/toolbar.png、settings.png、recognized-text.png 为实际桌面截图，仅含自制测试资料和空 Key 状态。

## 本轮失败及修复
- 受限进程临时目录 rename/测试缓存出现 EPERM/ENOENT：未改测试期望，在允许正常访问临时目录的进程执行同一测试后通过。
- 第一轮界面测试 2 项失败：无效模拟音频触发真实解码错误；文字框定位器同时匹配按钮。改为有效静音 WAV 和精确文字框定位后 5/5 通过。
- 首轮桌面脚本未明确聚焦自制文稿，未抓到期望年份；聚焦文稿后真实 OCR 成功。Esc 会销毁截图窗口，使测试 keyup 报窗口关闭；脚本改为仅容忍已确认关闭的截图窗口，并断言“已取消截图”。
- 新验收脚本的浏览器全局类型导致 2 项 lint 错误，已改为 window.HTMLMediaElement；最终 lint 通过。

## 明确未测/未实现
未调用真实付费语音 API；未试听真人音质、当前账号额度、真实首音延迟或长文网络连续性。不能保证零卡顿或比其他服务更自然。普通本机 OCR 不理解图片，复杂公式/版面、多音字和专业缩写存在局限。当前只有豆包一个云声音来源。

## 交付核验
新版 codex/screen-reader 分支的实现提交 fe035a43d8476a363898e15fc79230131baa5ce8 已推送并通过 ls-remote 核验。Git 直连曾连接重置，之后仅本次命令使用系统已启用的代理完成上传，未修改全局代理。正常启动后主窗口为“轻读 · 截图朗读”，进程响应正常；没有自动截图或付费请求。
