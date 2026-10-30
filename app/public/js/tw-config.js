// Tailwind 运行时配置（CSP script-src 'self'：必须外置脚本、不可内联；在 vendor/tailwind.js 之后加载）。
// 把 Claude 设计 token（:root CSS 变量，定义见 index.html <style>）桥接为语义工具类——
// 用 bg-canvas / text-accent / border-line 这类**预设类**（JIT 成熟、active:/focus: 变体齐全、可读），
// 而非 bg-[var(--x)] 任意值类（运行时对动态注入元素的任意值 JIT 是边缘路径）。改色只动 :root，一处生效。
//
// #359：色值写成函数而不是裸 'var(--x)' 字符串——Tailwind 对裸 var() 合不出 alpha，bg-danger/10、border-warning/40
// 这类带 /NN 的类整条规则不产出（底色直接透明、边框回落默认灰）。只有显式 /NN 时才走 color-mix；不带修饰的
// bg-surface 仍原样输出 var(--surface)（Tailwind 此时传进来的是 var(--tw-bg-opacity)，仓里不用 bg-opacity-*），
// 不支持 color-mix 的旧浏览器上受影响的也只是本来就失效的那些 /NN 类。
const token = (name) => ({ opacityValue }) =>
  opacityValue === undefined || String(opacityValue).startsWith('var(')
    ? `var(${name})`
    : `color-mix(in srgb, var(${name}) calc(${opacityValue} * 100%), transparent)`;

tailwind.config = {
  theme: {
    extend: {
      colors: {
        canvas: token('--canvas'),
        surface: token('--surface'),
        sunk: token('--surface-sunk'),
        ink: token('--ink'),
        'ink-soft': token('--ink-soft'),
        'ink-faint': token('--ink-faint'),
        accent: {
          DEFAULT: token('--accent'),
          deep: token('--accent-deep'),
          bright: token('--accent-bright'),
          wash: token('--accent-wash'),
        },
        cta: token('--cta'),
        user: token('--user-bubble'),
        info: token('--info'),
        success: token('--success'),
        danger: token('--danger'),
        'danger-solid': token('--danger-solid'),
        warning: token('--warning'),
        line: token('--line'),
        'line-soft': token('--line-soft'),
        // #368：console 抽屉色板（固定深色 token，见 app.css --console-*）
        console: {
          DEFAULT: token('--console-bg'),
          surface: token('--console-surface'),
          sunk: token('--console-sunk'),
          line: token('--console-line'),
          ink: token('--console-ink'),
          'ink-soft': token('--console-ink-soft'),
          'ink-faint': token('--console-ink-faint'),
        },
      },
      fontFamily: {
        read: 'var(--font-read)',
      },
    },
  },
};
