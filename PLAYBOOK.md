# PLAYBOOK — 从代码到文案到视频的全流程

> 目标：任何时候（代码演进后、要发新平台、素材过时）都能**只凭本分支 + 主仓代码**快速再产出文案与视频，不依赖任何人的记忆。

## 三条铁律

1. **文案从代码来**：能力主张只写当前代码实证存在的功能。先找证据，后下笔；找不到证据的句子删掉。
2. **核查表**：每条主张在文案末尾登记 `主张 → 代码证据`（E2E spec / src 模块 / README 章节）。更新文案的第一步永远是拿核查表对当前代码做失效检查。
3. **禁写清单**：实时镜像正在终端跑的活会话画面、离线可用、语音输入、拍照直传——代码不支持；此外凡代码没有的一律不写。成片发布前逐条复核。

## 流程 A · 新写 / 更新文案

1. **提取能力面**（都在主仓 dev）：
   - `README.md`「适用场景 / 安全模型 / 特性」——产品自己的话
   - `ls tests/e2e/p0/`——每个 spec 文件名就是一条已验证的用户可见行为
   - `ls tests/smoke/scenarios/`——每个场景是一条真 CLI 链路能力
   - `ls src/*/ public/js/app/`——模块名圈定后端/前端能力面
   - 增量更新时：`git log --oneline <上次文案更新的主仓 commit>..dev` 看新增了什么
2. **失效检查**：拿 `copy/*.md` 末尾核查表逐条对代码——证据路径还在吗？行为还成立吗？失效的主张连文案带表一起删。
3. **写/改文案**：`copy/vertical.md`（竖屏短视频）、`copy/horizontal.md`（横屏长视频）。新主张必须同步登记核查表。
4. **同步 timeline**：文案改动落到 `timeline/*.json`（分镜/字幕/时长）。timeline 是 gen-cards 与 compose 的唯一输入，文案与 timeline 不一致时以文案为准修 timeline。

## 流程 B · 出竖屏成片（全自动，零 token）

`shotlist.md` 四条命令：起拍摄 rig → 录 6 段素材 → 生成图层 → 合成。当前 rig 指针：**主仓 `ae0e722^`**（demo:* mock 场景拆除前最后一个 commit）。

## 流程 C · 出横屏成片（半自动）

`timeline/horizontal.json` 的 narration 数组 → ai_video 工作台（`~/code/ai_video`）：`make-tts.mjs` 出旁白与时间轴 → `make-bgm.mjs` 出零版权音床 → HyperFrames 双朝向工程 build + render。人工环节：旁白听感定稿、镜头时长微调。

## 维护点（诚实的成本）

- **拍摄 rig 会过时**：rig 是历史检出，UI 大改后录出的画面 = 旧 UI。要新画面有两条路：把 `demo.js` 场景（`git show ae0e722^:tests/e2e/mock/scenarios/demo.js`）临时移植到新代码的 mock server 上录完即弃；或接受旧画面。移植后记得把本文件和 shotlist.md 的 rig 指针改成新的 commit。
- **证据路径会漂移**：主仓重构（文件改名/spec 合并）后核查表路径失效不代表能力消失——先找新位置，找不到再删主张。
- **成片不进 git**：`render/` 被 ignore；留存拷去稳定盘位（如 `~/code/ai_video/projects/`），发布平台本身也是一份留存。

## 分工地图

```
promo 分支（本分支） = 创作源：文案 + 核查表 + timeline + 出片工具（纯文本，自包含）
主仓 dev            = 事实来源：所有能力主张的证据
主仓 ae0e722^       = 拍摄 rig：mock server + demo:* 场景（临时 worktree 检出，用完即弃）
~/code/ai_video     = 重工坊：TTS / BGM / HyperFrames 长片工程 + 产物稳定盘位
```
