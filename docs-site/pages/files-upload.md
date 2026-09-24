# 文件与上传
> 工作区白名单、三层路径闸、附件与预览。

- **Part**: 第四部分 · 核心实现
- **Reading Time**: ~10 min
- **Estimated Tokens**: ~1387

---

文件能力围绕「白名单工作区」与「越界即拒」构建：上传附件为会话注入上下文，文件浏览、搜索、预览与编辑都不能逃出白名单目录。

## 工作区白名单（WORKDIRS）

- 默认工作区： WORKDIRS 的第一项就是手机端默认打开的目录。旧的单值 WORK_DIR 已并入首项，原先三处静默回落到家目录的路径都已删除；装机向导在非交互模式下遇到「回落 $HOME 」直接拒绝。
- 拒绝过宽的根： 不能填家目录本身，也不能填 / 、 /Users 、 /home 这类根；判定前先做路径归一与 symlink 解析，等价写法绕不过去。向导与写入侧共用这一份判据。
- 手机上可编辑： 「设置 → 行为与开关」进「全部配置」，有工作区列表的结构化编辑器；它是唯一免重启的配置项。
- 热加载： server 监听配置文件变化，增删工作区改完即生效。被移除的工作区上，已开的会话继续运行，但禁止新开（ ensureWhitelisted 拦截）。

## 附件上传

> **TIP:** 附件已搬出用户项目 — 早期附件落在各工作目录的 .ccm-uploads/，会弄脏 git 状态，还可能触发 CLI 审批。2026-09-06 起落在受管数据目录 $CCM_DATA_DIR/uploads/ /。旧的 .ccm-uploads/ 既不迁移也不删除，历史消息预览会自动回落过去读。

1. 手机端上传图片或粘贴截图，经 Socket 传到服务端，校验类型与大小上限（前后端的上限数字一致）。
2. 服务端落盘到 $CCM_DATA_DIR/uploads/<工作区桶>/ ，文件权限 0600 ，文件名做防穿越处理。
3. 附件的绝对路径拼进提示词，CLI 用原生 Read 工具读取图片与文档。
4. 上传目录通过 additionalDirectories （即 --add-dir ）交给 CLI，保住免审批。注意这是 spawn 时的快照：实例启动之后才出现的新目录要等下次启动才生效。

## 路径防护

| 防御层级 | 核心模块 | 防什么、怎么防 |
| --- | --- | --- |
| 写安全 | app/src/files/file-security.js | 仅所有者读写（ 0600 ）、symlink 劫持检测、原子写入 |
| 工作区范围门 | app/src/files/workdir-scope-guard.js | 入向路径一律经 realpath 解析，必须落在已授权的 WORKDIRS 之下；symlink 逃出工作区即拒绝并记审计 |
| 浏览与预览 | app/src/files/file-browse.js · file-preview.js | 只读列表、分段读取与 git diff； FIFO、字符设备、unix socket 在 open 之前就拒绝 ，否则整个 Node 进程会卡死；不开任何无鉴权的文件下载 URL |

内置文件编辑器直接写盘，**不经 Agent 的工具审批链**：写入时带上读到时的内容哈希，与磁盘不符就拒绝，不静默覆盖；另有范围校验、大小上限与审计。`FILE_EDIT=off` 可关闭。

## 相关通讯事件

- browse:list ：读取白名单目录下的一层文件树（根目录传 '.' ）。
- browse:read ：只读读取文件内容。
- files:search ：在工作区里搜索文件，也用于输入 @ 时的补全候选。
- files:write ：内置编辑器写入，带 baseHash 冲突检测。
- tool:preview / tool:full ：工具卡的变更预览与完整结果。
