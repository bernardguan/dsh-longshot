# Third-party notices

本仓库包含第三方 MIT 代码。按 MIT 许可要求，以下版权声明与许可文本随本仓库一并分发。

## src/raster.js

- 出处：[`beijingwahw/dsh-companion`](https://github.com/beijingwahw/dsh-companion) 的 `lib/client/raster.js`
  （其自身注明「能力吸收自 dsh-conv-export」）
- 用途：分片光栅 + 流式 PNG 编码引擎
- 本仓库的改动：去掉 ESM `export` 关键字以便内联进 `window.__ModuleLoader__` 工厂闭包；
  把固定的 800 px 画布宽度改为可配置（`options.width` / `stage.width`）。
  光栅与编码算法本身未改动。

```
MIT License

Copyright (c) 2026 DeepSeek Companion Contributors

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
