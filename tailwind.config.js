// Tailwind CLI 配置：`npm run build:css` 据此预编译 app/public/css/tw.css。产物提交进仓库——分发是 master
// 源码归档，装机不跑构建；tests/gates/check-tailwind-css.js 按同一份配置重编，与提交的产物逐字节比对。
// 此前是浏览器里跑的 Play CDN（vendor/tailwind.js + js/tw-config.js）：启动时同步执行 400KB 脚本，之后每批
// DOM 变化都全量扫一遍 class 再现编 CSS。content 只扫源码文本，动态拼出来的类名（`bg-${x}`）扫不到，要写全名。
//
// 把 Claude 设计 token（:root CSS 变量，定义见 app/public/css/app.css）桥接为语义工具类——
// 用 bg-canvas / text-accent / border-line 这类**预设类**（active:/focus: 变体齐全、可读），
// 而非 bg-[var(--x)] 任意值类。改色只动 :root，一处生效。
//
// #359：色值写成函数而不是裸 'var(--x)' 字符串——Tailwind 对裸 var() 合不出 alpha，bg-danger/10、border-warning/40
// 这类带 /NN 的类整条规则不产出（底色直接透明、边框回落默认灰）。只有显式 /NN 时才走 color-mix；不带修饰的
// bg-surface 仍原样输出 var(--surface)（Tailwind 此时传进来的是 var(--tw-bg-opacity)，仓里不用 bg-opacity-*），
// 不支持 color-mix 的旧浏览器上受影响的也只是本来就失效的那些 /NN 类。
const token = (name) => ({ opacityValue }) =>
  opacityValue === undefined || String(opacityValue).startsWith('var(')
    ? `var(${name})`
    : `color-mix(in srgb, var(${name}) calc(${opacityValue} * 100%), transparent)`;

export default {
  content: {
    relative: true,
    files: ['./app/public/index.html', './app/public/js/**/*.js'],
  },
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
