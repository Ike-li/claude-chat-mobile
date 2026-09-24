# 漂移清单
> 文档与代码不一致处，以代码为准。

- **Part**: 第七部分 · 参考与规范
- **Reading Time**: ~8 min
- **Estimated Tokens**: ~2207

---

下列条目是文档、注释与当前生产代码之间已经确认的漂移记录。阅读、排障与开发时，一律以最新代码为准。本页于 2026-09-24 随手册 v2.1 刷新，基线 dev@3f488861。

## 2026-09-24 刷新时修正的漂移

| 关注领域 | 旧描述 | 代码最新事实（以此为准） | 影响与说明 |
| --- | --- | --- | --- |
| 安装方式 | git clone + npm install | 用户装机拉 GitHub 对 master 的源码归档， npm ci --omit=dev ； git clone 留给要改代码、跑测试的人 | 归档里没有测试树与门禁， npm run check 等只在完整仓库可用 |
| 无令牌时的行为 | 「未设 AUTH_TOKEN 时只绑定 127.0.0.1」 | 令牌是启动前提：缺令牌在 listen 之前就拒绝启动；监听面由 BIND_MODE 决定 | 不存在「本地免鉴权」 |
| 启动横幅 | 打印带完整令牌的访问 URL | 任何情况下都只显示掩码；免手输改用 node scripts/qr.js | 2026-09-17 安全审查 |
| 第三方网关配置 | 「必须在启动 server 的 shell 里 export ANTHROPIC_* 」 | 推荐写在 CLI settings 文件的 env 块，桌面端拉起的常驻服务也认；shell export 只对 headless 有效 | 写进 ccm.config.json 的 ANTHROPIC_* 仍会被剥除 |
| ACCESS_PROFILE | 三候选，决定鉴权与反代采信分支 | 五个取值的纯声明，只供 doctor 与安全体检；鉴权按请求的 Host 分支 | TRUSTED_PROXY 只决定限速分桶 |
| 默认工作区 | WORK_DIR ，未配置时回落 | WORKDIRS 第一项；静默回落家目录的路径已删除，过宽的根一律拒绝 | — |
| 回退入口 | 长按用户气泡 | /rewind 两步面板（2026-09-20）；assistant 气泡常驻「分叉」入口 | Web 回退分叉出新会话，原会话不动 |
| 会话隐藏（L1） | 左滑隐藏，仍可找回 | 已移除；只剩关闭与彻底删除（两道保护） | — |
| 已读位点存放 | 写在 sessions.json | 单独的 read-state.json | — |
| 契约事件数量 | 出向 31、入向 57 | dev：出向 31、入向 58（+ user:autoContinue ）；最新发布版 v1.12.1 仍为 57 | 站点的 check-event-contract.mjs 读的是主工作树的 protocol.js ，主工作树不在最新 dev 时会报不一致 |
| Agent SDK 版本 | 0.3.263 | dev 为 0.3.278；v1.12.1 为 0.3.263 | — |
| 分支与发版 | 日常在 dev 直接开发，master 由 dev fast-forward | feature 分支 → PR → dev；master 只接 release.sh 开的发版 PR，合并后打 tag | master 上不得有未发版提交 |
| 「产品宪法 C1–C5」 | 手册自编的五条，并注明「见 hard-rules.md」 | 产品仓文档里没有这个标签；对应内容是 hard-rules §1 的产品边界，已在「职责边界」页按原文重写 | 「不做」清单的编号同样改用 hard-rules §5 的真实 ID |

## 早先已登记的漂移

| 关注领域 | 陈旧描述 | 代码事实 | 影响与说明 |
| --- | --- | --- | --- |
| 源码目录 | 旧文档大量引用 src/** 与 public/** | 运行时代码在 app/ （ app/src/ 与 app/public/ ） | 计算项目根要上溯三层，防止数据写到 app/data |
| 思考强度调整 | effort 不能动态修改，切档必须重建实例 | 经控制请求 applyFlagSettings 即刻生效，回合进行中也能切 | 只有切回「没指定」才需要重开实例 |
| 附件存放 | 工作区下的 .ccm-uploads/ | $CCM_DATA_DIR/uploads/ / | 旧目录既不迁移也不删除，历史预览自动回落 |
| 配置格式 | 以 .env 为主 | ccm.config.json 优先，缺失才回落 .env | 由 config-file.js 统管读写 |
| 测试运行安全 | 未限制宿主机测试范围 | guard-host-tests 白名单 + 破坏性测试目录的执行位守卫 | 可能破坏数据的测试一律进容器 |
| 产品立场 | 偶有多租户扩展的提案 | hard-rules 明确 n=1 自托管，不做多租户 | 要改先改 hard-rules 的立场 |

## 产品仓自身的文档漂移（待修）

- README.md / README.en.md 的对照表仍写「长按消息：回退 / 分叉」。回退已改走 /rewind ，分叉是 assistant 气泡上的常驻入口。
- docs/architecture.md 第 81 行 仍写「长按 user 气泡 → 回退到此轮前」，同上。

## 关于历史 design.md 标记

代码注释里仍能看到 `// 守护：SRV-003` 这类编号，或指向 `docs/design.md` 的引用。前者由 `tests/README.md` 的不变量编号体系接管；后者是早期设计文档留下的溯源锚点，文件本身早已删除，不要当成仍存在的文档路径。

## 手册维护约定

- 手册部署在 gh-pages 分支，不随 dev 自动更新。刷新时先对照 CHANGELOG 里自上次基线以来的各版本，再逐页核对正文。
- audit-consistency.cjs 只能证明手册引用的路径、配置项、事件名与 npm 脚本还存在，查不出「描述过时」「漏写新功能」「数字不对」这类漂移；它还把仓库根写死为主工作树，核对最新 dev 时要指向一份最新检出。
- 生产代码有结构性变更时，先把真实行为登记进本清单，再更新正文。
- 不通过修改文档来掩盖代码实际存在的缺陷。
