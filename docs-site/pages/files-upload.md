# 文件与上传
> 工作区白名单、三层路径闸、附件与预览。

- **Part**: 第四部分 · 核心实现
- **Reading Time**: ~10 min
- **Estimated Tokens**: ~1102

---

文件能力围绕「白名单工作区隔离」与「只读越界防护」构建：上传附件为会话注入上下文，文件浏览、文件搜索与预览严禁逃逸出白名单目录之外。

## 工作区白名单 (WORKDIRS) 与热重载

- 默认工作区： 以 WORK_DIR 为准（未配置时默认取当前工作根目录）。
- 多项目白名单： 通过 ccm.config.json 中的 WORKDIRS 数组进行管理。
- 免重启热重载 (Hot Reload)： 服务端深度监听配置文件变更（带防抖与 mtime 核验）。添加或移除工作区改完即生效，免重启 Server。
- 存量会话保护： 已从白名单移除的工作区，其 正在运行的旧会话继续保持执行 ；但 禁止新开会话 （由 ensureWhitelisted 闸门拦截）。

## 附件上传与存储搬迁

> **TIP:** 附件已搬出用户项目根目录 — 早期版本附件落在每个项目下的 .ccm-uploads/，不仅污染用户 Git 状态，还可能触发 CLI 审批。现已全面搬迁至受管数据目录 data/uploads/ /，并自动通过 --add-dir 注入给 CLI，旧目录仅保留只读兼容。

1. 移动端通过 Socket 传输附件原始二进制数据（严格校验 MIME 类型与单文件尺寸限制）。
2. 服务端落盘至 $CCM_DATA_DIR/uploads/<sessionId>/<safeName> 。
3. 通过 buildPromptText 将附件真实绝对路径拼装入 Prompt，CLI 即可通过原生 Read 工具直接解析图片与文档。
4. CLI 启动时自动快照挂载 data/uploads 授权目录，彻底消灭用户上传图片时弹出的权限审批。

## 三层路径防护闸门 (FILES-1)

| 防御层级 | 核心模块 | 防御威胁与防护策略 |
| --- | --- | --- |
| 写安全闸 | app/src/files/file-security.js | 仅所有者读写（0600）、强制防御符号链接（Symlink 劫持检测）与原子化写入辅助 |
| 工作区范围门 | app/src/files/workdir-scope-guard.js | 所有入向文件路径必须经 realpath 解析，严格校验其归属于已授权的 WORKDIRS 之下 |
| 安全浏览与预览 | app/src/files/file-browse.js · file-preview.js | 只读文件列表、分段按需读取与 Git Diff 查看；绝不开设公开无鉴权的文件下载 URL |

## 相关通讯端点

- browse:list ：分页读取白名单目录下的文件树（受 .gitignore 过滤）。
- browse:read ：按需只读读取指定文本片段（限制单次最大读取行数）。
- tool:preview / tool:full ：获取工具输出卡片的缩略快照与完整执行结果。
