# Edge PDF 翻译朗读来源核验 · 2026-10-27

只读检查本机 Edge 156.0.4314.42 的公开安装文件：
C:/Program Files (x86)/Microsoft/Edge/Application/156.0.4314.42/resources.pak。

资源73161的SidePaneTranslate嵌入Bing Translator，入口
https://www.bing.com/translator?edgepdftranslator=1&from=auto-detect&FORM=TTVEPT
（另有FORM=TRAEDG）。允许www.bing.com和cn.bing.com来源，通过TranslateText消息发送选文。整页Read Aloud属于另一组资源。未找到可复制的TTS模型包；未读取用户配置/登录Cookie/令牌，也未修改Edge文件。

当前匿名公开网页核验：中文为zh-CN-XiaoxiaoNeural（晓晓），基础合成语速-20.00%，请求/tfettts返回MP3。本机实际进入cn.bing.com，因此使用这一入口避免地区跳转和会话来源错配。
一手脚本（可能随网页升级变化）：
- 音色：https://www.bing.com/rp/88_UHvGpXKIru_N19lt3PMQWZ3g.br.js
- 请求：https://www.bing.com/rp/wksCke4Kq1nl38jfbYEd96Z3zo4.br.js
- 按钮：https://www.bing.com/rp/BLDQ9IsPws31vKOA9sRCQXO6Bag.br.js

只自行实现必要的匿名网页协议，不复制微软JS，不提取安装包签名凭证。开源交叉参考：
https://github.com/d4n3436/GTranslate/blob/master/src/GTranslate/Translators/BingTranslator.cs （MIT；未引入依赖或复制实现）。

接入边界：
- 独立非持久化Electron分区，其Cookie只来自本次匿名请求；不导入用户Edge账号。
- 会话参数只存内存；JSON/限定正则解析，不执行远程代码，不记录正文或会话值。
- 仅HTTPS www/cn.bing.com的/translator与/tfettts；GET每跳受域名/路径守卫，合成POST禁止跳转。
- 中文固定晓晓和面板-20%基础语速，播放器0.25–3×原位调速；1×相对于这份基础声音。
- 截图本机识字。微软与豆包分别允许，仅主动朗读/试听才发送文字，豆包Key不发给微软。
- 单段最多3000字，应用实际分块更小；30秒超时，响应大小/MP3校验，取消与单音源、有界预取。
- 拒绝、限流、空音频或页面变化即停止，不绕过验证码，不自动反复重试，也不暗中切换付费声音。
- 这是消费者网页服务实验接入，不是官方Azure API；无需用户Key，不承诺长期/无限免费、服务保证或固定延迟。
- 已核对当前服务/音色/基础语速；没有对用户设备声音做波形比对，不保证每次听感完全相同。

实际验证：
最初匿名POST没保留同一会话与来源，HTTP200空内容未当成功；正确维护临时匿名会话后得到38,016字节MP3。
Electron manual地区跳转被取消；采用受限GET跳转并直接进入本机实际cn页面后成功。
打包软件真实文字按钮→正文清理→ReaderAudio→IPC→Bing→HTMLAudio：34字自制短句约878ms开始播放，音频9.18秒；暂停/续读/2×保持位置通过。详见bing-verification.json。样本不能代表长期性能。
测试没有发送用户屏幕/PDF，没有调用付费账户；自动验收静音播放，主观音质和长文连续性待用户试听。
