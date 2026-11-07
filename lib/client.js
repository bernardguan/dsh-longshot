/**
 * dsh-longshot —— 客户端半（构建产物，请勿直接编辑）。
 * 源码：src/raster.js（光栅引擎）+ src/ui.js（按钮与面板）；构建：scripts/build-client.mjs
 */
window.__ModuleLoader__.load({
  id: "dsh-longshot",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

/**
 * 分片光栅 + 流式 PNG 编码引擎（vendor，来源 dsh-companion MIT）。
 * 已去掉 ESM export 关键字，以便内联进 __ModuleLoader__ 工厂闭包。
 */
/**
 * 客户端光栅导出引擎（能力吸收自 dsh-conv-export，流式重构）：
 * - 分片光栅（tiled rasterization）：整篇对话按片高（A4 页高整数倍）逐片
 *   光栅化，片内经 SVG foreignObject 窗口（translateY 位移）渲染到独立
 *   2x canvas——单 canvas 高度不再是上限，PDF 页数无上限、页界与片界
 *   对齐（页永不跨片），峰值内存恒为「单片」量级；
 * - PNG 长图：流式 PNG 编码器（StreamingPngEncoder）逐片取像素 → 逐行
 *   PNG 过滤（自适应选片级过滤器，跨片行连续性经原始行携带）→
 *   CompressionStream('deflate')（恰为 PNG 规范要求的 zlib 流）增量压缩
 *   → Blob 直下。PNG 规范本身无高度上限，突破旧 16000px 截断；
 * - 免打印 PDF：分片光栅 → 按页切片 → JPEG → 组装最小多页 PDF 下载。
 *
 * 取代旧的 window.print() 回退路径：打印对话框在部分平台（尤其 Windows Chrome）
 * 是窗口模态对话框，会冻结整个浏览器（包括应用标签页）直至关闭；
 * 光栅路径零对话框、零冻结，成品像普通文件一样直接下载。
 *
 * 仅依赖浏览器内置能力（DOM/canvas/CompressionStream），不依赖 cordis 与
 * React，可单测。无 CompressionStream 的环境退回旧的单 canvas 截断路径。
 */
/** 光栅宽度（CSS px；2x 视网膜下实际像素翻倍）。 */
const IMAGE_WIDTH = 800;
/** 光栅缩放系数（2x 视网膜）。 */
const IMAGE_SCALE = 2;
/** PDF 单页高度（IMAGE_WIDTH 宽下的 CSS px，A4 纵横比）。 */
const PAGE_CSS_HEIGHT = Math.round((IMAGE_WIDTH * 297) / 210);
/** 单个光栅分片承载的 A4 页数：片高 = 页高 × 此值（页界与片界对齐）。 */
const PAGES_PER_TILE = 2;
/** 分片高度（CSS px）。 */
const TILE_CSS_HEIGHT = PAGE_CSS_HEIGHT * PAGES_PER_TILE;
/**
 * 整篇对话光栅总高上限（CSS px，≈176 页 A4）：产品理智上限，
 * 防御极端内存/时长；PNG/PDF 路径共用。
 */
const MAX_TOTAL_CSS_HEIGHT = 200_000;
/** 旧路径单 canvas 高度上限（无 CompressionStream 环境的降级截断）。 */
const LEGACY_MAX_HEIGHT = 16000;
/**
 * 单步光栅/编码操作超时（毫秒）：img.decode()、canvas.toBlob 与
 * CompressionStream 读写依赖宿主回调，个别环境（如离屏 canvas 被回收、
 * 压缩流内部错误未传播）会永不结算——没有兜底则导出按钮永久转圈、
 * stage 离屏节点永久滞留。超时视同该步失败，走既有异常清理路径。
 */
const STEP_TIMEOUT_MS = 30_000;
/**
 * 给 Promise 套超时：超时拒绝并放弃原 Promise 的结果（不取消底层操作，
 * 但调用方的异常路径会完成全部清理）。
 */
function withTimeout(promise, message, ms = STEP_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), ms);
        promise.then((value) => {
            clearTimeout(timer);
            resolve(value);
        }, (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}
/** canvas → Blob，附超时与 null 检测（toBlob 失败回调 null）。 */
async function canvasToBlob(canvas, mime, quality) {
    const blob = await withTimeout(new Promise((resolve) => canvas.toBlob(resolve, mime, quality)), `canvas ${mime} 编码超时`);
    if (blob === null)
        throw new Error('toBlob failed');
    return blob;
}
/**
 * 从服务端打印 HTML 文档中提取可渲染内容与样式。
 * 剥离全部 script：打印回退页携带自动打印脚本，光栅路径绝不允许其执行。
 * @param html 完整 HTML 文档字符串（服务端 buildPrintHtml 产物）。
 * @returns 样式文本与 body 内容。
 */
function toStageContent(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    for (const el of Array.from(doc.querySelectorAll('script')))
        el.remove();
    const styles = Array.from(doc.querySelectorAll('style'))
        .map((el) => el.textContent ?? '')
        .join('\n');
    // body 选择器在 foreignObject 内不生效：提取其声明，稍后直接落到光栅舞台根节点。
    const bodyStyle = styles.match(/(?:^|[}\s])body\s*\{([^}]*)\}/i)?.[1] ?? '';
    return { styles, bodyInner: doc.body.innerHTML, bodyStyle };
}
/**
 * 把 body 声明改写为「容器安全」形态：垂直 margin 归零、等量转为
 * padding（padding 可靠计入 scrollHeight 且不会经外边距折叠丢失，
 * 也不需要 translateY 补偿），水平居中的 auto margin 保留。
 * 保证测高与 foreignObject 光栅化两个上下文按同一盒模型布局。
 */
function toContainerStyle(bodyStyle) {
    const decls = bodyStyle
        .split(';')
        .map((d) => d.trim())
        .filter((d) => d !== '');
    const out = [];
    let padTop;
    let padBottom;
    for (const decl of decls) {
        const sep = decl.indexOf(':');
        if (sep <= 0)
            continue;
        const prop = decl.slice(0, sep).trim().toLowerCase();
        const value = decl.slice(sep + 1).trim();
        if (prop === 'margin') {
            // margin: <top> <right?> <bottom?> <left?> → 垂直段转 padding、水平段保留 auto。
            const parts = value.split(/\s+/);
            const top = parts[0] ?? '0';
            const bottom = parts.length >= 3 ? parts[2] : top;
            const right = parts.length >= 2 ? parts[1] : '0';
            const left = parts.length >= 4 ? parts[3] : right;
            if (top !== '0')
                padTop = top;
            if (bottom !== '0')
                padBottom = bottom;
            out.push(`margin:0 ${right === left ? right : `${right} ${left}`}`);
            continue;
        }
        if (prop === 'margin-top') {
            if (value !== '0')
                padTop = value;
            continue;
        }
        if (prop === 'margin-bottom') {
            if (value !== '0')
                padBottom = value;
            continue;
        }
        out.push(`${prop}:${value}`);
    }
    if (padTop !== undefined)
        out.unshift(`padding-top:${padTop}`);
    if (padBottom !== undefined)
        out.push(`padding-bottom:${padBottom}`);
    // 显式文字色：宿主继承色在 SVG 图像上下文不可用，防止白底白字。
    if (!out.some((d) => d.startsWith('color:')))
        out.push('color:#111111');
    return out.join(';');
}
/**
 * 将容器内全部 <img> 内联为 data: URL，使 SVG foreignObject 光栅可嵌入图片
 * （SVG 图像内部禁止外部资源请求）。
 * @param root 就地内联图片的容器。
 */
async function inlineImages(root, signal) {
    const imgs = Array.from(root.querySelectorAll('img'));
    await Promise.all(imgs.map(async (img) => {
        const src = img.getAttribute('src') ?? '';
        if (src === '' || src.startsWith('data:'))
            return;
        try {
            const res = await fetch(src, { signal });
            if (!res.ok) {
                // 不可达的图片：移除，避免 SVG 光栅上下文渲染破图。
                img.remove();
                return;
            }
            const blob = await res.blob();
            const dataUrl = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result));
                reader.onerror = () => reject(reader.error);
                reader.readAsDataURL(blob);
            });
            img.setAttribute('src', dataUrl);
        }
        catch {
            // 不可达的图片：直接移除，避免污染/拖垮光栅化。
            img.remove();
        }
    }));
}
/**
 * 光栅舞台：服务端打印 HTML 的离屏渲染宿主，支持按窗口分片光栅化。
 * 舞台在存活期内保持挂载（克隆源），dispose 时移除。
 */
class RasterStage {
    stage;
    totalHeight;
    truncated;
    /** 画布宽度（CSS px）：长图版式宽度，由调用方经 options.width 指定。 */
    width;
    constructor(stage, 
    /** 整篇内容高度（CSS px，已封顶 MAX_TOTAL_CSS_HEIGHT）。 */
    totalHeight, 
    /** 实际内容高度超出 MAX_TOTAL_CSS_HEIGHT 被封顶截断。 */
    truncated, 
    /** 画布宽度（CSS px）。 */
    width = IMAGE_WIDTH) {
        this.stage = stage;
        this.totalHeight = totalHeight;
        this.truncated = truncated;
        this.width = width;
    }
    /** 构建舞台：解析 HTML → 离屏挂载 → 内联图片 → 布局沉淀 → 测高。 */
    static async create(html, options) {
        const { styles, bodyInner, bodyStyle } = toStageContent(html);
        // 测高与光栅化共用同一容器样式：布局（列宽/字体/行高/换行）在两个
        // 上下文一致，totalHeight 才与实际渲染高度吻合，分片与页界不漂移。
        const containerStyle = toContainerStyle(bodyStyle);
        // 版式宽度：默认 800，调用方可指定（360–1600）。
        const width = Math.max(360, Math.min(1600, Math.round(options?.width ?? IMAGE_WIDTH)));
        const stage = document.createElement('div');
        stage.style.cssText =
            `position:fixed;left:-100000px;top:0;width:${width}px;pointer-events:none;z-index:-1;`;
        const style = document.createElement('style');
        style.textContent = styles;
        stage.appendChild(style);
        const content = document.createElement('div');
        content.setAttribute('style', `${containerStyle};width:${width}px;box-sizing:border-box;`);
        content.innerHTML = bodyInner;
        stage.appendChild(content);
        document.body.appendChild(stage);
        try {
            await inlineImages(stage, options?.signal);
            // 等待内联图片完成布局沉淀。
            await new Promise((resolve) => setTimeout(resolve, 60));
            const fullHeight = Math.ceil(stage.scrollHeight);
            const totalHeight = Math.max(1, Math.min(fullHeight, MAX_TOTAL_CSS_HEIGHT));
            if (fullHeight > MAX_TOTAL_CSS_HEIGHT)
                options?.onTruncated?.();
            return new RasterStage(stage, totalHeight, fullHeight > MAX_TOTAL_CSS_HEIGHT, width);
        }
        catch (error) {
            stage.remove();
            throw error;
        }
    }
    /** 移除离屏舞台（幂等）。 */
    dispose() {
        this.stage.remove();
    }
    /**
     * 光栅化 [offset, offset + height) 窗口到 2x canvas。
     * 窗口经克隆根的 translateY(−offset) 位移实现：foreignObject 视口裁剪
     * 视口外内容，浏览器只为窗口内像素付出光栅成本。
     * 克隆根不重复携带 body 样式（内容子节点已带，两上下文同构）。
     * @throws 运行环境无法光栅化时抛出（无 canvas / SVG 解析失败）。
     */
    async tile(offset, height) {
        const width = this.width;
        // 序列化干净克隆：不带离屏偏移（否则内容会移出 SVG 视口），
        // 显式 XHTML 命名空间保证 foreignObject 载荷格式合法。
        const clone = this.stage.cloneNode(true);
        clone.setAttribute('style', `width:${width}px;background:#ffffff;transform:translateY(-${offset}px);`);
        clone.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
        const serialized = new XMLSerializer().serializeToString(clone);
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
            `<foreignObject width="100%" height="100%">${serialized}</foreignObject></svg>`;
        // 光栅化前先校验 XML 良构性。
        const probe = new DOMParser().parseFromString(svg, 'image/svg+xml');
        if (probe.querySelector('parsererror') !== null)
            throw new Error('svg serialize failed');
        const img = new Image();
        img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
        await withTimeout(img.decode(), '光栅化图像解码超时');
        const canvas = document.createElement('canvas');
        canvas.width = width * IMAGE_SCALE;
        canvas.height = height * IMAGE_SCALE;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (ctx === null)
            throw new Error('no 2d context');
        ctx.scale(IMAGE_SCALE, IMAGE_SCALE);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        return canvas;
    }
}
// ---------------------------------------------------------------------------
// 流式 PNG 编码器（零依赖，仅浏览器内置能力）
// ---------------------------------------------------------------------------
/** PNG 签名（8 字节）。 */
const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/**
 * CRC-32 查表（镜像 core/zip.ts 的实现；客户端模块自包含，不跨端引入）。
 */
const PNG_CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c >>> 0;
    }
    return table;
})();
/** CRC-32（多段输入，多项式 0xedb88320，与 PNG/ZIP 一致）。 */
function crc32Parts(parts) {
    let crc = 0xffffffff;
    for (const part of parts) {
        for (let i = 0; i < part.byteLength; i += 1) {
            crc = PNG_CRC_TABLE[(crc ^ part[i]) & 0xff] ^ (crc >>> 8);
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}
/** ASCII 字节（PNG chunk 类型固定 4 字节 ASCII）。 */
function asciiBytes(text) {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i += 1)
        out[i] = text.charCodeAt(i) & 0x7f;
    return out;
}
/** 组装一个 PNG chunk：length(BE) + type + data + crc32(type ∥ data)(BE)。 */
function pngChunk(type, data) {
    const typeBytes = asciiBytes(type);
    const out = new Uint8Array(12 + data.byteLength);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.byteLength);
    out.set(typeBytes, 4);
    out.set(data, 8);
    view.setUint32(8 + data.byteLength, crc32Parts([typeBytes, data]));
    return out;
}
/** IHDR 载荷：宽/高(BE) + 位深 8 + 颜色类型 6(RGBA) + 压缩/过滤/隔行 0。 */
function ihdrBytes(width, height) {
    const out = new Uint8Array(13);
    const view = new DataView(out.buffer);
    view.setUint32(0, width);
    view.setUint32(4, height);
    out[8] = 8;
    out[9] = 6;
    out[10] = 0;
    out[11] = 0;
    out[12] = 0;
    return out;
}
/** Paeth 预测子（PNG 过滤器 4）。 */
function paethPredictor(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc)
        return a;
    if (pb <= pc)
        return b;
    return c;
}
const PNG_FILTERS = [0, 1, 2, 4];
/**
 * 对一行原始像素应用过滤器，写入 out[outAt..)（不含行首 filter 字节）。
 * @param prevData 上一原始行所在数组（undefined = 全零，即整图首行）。
 * @param prevStart 上一行在 prevData 中的起始下标。
 */
function applyFilter(filter, raw, rowStart, bytesPerRow, prevData, prevStart, out, outAt) {
    for (let i = 0; i < bytesPerRow; i += 1) {
        const x = raw[rowStart + i];
        if (filter === 0) {
            out[outAt + i] = x;
            continue;
        }
        const left = i >= 4 ? raw[rowStart + i - 4] : 0;
        const up = prevData !== undefined ? prevData[prevStart + i] : 0;
        let predictor;
        if (filter === 1)
            predictor = left;
        else if (filter === 2)
            predictor = up;
        else
            predictor = paethPredictor(left, up, prevData !== undefined && i >= 4 ? prevData[prevStart + i - 4] : 0);
        out[outAt + i] = x - predictor;
    }
}
/** 过滤器的编码代价启发式：过滤后字节的符号幅值总和，越小越优。 */
function filterCost(filter, raw, rowStart, bytesPerRow, prevData, prevStart) {
    let cost = 0;
    for (let i = 0; i < bytesPerRow; i += 1) {
        const x = raw[rowStart + i];
        if (filter === 0) {
            cost += x < 128 ? x : 256 - x;
            continue;
        }
        const left = i >= 4 ? raw[rowStart + i - 4] : 0;
        const up = prevData !== undefined ? prevData[prevStart + i] : 0;
        let predictor;
        if (filter === 1)
            predictor = left;
        else if (filter === 2)
            predictor = up;
        else
            predictor = paethPredictor(left, up, prevData !== undefined && i >= 4 ? prevData[prevStart + i - 4] : 0);
        const v = (x - predictor) & 0xff;
        cost += v < 128 ? v : 256 - v;
    }
    return cost;
}
/**
 * 片级自适应过滤器选择：均匀采样若干行，对候选过滤器累计代价取最小。
 * 逐行全量自适应在超长图（数十万行）下代价过高，片级选择把选择开销
 * 压到可忽略，同时保留主要的压缩收益。
 */
function pickTileFilter(data, width, height, carriedPrev) {
    const bytesPerRow = width * 4;
    const step = Math.max(1, Math.floor(height / 16));
    const costs = [0, 0, 0, 0];
    for (let y = 0; y < height; y += step) {
        const rowStart = y * bytesPerRow;
        for (let c = 0; c < PNG_FILTERS.length; c += 1) {
            const filter = PNG_FILTERS[c];
            if (y === 0) {
                costs[c] += filterCost(filter, data, rowStart, bytesPerRow, carriedPrev, 0);
            }
            else {
                costs[c] += filterCost(filter, data, rowStart, bytesPerRow, data, rowStart - bytesPerRow);
            }
        }
    }
    let best = 0;
    for (let c = 1; c < costs.length; c += 1) {
        if (costs[c] < costs[best])
            best = c;
    }
    return PNG_FILTERS[best];
}
/**
 * 流式 PNG 编码器：逐片消费 canvas 像素，增量产出 zlib 压缩的 IDAT 数据，
 * finish 时组装完整 PNG Blob。峰值内存 ≈ 单片原始像素 + 压缩输出。
 */
class StreamingPngEncoder {
    widthPx;
    heightPx;
    writer;
    outputChunks = [];
    pump;
    pumpError;
    carriedPrev;
    finished = false;
    constructor(widthPx, heightPx) {
        this.widthPx = widthPx;
        this.heightPx = heightPx;
        // 'deflate' 恰产出 zlib(RFC1950) 流——正是 PNG IDAT 的规范格式。
        const streams = new CompressionStream('deflate');
        this.writer = streams.writable.getWriter();
        const reader = streams.readable.getReader();
        // 并行泵：边写入边收集压缩输出（TransformStream 背压自动节流写入侧）。
        this.pump = (async () => {
            for (;;) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                if (value !== undefined) {
                    this.outputChunks.push(value instanceof Uint8Array ? value : new Uint8Array(value));
                }
            }
        })().catch((error) => {
            this.pumpError = error;
        });
    }
    /** 消费一片 canvas：逐行过滤（片级自适应过滤器）→ 单次 write 增量压缩。 */
    async pushTile(tile) {
        if (this.finished)
            throw new Error('png encoder already finished');
        const ctx = tile.getContext('2d', { willReadFrequently: true });
        if (ctx === null)
            throw new Error('no 2d context');
        const { data, width, height } = ctx.getImageData(0, 0, tile.width, tile.height);
        const bytesPerRow = width * 4;
        const filter = pickTileFilter(data, width, height, this.carriedPrev);
        const out = new Uint8Array((bytesPerRow + 1) * height);
        let at = 0;
        for (let y = 0; y < height; y += 1) {
            out[at] = filter;
            at += 1;
            const rowStart = y * bytesPerRow;
            if (y === 0) {
                applyFilter(filter, data, rowStart, bytesPerRow, this.carriedPrev, 0, out, at);
            }
            else {
                applyFilter(filter, data, rowStart, bytesPerRow, data, rowStart - bytesPerRow, out, at);
            }
            at += bytesPerRow;
        }
        // 携带本片最后一行原始字节：下一片首行的 Up/Paeth 过滤需要真实上一行。
        this.carriedPrev = data.slice((height - 1) * bytesPerRow, height * bytesPerRow);
        // 写入可能因压缩流内部故障或背压永不释放而挂起：超时兜底。
        await withTimeout(this.writer.write(out), 'PNG 压缩写入超时');
    }
    /** 中止编码：放弃剩余输出并释放压缩流（异常/取消路径的清理出口）。 */
    async abort() {
        if (this.finished)
            return;
        this.finished = true;
        try {
            await this.writer.abort(new Error('png encoder aborted'));
        }
        catch {
            // writer 可能已被取消/关闭：吞掉，泵侧统一收敛。
        }
        await this.pump.catch(() => undefined);
    }
    /** 关闭压缩流并组装完整 PNG Blob。 */
    async finish() {
        if (this.finished)
            throw new Error('png encoder already finished');
        this.finished = true;
        let closeError;
        try {
            await withTimeout(this.writer.close(), 'PNG 压缩流关闭超时');
        }
        catch (error) {
            closeError = error;
        }
        await withTimeout(this.pump, 'PNG 压缩输出超时');
        if (this.pumpError !== undefined)
            throw this.pumpError;
        if (closeError !== undefined)
            throw closeError;
        const parts = [PNG_SIGNATURE, pngChunk('IHDR', ihdrBytes(this.widthPx, this.heightPx))];
        for (const chunk of this.outputChunks)
            parts.push(pngChunk('IDAT', chunk));
        parts.push(pngChunk('IEND', new Uint8Array(0)));
        return new Blob(parts, { type: 'image/png' });
    }
}
// ---------------------------------------------------------------------------
// PDF 组装与下载
// ---------------------------------------------------------------------------
/**
 * 组装最小多页 PDF：每页一张 JPEG（能力吸收自 dsh-conv-export 的 buildPdf）。
 * @param pages 按顺序的页面载荷。
 * @returns PDF 文件字节。
 */
function buildRasterPdf(pages) {
    const enc = new TextEncoder();
    const chunks = [];
    let offset = 0;
    const offsets = [];
    const push = (data) => {
        const bytes = typeof data === 'string' ? enc.encode(data) : data;
        chunks.push(bytes);
        offset += bytes.length;
    };
    const beginObj = (num) => {
        offsets[num] = offset;
        push(`${num} 0 obj\n`);
    };
    const endObj = () => push('endobj\n');
    const count = pages.length;
    push('%PDF-1.4\n');
    beginObj(1);
    push('<< /Type /Catalog /Pages 2 0 R >>\n');
    endObj();
    beginObj(2);
    const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
    push(`<< /Type /Pages /Kids [${kids}] /Count ${count} >>\n`);
    endObj();
    pages.forEach((page, i) => {
        const pageNum = 3 + i * 3;
        const imgNum = pageNum + 1;
        const contentNum = pageNum + 2;
        const wPt = (page.widthPx * 0.75).toFixed(2);
        const hPt = (page.heightPx * 0.75).toFixed(2);
        beginObj(pageNum);
        push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wPt} ${hPt}] ` +
            `/Resources << /XObject << /Im0 ${imgNum} 0 R >> >> /Contents ${contentNum} 0 R >>\n`);
        endObj();
        beginObj(imgNum);
        push(`<< /Type /XObject /Subtype /Image /Width ${page.widthPx * IMAGE_SCALE} ` +
            `/Height ${page.heightPx * IMAGE_SCALE} /ColorSpace /DeviceRGB /BitsPerComponent 8 ` +
            `/Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`);
        push(page.jpeg);
        push('\nendstream\n');
        endObj();
        const stream = `q\n${wPt} 0 0 ${hPt} 0 0 cm\n/Im0 Do\nQ\n`;
        beginObj(contentNum);
        push(`<< /Length ${stream.length} >>\nstream\n${stream}endstream\n`);
        endObj();
    });
    const total = 2 + count * 3;
    const xrefAt = offset;
    push(`xref\n0 ${total + 1}\n0000000000 65535 f \n`);
    for (let n = 1; n <= total; n += 1) {
        push(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
    }
    push(`trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);
    const out = new Uint8Array(offset);
    let at = 0;
    for (const chunk of chunks) {
        out.set(chunk, at);
        at += chunk.length;
    }
    return out;
}
/** 触发客户端文件下载。 */
function download(filename, mime, data) {
    const blob = new Blob([data], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
}
/** 取消信号已触发时抛出 AbortError（分片循环的检查点）。 */
function throwIfAborted(signal) {
    if (signal?.aborted) {
        throw new DOMException('导出已取消', 'AbortError');
    }
}
/**
 * 逐片迭代舞台窗口：按 TILE_CSS_HEIGHT 分片，产出每片的 (offset, height)。
 */
async function* iterTiles(stage, signal) {
    const total = Math.ceil(stage.totalHeight / TILE_CSS_HEIGHT);
    for (let index = 0; index < total; index += 1) {
        throwIfAborted(signal);
        const offset = index * TILE_CSS_HEIGHT;
        yield { offset, height: Math.min(TILE_CSS_HEIGHT, stage.totalHeight - offset), index, total };
    }
}
/**
 * 导出为 PNG 长图：分片光栅 + 流式 PNG 编码 → 单张纵向长图下载。
 * PNG 规范无高度上限，超长对话不再被截断（产品上限见 MAX_TOTAL_CSS_HEIGHT）。
 * 无 CompressionStream 的环境退回旧的单 canvas 截断路径。
 * @param html 服务端打印 HTML（完整文档）。
 * @param fileName 下载文件名（含扩展名）。
 * @throws 运行环境无法光栅化/编码时抛出；取消信号触发 AbortError。
 */
async function exportLongPng(html, fileName, options) {
    if (typeof CompressionStream === 'undefined') {
        await exportLongPngLegacy(html, fileName, options);
        return;
    }
    const stage = await RasterStage.create(html, options);
    const encoder = new StreamingPngEncoder(stage.width * IMAGE_SCALE, stage.totalHeight * IMAGE_SCALE);
    try {
        for await (const piece of iterTiles(stage, options?.signal)) {
            const tile = await stage.tile(piece.offset, piece.height);
            await encoder.pushTile(tile);
            options?.onProgress?.(piece.index + 1, piece.total);
        }
        download(fileName, 'image/png', await encoder.finish());
    }
    catch (error) {
        // 异常/取消路径同样要释放压缩流，否则 writable 保持锁定、缓冲滞留。
        await encoder.abort().catch(() => undefined);
        throw error;
    }
    finally {
        stage.dispose();
    }
}
/** 旧路径降级：单 canvas 光栅化（截断至 LEGACY_MAX_HEIGHT）+ toBlob。 */
async function exportLongPngLegacy(html, fileName, options) {
    const stage = await RasterStage.create(html, options);
    try {
        throwIfAborted(options?.signal);
        const height = Math.min(stage.totalHeight, LEGACY_MAX_HEIGHT);
        if (stage.truncated || height < stage.totalHeight)
            options?.onTruncated?.();
        const canvas = await stage.tile(0, height);
        download(fileName, 'image/png', await canvasToBlob(canvas, 'image/png'));
    }
    finally {
        stage.dispose();
    }
}
/**
 * 导出为免打印多页 PDF：分片光栅 → 按页切片 → JPEG → 自包含 PDF 下载。
 * 片高为页高整数倍，页界与片界对齐（页永不跨片）；页数无上限。
 * 全程无打印对话框，应用标签页永不冻结。
 * @param html 服务端打印 HTML（完整文档）。
 * @param fileName 下载文件名（含扩展名）。
 * @throws 运行环境无法光栅化时抛出；取消信号触发 AbortError。
 */
async function exportRasterPdf(html, fileName, options) {
    const stage = await RasterStage.create(html, options);
    try {
        const pages = [];
        const pageCount = Math.ceil(stage.totalHeight / PAGE_CSS_HEIGHT);
        let done = 0;
        for await (const piece of iterTiles(stage, options?.signal)) {
            const tile = await stage.tile(piece.offset, piece.height);
            // 切页：片内按 A4 页高切片（末页取余量）。
            for (let y = 0; y < piece.height; y += PAGE_CSS_HEIGHT) {
                const pageCssHeight = Math.min(PAGE_CSS_HEIGHT, piece.height - y);
                const sliceDevH = pageCssHeight * IMAGE_SCALE;
                const yDev = y * IMAGE_SCALE;
                const slice = document.createElement('canvas');
                slice.width = tile.width;
                slice.height = sliceDevH;
                const ctx = slice.getContext('2d');
                if (ctx === null)
                    throw new Error('no 2d context');
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, slice.width, sliceDevH);
                ctx.drawImage(tile, 0, yDev, tile.width, sliceDevH, 0, 0, tile.width, sliceDevH);
                const jpeg = await canvasToBlob(slice, 'image/jpeg', 0.92);
                pages.push({
                    jpeg: new Uint8Array(await jpeg.arrayBuffer()),
                    widthPx: IMAGE_WIDTH,
                    heightPx: Math.ceil(sliceDevH / IMAGE_SCALE),
                });
                done += 1;
                options?.onProgress?.(done, pageCount);
            }
        }
        download(fileName, 'application/pdf', buildRasterPdf(pages));
    }
    finally {
        stage.dispose();
    }
}


/**
 * dsh-longshot —— 会话长图导出（浏览器半）。
 *
 * 本文件与 src/raster.js 一起被 scripts/build-client.mjs 内联进
 * `window.__ModuleLoader__.load({ id, factory })` 工厂闭包：factory 里只有
 * `require` 可用（platform seed 表），所以全部依赖都必须是 require('react')
 * 这一级的基座模块，资源一律内联，不引入任何 CSS module / 构建期变换。
 *
 * 入口：官方 chat 插件的 `conversation.chat.assistant-actions` 槽——也就是每条
 * 助手消息下面那排「复制 / 点赞 / 分享」图标所在的位置。点击后弹出面板，
 * 面板里勾选要导出的回合（默认只勾「用户输入 + 最终回答」），再光栅成一张 PNG。
 */

const React = require('react')
const h = React.createElement

/** 单条消息操作区里的触发按钮（与图标按钮同一行，字号最小化以免抢戏）。 */
const TRIGGER_STYLE = {
  display: 'inline-flex',
  alignItems: 'center',
  height: '24px',
  padding: '0 8px',
  borderRadius: '6px',
  border: '1px solid var(--dsh-color-border, rgba(128, 128, 128, 0.32))',
  background: 'transparent',
  color: 'inherit',
  fontFamily: 'inherit',
  fontSize: '11px',
  lineHeight: '1',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  opacity: 0.85,
}
const TRIGGER_HOVER_STYLE = {
  ...TRIGGER_STYLE,
  background: 'rgba(128, 128, 128, 0.16)',
  borderColor: 'rgba(128, 128, 128, 0.55)',
  opacity: 1,
}

/** 面板配色（跟随深色主题；浅色主题下仍可读）。 */
const UI = {
  layer: 'position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;'
    + 'background:rgba(0,0,0,0.46);backdrop-filter:blur(1px);',
  panel: 'width:560px;max-width:calc(100vw - 32px);max-height:calc(100vh - 64px);display:flex;flex-direction:column;'
    + 'box-sizing:border-box;padding:22px 24px 16px;border-radius:14px;border:1px solid rgba(255,255,255,0.12);'
    + 'background:#242529;color:#e9eaee;box-shadow:0 18px 48px rgba(0,0,0,0.45);'
    + 'font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;',
  title: 'margin:0 0 6px;font-size:16px;font-weight:650;letter-spacing:0.2px;',
  hint: 'margin:0 0 14px;font-size:12.5px;line-height:1.6;color:#9aa1ab;',
  row: 'display:flex;align-items:center;gap:9px;padding:6px 0;font-size:13px;cursor:pointer;',
  checkbox: 'width:15px;height:15px;margin:0;accent-color:#4c8dff;cursor:pointer;flex:none;',
  widthRow: 'display:flex;align-items:center;gap:10px;margin:8px 0 0;font-size:13px;',
  select: 'flex:1;height:30px;padding:0 9px;border-radius:8px;border:1px solid rgba(255,255,255,0.16);'
    + 'background:#1c1d21;color:#e9eaee;font-family:inherit;font-size:12.5px;',
  turnBox: 'margin-top:12px;border:1px solid rgba(255,255,255,0.10);border-radius:10px;overflow:hidden;',
  turnBar: 'display:flex;align-items:center;gap:8px;padding:8px 10px;background:rgba(255,255,255,0.045);'
    + 'font-size:12px;color:#a7adb6;',
  turnCount: 'margin-left:auto;font-variant-numeric:tabular-nums;',
  mini: 'height:24px;padding:0 9px;border-radius:6px;border:1px solid rgba(255,255,255,0.16);'
    + 'background:transparent;color:#d6d9de;font-family:inherit;font-size:11.5px;cursor:pointer;',
  list: 'max-height:246px;overflow-y:auto;padding:4px 0;',
  item: 'display:flex;align-items:flex-start;gap:9px;padding:7px 10px;cursor:pointer;',
  itemChecked: 'display:flex;align-items:flex-start;gap:9px;padding:7px 10px;cursor:pointer;'
    + 'background:rgba(76,141,255,0.10);',
  who: 'flex:none;font-size:10.5px;font-weight:600;padding:1px 7px;border-radius:999px;margin-top:1px;',
  whoUser: 'background:#1f3358;color:#8fb6ff;',
  whoAnswer: 'background:#173a2a;color:#7ee0a8;',
  whoStep: 'background:#3a2d12;color:#ffc46b;',
  whoContext: 'background:#2b2f36;color:#98a2ae;',
  preview: 'flex:1;font-size:12px;line-height:1.45;color:#c7ccd3;overflow:hidden;display:-webkit-box;'
    + '-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word;',
  previewMuted: 'flex:1;font-size:12px;line-height:1.45;color:#8d949e;overflow:hidden;display:-webkit-box;'
    + '-webkit-line-clamp:1;-webkit-box-orient:vertical;word-break:break-word;',
  status: 'min-height:20px;margin:12px 0 2px;font-size:12px;line-height:1.5;color:#a7adb6;word-break:break-word;',
  footer: 'display:flex;justify-content:flex-end;gap:10px;margin-top:10px;',
  ghost: 'height:32px;padding:0 15px;border-radius:8px;border:1px solid rgba(255,255,255,0.18);'
    + 'background:transparent;color:#d6d9de;font-family:inherit;font-size:13px;cursor:pointer;',
  primary: 'height:34px;padding:0 18px;border-radius:8px;border:1px solid #3f7ef0;background:#3f7ef0;'
    + 'color:#fff;font-family:inherit;font-size:13px;font-weight:600;cursor:pointer;'
    + 'box-shadow:0 2px 10px rgba(63,126,240,0.35);transition:background 0.12s ease,border-color 0.12s ease,'
    + 'box-shadow 0.12s ease;',
  primaryHover: 'height:34px;padding:0 18px;border-radius:8px;border:1px solid #5b93f7;background:#5b93f7;'
    + 'color:#fff;font-family:inherit;font-size:13px;font-weight:600;cursor:pointer;'
    + 'box-shadow:0 3px 14px rgba(63,126,240,0.5);transition:background 0.12s ease,border-color 0.12s ease,'
    + 'box-shadow 0.12s ease;',
  // 禁用态是「实心灰」，而不是给主按钮打半透明——半透明看起来像加载中/不可点击，
  // 容易让人以为「导出」坏了。
  primaryDisabled: 'height:34px;padding:0 18px;border-radius:8px;'
    + 'border:1px solid rgba(255,255,255,0.10);background:#31343a;color:#7f858f;'
    + 'font-family:inherit;font-size:13px;font-weight:600;cursor:not-allowed;box-shadow:none;',
  disabled: 'opacity:0.55;cursor:default;',
}

/** 版式宽度候选。 */
const WIDTH_OPTIONS = [
  { value: '720', label: '窄（720 px）' },
  { value: '900', label: '标准（900 px）— 推荐' },
  { value: '1080', label: '宽（1080 px）' },
]

/** 回合类型 → 徽章文案与配色。 */
const KIND_META = {
  user: { label: '用户', style: UI.whoUser },
  answer: { label: '回答', style: UI.whoAnswer },
  step: { label: '后台', style: UI.whoStep },
  context: { label: '上下文', style: UI.whoContext },
}

/** 面板单例：避免重复点击开出多层。 */
let openLayer = null

/**
 * 客户端插件入口：把「长图」注册进每条消息的操作区。
 * @param ctx 客户端 Cordis 上下文。
 */
function apply(ctx) {
  ctx.effect(() => ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
    name: 'conversation.chat.assistant-actions',
    id: 'longshot-export',
    order: 40,
  }, LongshotAction)), 'dsh-longshot: message action')
}

/**
 * 消息级触发按钮。slot 注入 { messageId, text, sessionId }。
 * @param props React props。
 * @returns 按钮元素。
 */
function LongshotAction({ sessionId, text }) {
  const [hover, setHover] = React.useState(false)
  return h('button', {
    type: 'button',
    title: '把选中的消息导出成一张纵向 PNG 长图',
    style: hover ? TRIGGER_HOVER_STYLE : TRIGGER_STYLE,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    onClick: (event) => {
      event?.preventDefault?.()
      event?.stopPropagation?.()
      openPanel(sessionId, typeof text === 'string' ? flattenWhitespace(text) : '')
    },
  }, '长图')
}

/**
 * 压平空白（与 Host 的预览口径一致，用于定位「当前这条」）。
 * @param text 原始文本。
 * @returns 单行文本。
 */
function flattenWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * 接口基址：同源页面用相对路径，非 HTTP 载体尝试 shell 提供的 transport。
 * @returns 前缀（可能为空串）。
 */
function apiBase() {
  if (typeof location !== 'undefined' && /^https?:$/.test(location.protocol))
    return ''
  const transport = typeof window !== 'undefined' ? window.__DSH_TRANSPORT__ : undefined
  return transport !== undefined && typeof transport.streamBaseUrl === 'string'
    ? transport.streamBaseUrl.replace(/\/+$/, '')
    : ''
}

/**
 * 后台类回合（后台步骤 / 注入上下文）。
 * @param kind 回合类型。
 * @returns 是否后台类。
 */
function isBackground(kind) {
  return kind === 'step' || kind === 'context'
}

/**
 * 在回合清单里定位触发按钮所属的消息：预览被截断时按前缀匹配。
 * @param turns 回合清单。
 * @param currentText 当前消息纯文本（已压平）。
 * @returns 回合下标，未命中为 -1。
 */
function indexOfCurrent(turns, currentText) {
  if (currentText === '')
    return -1
  const head = currentText.slice(0, 60)
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]
    if (turn.role !== 'assistant')
      continue
    const flat = flattenWhitespace(turn.preview).replace(/…$/, '')
    if (flat === '')
      continue
    if (currentText.startsWith(flat) || flat.startsWith(head))
      return index
  }
  return -1
}

/**
 * 打开导出面板。
 * @param sessionId 当前会话 id。
 * @param currentText 触发按钮所在消息的纯文本（用于默认勾选）。
 */
function openPanel(sessionId, currentText) {
  if (openLayer !== null) {
    openLayer.focus()
    return
  }
  const doc = document
  const options = { timestamps: true, redact: false, includeBackground: false, compact: true, width: '900' }
  /** 全部回合（null = 还在加载）。 */
  let turns = null
  /** 选中回合的原始下标。 */
  const selected = new Set()
  /** 是否显示/允许选择后台类回合。 */
  let includeBackground = false
  let busy = false
  /** 是否已成功导出（成功后主按钮变成「已导出」并保持禁用态）。 */
  let finished = false
  /** 主按钮是否处于悬停态。 */
  let hoverRun = false
  let currentIndex = -1

  const layer = doc.createElement('div')
  layer.setAttribute('style', UI.layer)
  const panel = doc.createElement('div')
  panel.setAttribute('style', UI.panel)
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-label', '导出长图')

  const title = doc.createElement('h2')
  title.setAttribute('style', UI.title)
  title.textContent = '导出长图'
  const hint = doc.createElement('p')
  hint.setAttribute('style', UI.hint)
  hint.textContent = '默认只导出「用户输入 + 最终回答」。后台步骤（边思考边调工具）和宿主注入的上下文默认隐藏——它们往往占掉大半个篇幅。'
  panel.append(title, hint)

  const addCheckbox = (key, label, initial, onChange) => {
    const row = doc.createElement('label')
    row.setAttribute('style', UI.row)
    const box = doc.createElement('input')
    box.type = 'checkbox'
    box.setAttribute('style', UI.checkbox)
    box.checked = initial
    box.addEventListener('change', () => {
      options[key] = box.checked
      onChange?.(box.checked)
    })
    const text = doc.createElement('span')
    text.textContent = label
    row.append(box, text)
    panel.append(row)
    return box
  }
  addCheckbox('timestamps', '保留时间戳', true)
  addCheckbox('redact', '隐私脱敏（手机号 / 邮箱 / 身份证 / API Key / JWT）', false)
  const backgroundToggle = addCheckbox('includeBackground', '包含后台步骤与注入上下文', false, (checked) => {
    includeBackground = checked
    // 关掉开关时，把后台类回合从选择里摘掉，避免「看不见却被导出」。
    if (!checked) {
      for (const turn of turns ?? []) {
        if (isBackground(turn.kind))
          selected.delete(turn.index)
      }
    }
    renderTurns()
    if (turns !== null) {
      const hidden = turns.filter((turn) => isBackground(turn.kind)).length
      setStatus(checked
        ? `已显示全部 ${turns.length} 条；后台/上下文会按紧凑行渲染。`
        : `已隐藏 ${hidden} 条后台/上下文。`)
    }
  })
  addCheckbox('compact', '后台/上下文回合压成一行（勾错也不至于撑爆长图）', true)

  const widthRow = doc.createElement('div')
  widthRow.setAttribute('style', UI.widthRow)
  const widthLabel = doc.createElement('span')
  widthLabel.textContent = '版式宽度'
  const select = doc.createElement('select')
  select.setAttribute('style', UI.select)
  for (const item of WIDTH_OPTIONS) {
    const option = doc.createElement('option')
    option.value = item.value
    option.textContent = item.label
    if (item.value === options.width)
      option.selected = true
    select.append(option)
  }
  select.addEventListener('change', () => {
    options.width = select.value
  })
  widthRow.append(widthLabel, select)
  panel.append(widthRow)

  // 回合勾选区块。
  const turnBox = doc.createElement('div')
  turnBox.setAttribute('style', UI.turnBox)
  const turnBar = doc.createElement('div')
  turnBar.setAttribute('style', UI.turnBar)
  const turnLabel = doc.createElement('span')
  turnLabel.textContent = '导出范围'
  const countLabel = doc.createElement('span')
  countLabel.setAttribute('style', UI.turnCount)
  countLabel.textContent = '加载中…'
  const mkMini = (label, handler) => {
    const button = doc.createElement('button')
    button.type = 'button'
    button.setAttribute('style', UI.mini)
    button.textContent = label
    button.addEventListener('click', handler)
    return button
  }
  const onlyCurrent = mkMini('仅本条', () => {
    if (turns === null)
      return
    selected.clear()
    if (currentIndex >= 0)
      selected.add(turns[currentIndex].index)
    renderTurns()
  })
  const selectAll = mkMini('全选', () => {
    for (const turn of visibleTurns())
      selected.add(turn.index)
    renderTurns()
  })
  const selectNone = mkMini('全不选', () => {
    selected.clear()
    renderTurns()
  })
  turnBar.append(turnLabel, onlyCurrent, selectAll, selectNone, countLabel)
  const list = doc.createElement('div')
  list.setAttribute('style', UI.list)
  turnBox.append(turnBar, list)
  panel.append(turnBox)

  const status = doc.createElement('div')
  status.setAttribute('style', UI.status)
  status.textContent = '读取消息列表…'
  panel.append(status)

  const footer = doc.createElement('div')
  footer.setAttribute('style', UI.footer)
  const cancel = doc.createElement('button')
  cancel.type = 'button'
  cancel.setAttribute('style', UI.ghost)
  cancel.textContent = '取消'
  const run = doc.createElement('button')
  run.type = 'button'
  run.setAttribute('style', UI.primaryDisabled)
  run.textContent = '导出'
  run.disabled = true
  footer.append(cancel, run)
  panel.append(footer)
  layer.append(panel)
  doc.body.append(layer)
  openLayer = layer

  const setStatus = (text, tone) => {
    status.textContent = text
    status.style.color = tone === 'error' ? '#ff8f8f' : tone === 'ok' ? '#7ee0a8' : tone === 'warn' ? '#ffc46b' : '#a7adb6'
  }
  /**
   * 主按钮的唯一状态出口：可点时是亮蓝 + 数量，不可点时是实心灰。
   * 以前这里只在 setBusy 里改样式，勾选恢复后按钮仍带着 disabled 的
   * 半透明样式，看起来像「点不动」——正是用户反馈的那个误解。
   */
  const syncRun = () => {
    const count = selected.size
    const enabled = !busy && !finished && count > 0
    run.disabled = !enabled
    run.textContent = busy ? '导出中…' : finished ? '已导出' : count > 0 ? `导出 ${count} 条` : '导出'
    run.setAttribute('style', !enabled
      ? UI.primaryDisabled
      : hoverRun ? UI.primaryHover : UI.primary)
    cancel.disabled = busy
    cancel.setAttribute('style', busy ? `${UI.ghost};${UI.disabled}` : UI.ghost)
  }
  const setBusy = (next) => {
    busy = next
    syncRun()
  }
  run.addEventListener('mouseenter', () => {
    if (!run.disabled) {
      hoverRun = true
      syncRun()
    }
  })
  run.addEventListener('mouseleave', () => {
    hoverRun = false
    syncRun()
  })
  const close = () => {
    if (busy)
      return
    doc.removeEventListener('keydown', onKeyDown, true)
    layer.remove()
    openLayer = null
  }
  const onKeyDown = (event) => {
    if (event.key === 'Escape' && !busy)
      close()
  }
  cancel.addEventListener('click', close)
  layer.addEventListener('click', (event) => {
    if (event.target === layer)
      close()
  })
  doc.addEventListener('keydown', onKeyDown, true)

  /** 当前可见的回合（后台类是否显示取决于开关）。 */
  function visibleTurns() {
    if (turns === null)
      return []
    return includeBackground ? turns : turns.filter((turn) => !isBackground(turn.kind))
  }

  /** 重画回合列表与计数。 */
  function renderTurns() {
    list.replaceChildren()
    const rows = visibleTurns()
    if (rows.length === 0) {
      countLabel.textContent = '0 / 0'
      run.disabled = true
      return
    }
    for (const turn of rows) {
      const checked = selected.has(turn.index)
      const meta = KIND_META[turn.kind] ?? KIND_META.answer
      const row = doc.createElement('label')
      row.setAttribute('style', checked ? UI.itemChecked : UI.item)
      const box = doc.createElement('input')
      box.type = 'checkbox'
      box.setAttribute('style', UI.checkbox)
      box.checked = checked
      box.addEventListener('change', () => {
        if (box.checked)
          selected.add(turn.index)
        else
          selected.delete(turn.index)
        renderTurns()
      })
      const who = doc.createElement('span')
      who.setAttribute('style', `${UI.who}${meta.style}`)
      who.textContent = meta.label
      const preview = doc.createElement('span')
      preview.setAttribute('style', isBackground(turn.kind) ? UI.previewMuted : UI.preview)
      const toolText = Array.isArray(turn.tools) && turn.tools.length > 0 ? `［${turn.tools.join('、')}］ ` : ''
      preview.textContent = `${toolText}${turn.preview}`
      row.append(box, who, preview)
      list.append(row)
    }
    countLabel.textContent = `已选 ${selected.size} / ${turns.length}`
    syncRun()
    const visibleIndex = currentIndex >= 0 ? rows.findIndex((turn) => turn.index === turns[currentIndex].index) : -1
    if (visibleIndex >= 0)
      list.children[visibleIndex]?.scrollIntoView?.({ block: 'nearest' })
  }

  const start = async () => {
    if (busy || selected.size === 0)
      return
    setBusy(true)
    setStatus('正在渲染…')
    try {
      const response = await fetch(`${apiBase()}/longshot/render`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          turns: [...selected].sort((a, b) => a - b),
          ...options,
          width: Number(options.width),
        }),
      })
      const raw = await response.text()
      let payload
      try {
        payload = JSON.parse(raw)
      } catch {
        payload = undefined
      }
      if (!response.ok || payload === undefined || typeof payload.html !== 'string')
        throw new Error(payload?.error ?? `接口返回 ${response.status}`)
      setStatus(`正在生成图片…（${payload.stats.turns} 条消息）`)
      await exportLongPng(payload.html, payload.fileName, {
        width: payload.stats.width,
        onProgress: (done, total) => {
          setStatus(`正在生成图片… ${done}/${total}`)
        },
        onTruncated: () => {
          setStatus('内容超出长图上限，超出部分已截断：请减少勾选或改用更窄的版式。', 'warn')
        },
      })
      setStatus(`已导出：${payload.fileName}`, 'ok')
      busy = false
      finished = true
      cancel.textContent = '完成'
      syncRun()
      window.setTimeout(() => {
        if (openLayer === layer) {
          doc.removeEventListener('keydown', onKeyDown, true)
          layer.remove()
          openLayer = null
        }
      }, 1200)
    } catch (error) {
      setBusy(false)
      setStatus(error instanceof Error ? error.message : String(error), 'error')
    }
  }
  run.addEventListener('click', () => {
    void start()
  })

  // 拉回合清单：默认只勾「用户输入 + 最终回答」；点的是后台消息则自动放开开关。
  void (async () => {
    try {
      const response = await fetch(`${apiBase()}/longshot/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || !Array.isArray(payload.turns)) {
        throw new Error(response.status === 404
          ? 'Host 半还是旧版本（缺 /longshot/turns）：请重启一次应用'
          : (payload?.error ?? `接口返回 ${response.status}`))
      }
      turns = payload.turns
      currentIndex = indexOfCurrent(turns, currentText)
      const clicked = currentIndex >= 0 ? turns[currentIndex] : undefined
      if (clicked !== undefined && isBackground(clicked.kind)) {
        includeBackground = true
        backgroundToggle.checked = true
        options.includeBackground = true
      }
      if (clicked !== undefined) {
        selected.add(clicked.index)
      } else {
        for (const turn of turns) {
          if (!isBackground(turn.kind))
            selected.add(turn.index)
        }
      }
      renderTurns()
      const hidden = turns.filter((turn) => isBackground(turn.kind)).length
      setStatus(clicked !== undefined
        ? `已定位到当前消息（${KIND_META[clicked.kind]?.label ?? '消息'}）；另有 ${hidden} 条后台/上下文默认隐藏。`
        : `没定位到当前消息，已默认勾选全部正文（${selected.size} 条）；另有 ${hidden} 条后台/上下文已隐藏。`)
    } catch (error) {
      turns = []
      renderTurns()
      setStatus(error instanceof Error ? error.message : String(error), 'error')
    }
  })()
}

exports.apply = apply
exports.inject = ['slots']

    return module.exports;
  }
});
