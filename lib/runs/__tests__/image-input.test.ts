import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { prepareImageInput } from '../image-input'

describe('image input decoding', () => {
  it.each(['png', 'jpeg', 'webp'] as const)('decodes %s without changing diagram resolution', async format => {
    const bytes = await sharp({ create: { width: 40, height: 20, channels: 3, background: 'white' } }).toFormat(format).toBuffer()
    const image = await prepareImageInput(bytes, `.${format}`)
    expect(image).toMatchObject({ mediaType: 'image/png', width: 40, height: 20 })
    expect((await sharp(image.bytes).metadata()).format).toBe('png')
  })
  it('rejects misleading extensions and corrupt image data', async () => {
    const jpeg = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'white' } }).jpeg().toBuffer()
    await expect(prepareImageInput(jpeg, '.png')).rejects.toThrow('could not be read')
    await expect(prepareImageInput(Buffer.from('not an image'), '.jpg')).rejects.toThrow('could not be read')
  })
  it('rejects oversized files before decoding', async () => {
    await expect(prepareImageInput(Buffer.alloc(10 * 1024 * 1024 + 1), '.png')).rejects.toThrow('10 MB')
  })
})
