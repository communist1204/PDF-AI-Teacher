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

## 0.2.1 品牌与清理复验
- npm run icons、typecheck、lint、test、test:e2e、desktop:package 实际通过；83 项单测、5 项界面测试，数量未改变。
- SCREEN_READER_TEST_EXE 指向 release/QingRead-win32-x64/QingRead.exe，桌面验收通过：真实屏幕裁剪/Windows OCR、Esc 取消、静音 WAV 播放、暂停续读、3× 原位调速、加密设置重启保留。未调用真实语音接口。
- 实际查看新 logo 和 docs/screenshots 下工具条、设置、识字预览，均为浅蓝色，文字可辨，无控件遮挡。
- 品牌批量替换初次误改部分字符，类型检查立即发现；从修改前版本恢复受影响文件并逐项准确替换，随后类型、lint 和构建通过。
- 首次桌面复验未截到自制文稿，等待年份识别超时。测试使用全屏文稿时，点击工具条会改变前台窗口；改为普通置顶文稿、通过真实按钮事件触发而不切换前台，未降低识字断言，复验通过。失败截图只在忽略的 test-results 本机目录中，不上传。
- 旧功能审查：没有旧 PDF/板书/账号登录、本地模型代码或依赖。代码中的 PDF-AI-Teacher 字样仅为旧设置迁移；GitHub 仓库名、恢复文档和历史由用户明确保留。

## 新路径复验
项目实际路径 D:\QingRead。移动后再次执行 desktop:build 与打包程序 test:desktop，均通过；packaged-verification.json 记录本次结果。两个快捷方式的 TargetPath 和 IconLocation 已读回核验。旧目录子项数为 0，删除空目录受当前会话占用阻挡；没有停止 Codex 或其他用户进程。

正常用户配置下已从新路径启动，主窗口“轻读 · 截图朗读”响应正常；未自动截图或请求云语音。


## 0.3.0 微软翻译朗读
- 实际执行typecheck、lint、99项单测（7文件）、build、8项e2e、desktop:package及打包版test:desktop，通过。
- 模拟测试覆盖匿名页面会话共享/过期、XML转义、动态IID、音频大小/MP3检查、限流不重试、取消超时、逐跳域名守卫、旧配置兼容和独立微软授权。
- UI测试覆盖无需Key但需独立允许、首次切来源保存试听、保存期间停止阻止迟到开声，以及调速/截图/文本朗读的保存互斥。
- node scripts/verify-bing.mjs --live使用隔离无Key配置和自制34字短句。打包程序真实按钮贯穿ReaderAudio和微软服务，约878ms开始播放、9.18秒MP3；静音HTMLAudio解码、暂停续读和2×原位调速通过。记录docs/bing-verification.json。
- 实际查看bing-settings.png与bing-playing.png，新声音来源、许可与音色清楚；仍为浅蓝色。
- 首轮桌面验证脚本重载时窗口关闭，改为真实设置控件操作；浏览器对象声明的lint错误已修复。
- 首轮匿名请求未保留地区来源/会话，返回空HTTP200；Electron manual跳转取消，之后采用逐跳守卫及本机实际cn入口成功。失败均未假报成功，POST禁跳转保护保留。
- 审查发现设置/试听竞态，已用保存互斥与独立试听意图标识修复并补测试。
- 未调用豆包付费接口，未发送用户截图/PDF，未完成人工音质评估、数小时长文或所有网络环境测试。上述延迟仅一条样本。

## 0.4.0 回听与截图验收
- typecheck、lint、105 项单测（7 文件）、9 项 e2e、build、desktop:package 通过；test:desktop 在开发与打包程序均通过。
- 单测覆盖完成后回听不重复合成、乱序结果下快速连续跳转、两个旧请求占满时等待目标段、旧 ended/play reject、暂停后回听保留倍速、beginSpeech 未完成时导航，以及导航等待中停止。
- e2e 验证完成后按钮仍可回听、边界按钮禁用、前后往返请求数不变；原设置、云许可与取消测试保留。
- 实际桌面自制文稿两次截图分别识别到 2026 与更新后的 2031，窗口 ID 保持不变；每次 show 都检查图片已解码、ready 为 true；Esc 后窗口隐藏且图片 src 被移除。
- 打包版三次从按钮触发到选区就绪为 645 / 591 / 575ms（含测试调度，仅本机样本，不是普遍延迟保证）。详见 packaged-verification.json。未采集完整视频帧，也未实测多显示器热插拔或所有显卡驱动环境。
- 实际 HTMLAudio 播放自制静音 WAV，上一段/下一段/重听不新增合成请求；暂停续读与 3× 原位调速通过。实际查看 replay-toolbar.png、设置页和选区截图，按钮文字清晰，仍为浅蓝色。
- 本轮未调用真实 Bing/豆包接口，未做真人音质评价；验证的是截图与播放控制。既有语音适配器未改变。
- 首轮批量编辑脚本语法错误，未写入任何文件；修正脚本后编译、测试通过。PRD 完成标准未变更。
