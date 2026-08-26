// Generate packaging/nex.ico from the DOS Rebel wordmark (first letter N as
// the icon motif is too small; we use a full "N" glyph block on accent bg).
// Pure Node/Bun script using zero deps: writes a valid multi-size .ico
// containing 32bpp BGRA PNGs (Vista+ supports PNG-compressed entries).
//
// Usage: bun packaging/make-icon.ts
import { writeFileSync } from "node:fs"

const W = 64
const H = 64

// Simple raster of "N" in DOS-Rebel-ish blocks, 8x8 grid scaled to 64px.
const GLYPH: string[] = [
  "██....██",
  "███...██",
  "████..██",
  "██.█.███",
  "██..████",
  "██...███",
  "██....██",
  "██....██",
]

function pixel(x: number, y: number): [number, number, number, number] {
  const gx = Math.floor((x / W) * 8)
  const gy = Math.floor((y / H) * 8)
  if (GLYPH[gy]?.[gx] === "█") return [0x88, 0xf5, 0xd4, 0xff] // accent-ish teal (BGRA)
  // background: near-black
  return [0x10, 0x14, 0x18, 0xff]
}

// Build raw BGRA bitmap (bottom-up)
const raw = Buffer.alloc(W * H * 4)
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const [b, g, r, a] = pixel(x, H - 1 - y) // bottom-up
    const o = (y * W + x) * 4
    raw[o] = b
    raw[o + 1] = g
    raw[o + 2] = r
    raw[o + 3] = a
  }
}

// AND mask (1bpp, all zeros = fully opaque per alpha)
const maskRowBytes = Math.ceil(W / 32) * 4
const mask = Buffer.alloc(maskRowBytes * H)

function pngOf(size: number): Buffer {
  // Downscale by nearest neighbor into RGBA top-down, then encode minimal PNG.
  const rgba = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = Math.floor((x / size) * W)
      const sy = Math.floor((y / size) * H)
      const so = ((H - 1 - sy) * W + sx) * 4 // raw is bottom-up
      const o = (y * size + x) * 4
      rgba[o] = raw[so + 2]
      rgba[o + 1] = raw[so + 1]
      rgba[o + 2] = raw[so]
      rgba[o + 3] = raw[so + 3]
    }
  }
  return encodePng(rgba, size, size)
}

// ---- minimal PNG encoder (no deps) ----
import { deflateSync } from "node:zlib"
function crc32(buf: Buffer): number {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const t = Buffer.from(type, "ascii")
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])))
  return Buffer.concat([len, t, data, crc])
}
function encodePng(rgba: Buffer, w: number, h: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  const stride = w * 4
  const rawImg = Buffer.alloc((stride + 1) * h)
  for (let y = 0; y < h; y++) {
    rawImg[y * (stride + 1)] = 0 // filter none
    rgba.copy(rawImg, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(rawImg)),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

// ---- ICO container with one 64x64 PNG entry + raw BMP entry for compat ----
const png64 = pngOf(64)
const png32 = pngOf(32)
const png16 = pngOf(16)

function bmpEntry(size: number): Buffer {
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8) // height counts XOR+AND
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  const rowBytes = size * 4
  const xor = Buffer.alloc(rowBytes * size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = Math.floor((x / size) * W)
      const sy = Math.floor((y / size) * H)
      const so = ((H - 1 - sy) * W + sx) * 4
      const o = (y * size + x) * 4
      xor[o] = raw[so] // B
      xor[o + 1] = raw[so + 1]
      xor[o + 2] = raw[so + 2]
      xor[o + 3] = raw[so + 3]
    }
  }
  const mRow = Math.ceil(size / 32) * 4
  const andMask = Buffer.alloc(mRow * size)
  return Buffer.concat([header, xor, andMask])
}

const images = [bmpEntry(32), bmpEntry(16), png64, png32, png16]
const count = images.length
const dirSize = 6 + count * 16
let offset = dirSize
const dir = Buffer.alloc(dirSize)
dir.writeUInt16LE(0, 0)
dir.writeUInt16LE(1, 2) // type icon
dir.writeUInt16LE(count, 4)
offset = dirSize

interface Sized {
  buf: Buffer
  size: number
  isPng: boolean
}
const sized: Sized[] = [
  { buf: images[0]!, size: 32, isPng: false },
  { buf: images[1]!, size: 16, isPng: false },
  { buf: images[2]!, size: 64, isPng: true },
  { buf: images[3]!, size: 32, isPng: true },
  { buf: images[4]!, size: 16, isPng: true },
]
sized.forEach((item, i) => {
  const e = 6 + i * 16
  dir[e] = item.size === 256 ? 0 : item.size
  dir[e + 1] = 0
  dir[e + 2] = 0
  dir[e + 3] = 0
  dir.writeUInt16LE(1, e + 4)
  dir.writeUInt16LE(item.isPng ? 32 : 32, e + 6) // bpp
  dir.writeUInt32LE(item.buf.length, e + 8)
  dir.writeUInt32LE(offset, e + 12)
  offset += item.buf.length
})

const ico = Buffer.concat([dir, ...sized.map((s) => s.buf)])
writeFileSync(new URL("./nex.ico", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), ico)
console.log(`nex.ico written (${ico.length} bytes, ${count} images)`)
