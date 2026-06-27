# 第三方组件与许可证 / Third-Party Notices

本目录（`public/vendor/`）打包并随项目分发以下第三方组件。它们各自的版权与许可证如下，
分发时须保留本文件。项目自身代码以 MIT 许可（见仓库根 `LICENSE`），不改变下列组件的许可。

This directory bundles and redistributes the third-party components listed below. Their
respective copyrights and licenses apply and must be preserved on redistribution. The
project's own code is MIT-licensed (see root `LICENSE`); that does not relicense these.

---

## marked — `marked.min.js`

- 版本 / Version: 12.0.2
- 版权 / Copyright: © 2011–2024 Christopher Jeffrey and contributors
- 许可 / License: MIT (SPDX: `MIT`)
- 来源 / Source: https://github.com/markedjs/marked

## DOMPurify — `purify.min.js`

- 版本 / Version: 3.4.10
- 版权 / Copyright: © Cure53 and other contributors
- 许可 / License: Apache-2.0 **OR** MPL-2.0（双许可，二选一）(SPDX: `Apache-2.0 OR MPL-2.0`)
- 许可全文 / Full text: https://github.com/cure53/DOMPurify/blob/3.4.10/LICENSE
- 来源 / Source: https://github.com/cure53/DOMPurify

## highlight.js — `highlight.min.js`

- 版本 / Version: 11.11.1
- 版权 / Copyright: © 2006–2024 Josh Goebel and other contributors
- 许可 / License: BSD-3-Clause (SPDX: `BSD-3-Clause`)
- 来源 / Source: https://github.com/highlightjs/highlight.js

## highlight.js GitHub Light 主题 — `github-light.min.css`

- 来源主题 / Theme: GitHub（Light），highlight.js 自带主题，维护者 @Hirse
- 版权与许可同 highlight.js / Copyright and license: same as highlight.js above (BSD-3-Clause)
- 来源 / Source: https://github.com/highlightjs/highlight.js/tree/main/src/styles

## Tailwind CSS — `tailwind.js`

- 构建 / Build: Tailwind CSS（浏览器内 Play CDN 构建 / browser Play build）
- 版权 / Copyright: © Tailwind Labs, Inc. and contributors
- 许可 / License: MIT (SPDX: `MIT`)
- 来源 / Source: https://github.com/tailwindlabs/tailwindcss

## Source Serif（字体 / font） — `source-serif-400.woff2`, `source-serif-600.woff2`, `source-serif-italic.woff2`

- 版权 / Copyright: © 2014–2021 Adobe (https://www.adobe.com/)，保留字体名 / Reserved Font Name 'Source'
- 许可 / License: SIL Open Font License 1.1 (SPDX: `OFL-1.1`)
- 许可全文 / Full text: https://openfontlicense.org
- 来源 / Source: https://github.com/adobe-fonts/source-serif

---

## 许可证全文 / Full license texts

### MIT License（适用于 / applies to: marked, Tailwind CSS）

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### BSD-3-Clause（适用于 / applies to: highlight.js 及其 GitHub 主题 / and its GitHub theme）

```
Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software
   without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### Apache-2.0 / MPL-2.0（适用于 / applies to: DOMPurify）与 OFL-1.1（Source Serif）

这两者许可证篇幅较长，按惯例以上游全文链接为准（见各组件条目的「许可全文」）。分发本目录即附带
了相应的版权声明，满足其保留通知的要求。

These two licenses are long; per common practice their canonical full text is referenced via the
upstream links above (see each component's "Full text"). Redistributing this directory preserves
the required copyright notices.
