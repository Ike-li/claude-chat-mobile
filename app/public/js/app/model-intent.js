// model-intent.js —— 用户在当前会话里有没有亲手选过模型（#229 review）
//
// 点磁贴、点自定义卡片、打 /model 才算「选过」。只有选过，发送时才把选择框里的值当成换模型的意图；
// 没选过的运行中会话原样带回在跑的模型（判据在 logic 的 resolveOutgoingModel，验收 O53 / O26）。
// 换会话即作废：上一个会话里点过的模型不是这一个的发送意图。
// 此前这份状态挂在 modelInput.dataset.picked 上，写、读、清散在 app.js 的几个回调里。

export function createModelIntent() {
  let picked = false;
  return {
    markPicked() { picked = true; },
    reset() { picked = false; },
    isPicked: () => picked,
  };
}
