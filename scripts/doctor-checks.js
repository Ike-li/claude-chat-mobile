export function statuslineConfigDiagnostic() {
  return {
    status: 'ok',
    name: 'WEB_STATUSLINE',
    detail: 'web 状态栏自包含：使用 SDK usage + 本机 git + CLI 版本，默认启用；设 WEB_STATUSLINE=off 可关闭。',
  };
}
