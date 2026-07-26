// ESLint flat config —— 最小规则集：recommended + no-unused-vars 调优。
// 定位：接替 scripts/check-syntax.js 的语法门，并额外抓 AI 维护代码库的高发错误
// （跨文件改名漏改 no-undef、死变量 no-unused-vars）。刻意不引入风格/格式化规则。
import js from '@eslint/js';
import globals from 'globals';
import unusedImports from 'eslint-plugin-unused-imports';

export default [
  {
    // vendor 为第三方压缩产物、docs 为落地页产物、其余为运行时/测试生成物
    ignores: [
      'node_modules/**',
      'public/vendor/**',
      'public/test-snapshots/**',
      'docs/**',
      'data/**',
      '.ccm-uploads/**',
      'playwright-report/**',
      'test-results/**',
      'coverage/**',
      '.bug-hunter/**',
      '.codegraph/**',
      '.reasonix/**',
      '.worktrees/**',
    ],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    plugins: { 'unused-imports': unusedImports },
    rules: {
      // 死 import 用插件规则（可 --fix 自动清除，AI 编辑后的高发残留）；
      // 其余未用变量仍报错但不自动删（删变量可能改语义，须人工判断）
      'no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  // Node 侧：后端源码、维护脚本、测试
  {
    files: ['server.js', 'src/**/*.js', 'scripts/**/*.js', 'tests/**/*.{js,mjs}'],
    languageOptions: { globals: { ...globals.node } },
  },
  // 浏览器侧：native-ESM PWA
  {
    files: ['public/js/**/*.js'],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      // `t` 在前端专属 i18n（public/js/i18n.js）。把它当临时变量名会静默遮蔽成
      // 「t is not a function」——页面运行时才炸，而 no-undef 看不出问题（t 确实有定义）。
      // 这类 bug 只有真跑 E2E 才会暴露，代价太高，所以在这里一次性拦掉。
      'no-restricted-syntax': [
        'error',
        {
          selector: 'VariableDeclarator > Identifier[name="t"]',
          message: '别用 t 作局部变量名：会遮蔽 i18n 的 t()，运行时报 "t is not a function"。换个名字（textEl / entry / touch …）。',
        },
        {
          selector: ':matches(FunctionDeclaration, FunctionExpression, ArrowFunctionExpression) > Identifier.params[name="t"]',
          message: '别用 t 作参数名：会遮蔽 i18n 的 t()，运行时报 "t is not a function"。换个名字。',
        },
      ],
    },
  },
  // 经典 <script>（非 ESM）：tw-config 写入 tailwind 全局、sw-cleanup 操作 navigator
  {
    files: ['public/js/tw-config.js', 'public/js/sw-cleanup.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.browser, tailwind: 'writable' },
    },
  },
  // Service Worker 上下文
  {
    files: ['public/js/sw.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.serviceworker },
    },
  },
];
