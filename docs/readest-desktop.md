# Readest 桌面版与源码

2026-10-03：用户已试听网页版并反馈“效果还不错”，本次把官方桌面版和对应源码下载到本机，供独立使用及后续适配。

## 启动

- 桌面双击 **Readest 听书**。
- 项目内备用快捷方式：`D:\PDF-AI-Teacher\Readest 听书.lnk`。
- 官方免安装程序：`D:\PDF-AI-Teacher\release\Readest\Readest_0.12.10_x64-portable.exe`。
- 已带原创 `docs/readest-audition.txt` 启动，进程窗口标题为 `Readest - readest-audition`，且响应正常。窗口内实际排版、播放、声音列表仍待用户验收。

在书库添加自己的 PDF。选中文字后按 Ctrl+R 仅读选区；点底部耳机从当前段继续读。展开播放器可选择音色与调整语速。桌面声音仍需联网，不是下载到了离线语音模型。未修改 PDF AI Teacher 的声音设置或凭证。

## 版本与来源

- [官方仓库](https://github.com/readest/readest)
- [官方 v0.12.10 发布](https://github.com/readest/readest/releases/tag/v0.12.10)，发布时间 2026-09-21；这是本次 releases/latest 返回的稳定版本。官网 Web/main 可能更新，不承诺全部最新修复相同。
- 可读源码：`D:\PDF-AI-Teacher\.external\source\readest-0.12.10`。
- 已下载标签对应源码 ZIP，并按固定 revision 补齐 8 个直接子模块与嵌套 OpenCC。下载的是源码快照，不包含 Git 全历史、npm/Rust 依赖缓存或私有云服务。
- 原始 LICENSE 与作者信息保留。仓库采用 AGPL-3.0-or-later；后续修改与分发应按该许可证处理，不能把上游代码标成原创。
- 程序下载大小、官方 SHA-256 比对与子模块记录见 `readest-download.json`；源码版本见 `readest-source.json`；本机启动证据见 `readest-launch.json`。

## 与 PDF AI Teacher 的关系

目前是独立桌面阅读器，还没有合并原工作台的问答、板书、ChatGPT 账号或笔记。源工程使用 Next.js/React + Tauri，现有工作台使用 Vite/React + Electron。完整融合需要适配 PDF 选区与页码、TeachingPlan、独立问答任务和统一音频控制，不能把项目文件直接覆盖进去。

若决定以 Readest 为阅读底座，优先在其界面中加入教学侧栏、复用现有本地教学后端，同时对选区快照、引用定位及音频所有权编写验收。下载源码不会自动免除在线语音、云同步等服务的账号/额度条件，也不代表本项目已接入 Readest 的语音。

## 验证边界

官方 portable 文件 SHA-256 一致；本机进程和窗口标题验证成功。Windows Authenticode 检查为 NotSigned，未改变系统执行策略、WebView2、安全设置或代理。没有遇到并操作系统安全放行界面。

本轮电脑 UI 工具仍在初始化时失败，不能声称已目视检查桌面界面或听到桌面音频。未运行 Readest 源码构建：本机未检出 Cargo/Rust，未为此安装全局工具。当前运行的是官方预编译程序，不是自编译修改版。未发起付费语音请求。
