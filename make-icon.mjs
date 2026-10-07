/**
 * 生成 Windows .ico 图标。
 * 不引第三方图形库：手写 BMP(BITMAPINFOHEADER + XOR/AND 掩码) 打包进 ICO 容器。
 * 单例脚本，跑完即弃。
 */
import { writeFileSync, mkdirSync } from 'node:fs';

// BeatForge 配色：深色底 + 橙红渐变（与 index.html 骨架屏一致）
const BG = [0x14, 0x10, 0x0e];        // #0e1014
const ACCENT_A = [0xff, 0x8c, 0x3a]; // #ff8c3a
const ACCENT_B = [0xff, 0x5f, 0x6d]; // #ff5f6d

/** 画一个尺寸为 size 的图标像素（返回 RGBA 数组） */
function drawIcon(size) {
  const px = new Uint8Array(size * size * 4);

  // 圆角矩形遮罩
  const radius = size * 0.22;
  const inRounded = (x, y) => {
    const nx = x < radius ? radius - x : x >= size - radius ? x - (size - radius) + radius : radius;
    const ny = y < radius ? radius - y : y >= size - radius ? y - (size - radius) + radius : radius;
    if (x >= radius && x < size - radius) return true;
    if (y >= radius && y < size - radius) return true;
    return nx * nx + ny * ny <= radius * radius;
  };

  // 三根音柱（像均衡器/波形），高度递增
  const bars = [
    { cx: 0.28, halfW: 0.075, top: 0.62, bottom: 0.34 },
    { cx: 0.5, halfW: 0.075, top: 0.30, bottom: 0.34 },
    { cx: 0.72, halfW: 0.075, top: 0.48, bottom: 0.34 },
  ];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (!inRounded(x, y)) {
        px[i + 3] = 0; // 透明
        continue;
      }
      // 底色带垂直渐变
      const t = y / size;
      let r = BG[0], g = BG[1], b = BG[2];

      for (const bar of bars) {
        const x0 = (bar.cx - bar.halfW) * size;
        const x1 = (bar.cx + bar.halfW) * size;
        const y0 = bar.top * size;
        const y1 = bar.bottom * size;
        if (x >= x0 && x <= x1 && y >= y0 && y <= y1) {
          // 柱内横向渐变，从橙到红
          const bt = (x - x0) / (x1 - x0);
          r = Math.round(ACCENT_A[0] + (ACCENT_B[0] - ACCENT_A[0]) * bt);
          g = Math.round(ACCENT_A[1] + (ACCENT_B[1] - ACCENT_A[1]) * bt);
          b = Math.round(ACCENT_A[2] + (ACCENT_B[2] - ACCENT_A[2]) * bt);
          break;
        }
      }

      px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
    }
  }
  return px;
}

/**
 * 生成 BMP 像素数据（ICO 内嵌格式）。
 * 结构：BITMAPINFOHEADER(40) + BGRA 像素(自下而上) + AND 掩码(1bpp)
 */
function bmpFor(px, size) {
  const headerSize = 40;
  const pixelDataSize = size * size * 4;
  const maskRowSize = Math.ceil(size / 32) * 4;   // 1bpp，每行按 4 字节对齐
  const maskSize = maskRowSize * size;
  const dataSize = headerSize + pixelDataSize + maskSize;

  const buf = Buffer.alloc(dataSize);

  // BITMAPINFOHEADER
  buf.writeUInt32LE(headerSize, 0);
  buf.writeInt32LE(size, 4);          // 宽
  buf.writeInt32LE(size * 2, 8);      // 高：XOR + AND 掩码，故为 2 倍
  buf.writeUInt16LE(1, 12);           // 平面数
  buf.writeUInt16LE(32, 14);          // 位深 32（含 alpha）
  buf.writeUInt32LE(0, 16);           // 压缩 BI_RGB
  buf.writeUInt32LE(pixelDataSize + maskSize, 20);
  buf.writeInt32LE(0, 24);            // xppm
  buf.writeInt32LE(0, 28);            // yppm
  buf.writeUInt32LE(0, 32);           // 调色板数
  buf.writeUInt32LE(0, 36);           // 重要颜色数

  // 像素数据：BGRA，自下而上
  let off = headerSize;
  for (let y = size - 1; y >= 0; y--) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      buf[off++] = px[i + 2];         // B
      buf[off++] = px[i + 1];         // G
      buf[off++] = px[i];             // R
      buf[off++] = px[i + 3];         // A
    }
  }

  // AND 掩码：alpha 为 0 的像素置 1
  const maskStart = off;
  for (let y = size - 1; y >= 0; y--) {
    let bit = 0;
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (px[i + 3] === 0) {
        buf[maskStart + y * maskRowSize + (bit >> 3)] |= 0x80 >> (bit & 7);
      }
      bit++;
    }
  }

  return buf;
}

// ---- 组装 ICO ----
// ICO 头(6) + N 个目录项(16) + N 份 BMP 数据
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const images = SIZES.map((s) => ({ size: s, data: bmpFor(drawIcon(s), s) }));

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);      // 保留
header.writeUInt16LE(1, 2);      // 类型 1 = icon
header.writeUInt16LE(images.length, 4);

const dirSize = 16 * images.length;
let offset = 6 + dirSize;

const dir = Buffer.alloc(dirSize);
images.forEach((img, i) => {
  const o = i * 16;
  dir[o] = img.size >= 256 ? 0 : img.size;   // 宽（256 记为 0）
  dir[o + 1] = img.size >= 256 ? 0 : img.size; // 高
  dir[o + 2] = 0;                              // 调色板数
  dir[o + 3] = 0;                              // 保留
  dir.writeUInt16LE(1, o + 4);                 // 平面
  dir.writeUInt16LE(32, o + 6);                // 位深
  dir.writeUInt32LE(img.data.length, o + 8);
  dir.writeUInt32LE(offset, o + 12);
  offset += img.data.length;
});

mkdirSync('build', { recursive: true });
const ico = Buffer.concat([header, dir, ...images.map((i) => i.data)]);
writeFileSync('build/icon.ico', ico);

console.log('图标已生成: build/icon.ico');
console.log('尺寸: ' + SIZES.join(', ') + '  位深: 32bit RGBA');
console.log('文件大小: ' + (ico.length / 1024).toFixed(1) + ' KB');
