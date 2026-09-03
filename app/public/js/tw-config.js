// Tailwind 运行时配置（CSP script-src 'self'：必须外置脚本、不可内联；在 vendor/tailwind.js 之后加载）。
// 把 Claude 设计 token（:root CSS 变量，定义见 index.html <style>）桥接为语义工具类——
// 用 bg-canvas / text-accent / border-line 这类**预设类**（JIT 成熟、active:/focus: 变体齐全、可读），
// 而非 bg-[var(--x)] 任意值类（运行时对动态注入元素的任意值 JIT 是边缘路径）。改色只动 :root，一处生效。
tailwind.config = {
  theme: {
    extend: {
      colors: {
        canvas: 'var(--canvas)',
        surface: 'var(--surface)',
        sunk: 'var(--surface-sunk)',
        ink: 'var(--ink)',
        'ink-soft': 'var(--ink-soft)',
        'ink-faint': 'var(--ink-faint)',
        accent: {
          DEFAULT: 'var(--accent)',
          deep: 'var(--accent-deep)',
          bright: 'var(--accent-bright)',
          wash: 'var(--accent-wash)',
        },
        cta: 'var(--cta)',
        user: 'var(--user-bubble)',
        info: 'var(--info)',
        success: 'var(--success)',
        danger: 'var(--danger)',
        warning: 'var(--warning)',
        line: 'var(--line)',
        'line-soft': 'var(--line-soft)',
      },
      fontFamily: {
        read: 'var(--font-read)',
      },
    },
  },
};
