# 开源参考记录

本项目的浏览器执行器、桥接协议和界面为独立实现，并非 Chrome AutoGLM 闭源扩展的解包修改版，也不是下述手机项目的完整 fork。未复制已安装 AutoGLM 的商业打包代码、图标、账号或配置。

参考快照：

| 项目 | 固定提交 | 参考内容 | 许可 |
|---|---|---|---|
| https://github.com/suyiiyii/AutoGLM-GUI | e0f91cd8a29e3db979aebdb75792e404cd512380 | agents/protocols.py、api/mcp.py、agents/glm/parser.py 的任务事件、互斥、动作解析设计 | Apache-2.0；Copyright [2025] [suyiiyii] |
| https://github.com/zai-org/Open-AutoGLM | 86f55382982fb054e8fc98ca80609dff8a2cdc3c | phone_agent/agent.py、actions/handler.py、model/client.py 的观察/动作循环、动作词汇和模型端点设计 | Apache-2.0；Copyright 2025 Zhipu AI |

上游 LICENSE 原文保存在 third_party/reference-licenses/。上述许可属于各自上游，不表示上游维护者认可本项目，也不是给 AutoGLM 商标或闭源扩展重新授权。

浏览器适配变化：以 tabId 代替手机设备；以 Chrome DOM/CDP 代替 ADB/HDC；0..1000 坐标映射到网页视口；不支持 Launch/Home 等手机动作；Swipe 映射到鼠标拖动，并非手机触摸滑动；使用 JavaScript 字面量解析器，绝不执行模型返回的代码。

npm 依赖许可证保留在各自软件包中，版本锁定见 package-lock.json。分发源码包不包含 node_modules、个人浏览器数据或 .local 密钥。
