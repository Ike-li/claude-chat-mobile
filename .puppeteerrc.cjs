// runner 用 headless:true → 完整 chrome，从不使用 chrome-headless-shell（仅 headless:'shell' 用）。
// 跳过这个用不到的二进制下载，让开发全装 `npm install` 只下 chrome、避免 CDN 抖动卡死；
// 视觉测试 `npm run test:visual` 仍零配置可用。（用户端 `npm install --omit=dev` 不装 puppeteer，本文件对其无影响。）
module.exports = {
  'chrome-headless-shell': { skipDownload: true },
};
