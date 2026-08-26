/**
 * 从已批准品牌资产生成构建图标：
 * - 16–64px 使用 A 方案核心图标；
 * - 128/256px 使用带 provisional 标识的 C3 院标底纹扩展；
 * - 1024px PNG 使用 C3 大尺寸数字界面资产。
 *
 * 不安装依赖，不重新描摹或缩放品牌母版。
 */
import { copyFile, mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const brandRoot = join(root, 'src', 'renderer', 'public', 'brand')
const coreDir = join(brandRoot, 'production-v1.0', 'app-icon')
const c3Dir = join(brandRoot, 'provisional', 'c3-institute-v0.2')
const outDir = join(root, 'build')
const outPng = join(outDir, 'icon.png')
const outIco = join(outDir, 'icon.ico')
const icoSizes = [16, 20, 24, 32, 48, 64, 128, 256]

function encodePngIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)

  const directory = Buffer.alloc(entries.length * 16)
  let offset = header.length + directory.length
  entries.forEach(({ size, png }, index) => {
    const entryOffset = index * 16
    directory.writeUInt8(size === 256 ? 0 : size, entryOffset)
    directory.writeUInt8(size === 256 ? 0 : size, entryOffset + 1)
    directory.writeUInt8(0, entryOffset + 2)
    directory.writeUInt8(0, entryOffset + 3)
    directory.writeUInt16LE(1, entryOffset + 4)
    directory.writeUInt16LE(32, entryOffset + 6)
    directory.writeUInt32LE(png.length, entryOffset + 8)
    directory.writeUInt32LE(offset, entryOffset + 12)
    offset += png.length
  })

  return Buffer.concat([header, directory, ...entries.map(({ png }) => png)])
}

async function main() {
  await mkdir(outDir, { recursive: true })
  await copyFile(join(c3Dir, 'xiaogui-app-icon-c3-institute-provisional-1024.png'), outPng)

  const entries = await Promise.all(
    icoSizes.map(async (size) => ({
      size,
      png: await readFile(
        size >= 128
          ? join(c3Dir, `xiaogui-app-icon-c3-institute-provisional-${size}.png`)
          : join(coreDir, `xiaogui-app-icon-${size}.png`),
      ),
    })),
  )
  await writeFile(outIco, encodePngIco(entries))

  console.log('Wrote', outPng, '(C3 provisional 1024px)')
  console.log('Wrote', outIco, '(core 16–64px; C3 provisional 128/256px)')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
