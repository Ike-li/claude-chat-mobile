// 语义色配置：CSS 编译入口加载它，`npm run build:css` 生成 app/public/css/tw.css。产物提交进仓库——分发是 master
// 源码归档，装机不跑构建；tests/gates/check-tailwind-css.js 按同一份配置重编，与提交的产物逐字节比对。
// 此前是浏览器里跑的 Play CDN（vendor/tailwind.js + js/tw-config.js）：启动时同步执行 400KB 脚本，之后每批
// DOM 变化都全量扫一遍 class 再现编 CSS。现在 @source 只扫源码文本，动态拼出来的类名（`bg-${x}`）扫不到，要写全名。
//
// 把 Claude 设计 token（:root CSS 变量，定义见 app/public/css/app.css）桥接为语义工具类——
// 用 bg-canvas / text-accent / border-line 这类**预设类**（active:/focus: 变体齐全、可读），
// 而非 bg-[var(--x)] 任意值类。改色只动 :root，一处生效。
//
// Tailwind 4 原生支持 CSS 变量色值的 /NN 透明度，由编译器生成 color-mix。
// 保留 token() 让同一份语义色映射继续清楚对应 app.css 的设计变量。
const token = (name) => `var(${name})`;

export default {
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
