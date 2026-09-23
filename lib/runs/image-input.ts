import sharp from 'sharp'

export const IMAGE_INPUT_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'] as const
const MAX_BYTES = 10 * 1024 * 1024
const MAX_PIXELS = 25_000_000

/** Decode uploads before sending them to a visual reader. Discard metadata. */
export async function prepareImageInput(bytes: Buffer, extension: string): Promise<{
  bytes: Buffer
  mediaType: 'image/png'
  width: number
  height: number
}> {
  if (!IMAGE_INPUT_EXTENSIONS.some(value => value === extension)) throw new Error('Supported image formats: PNG, JPEG and WebP.')
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('Images must be non-empty and no larger than 10 MB.')
  try {
    const decoder = sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: 'warning' })
    const metadata = await decoder.metadata()
    const expected = extension === '.jpg' || extension === '.jpeg' ? 'jpeg' : extension.slice(1)
    if (metadata.format !== expected) throw new Error('format')
    if ((metadata.pages ?? 1) !== 1) throw new Error('animation')
    // Preserve resolution: silently shrinking a diagram can erase its labels.
    const { data, info } = await decoder.rotate().png().toBuffer({ resolveWithObject: true })
    if (data.length > MAX_BYTES) throw new Error('size')
    return { bytes: data, mediaType: 'image/png', width: info.width, height: info.height }
  } catch {
    throw new Error('Image could not be read. Use a valid, single-frame PNG, JPEG or WebP under 25 megapixels; the decoded PNG must fit within 10 MB.')
  }
}
