/**
 * VerifEye - Shared Image Decode Front-End
 *
 * Produces the two views every analysis needs from a raw file buffer:
 *
 *   imageData  - downscaled working buffer, bounded so a hover stays interactive
 *   nativeData - an 8-pixel-aligned centre crop at TRUE sensor resolution
 *
 * The distinction is not cosmetic. Rescaling resamples every pixel, which erases the
 * Bayer demosaicing lattice and shifts the JPEG block grid off its original phase, so
 * any analyzer reading those from a scaled buffer measures the resize rather than the
 * image. Holding the crop to multiples of 8 preserves the original DCT boundaries.
 *
 * Lives here rather than in the service worker because the extension background, the
 * studio worker, and the benchmark harness all need identical behaviour -- if they
 * decoded differently, their numbers would not be comparable.
 *
 * Requires OffscreenCanvas and createImageBitmap, so this is a browser-side module.
 */

export function isDecodeSupported() {
    return typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap !== 'undefined';
}

/**
 * @param {ArrayBuffer} arrayBuffer  the raw encoded file
 * @param {Object} options           {deepScan, maxDimension, maxCrop}
 */
export async function decodeImage(arrayBuffer, options = {}) {
    const blob = new Blob([arrayBuffer]);
    const bitmap = await createImageBitmap(blob);

    try {
        return decodeBitmap(bitmap, options);
    } finally {
        if (typeof bitmap.close === 'function') bitmap.close();
    }
}

/**
 * Same contract as decodeImage, for callers that already hold a decoded bitmap
 * (an <img> element on the studio page, for instance). Does not close the bitmap.
 */
export function decodeBitmap(bitmap, options = {}) {
    const sourceDimensions = { width: bitmap.width, height: bitmap.height };

    // A deep scan may spend more time in exchange for more evidence.
    const maxDimension = options.maxDimension || (options.deepScan ? 768 : 384);

    let targetWidth = bitmap.width;
    let targetHeight = bitmap.height;
    let wasResampled = false;

    if (targetWidth > maxDimension || targetHeight > maxDimension) {
        const scale = Math.min(maxDimension / targetWidth, maxDimension / targetHeight);
        targetWidth = Math.max(32, Math.round(targetWidth * scale));
        targetHeight = Math.max(32, Math.round(targetHeight * scale));
        wasResampled = true;
    }

    const canvas = new OffscreenCanvas(targetWidth, targetHeight);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
    const imageData = ctx.getImageData(0, 0, targetWidth, targetHeight);

    const nativeData = extractNativeCrop(bitmap, options.maxCrop || 256);

    return { imageData, nativeData, wasResampled, sourceDimensions };
}

/**
 * Centre crop at 1:1 pixel scale, with dimensions and offsets both multiples of 8.
 * Returns null when the source is too small for the crop to be worth taking.
 */
export function extractNativeCrop(bitmap, maxCrop = 256) {
    if (bitmap.width < 64 || bitmap.height < 64) return null;

    const cropWidth = Math.min(maxCrop, bitmap.width) & ~7;
    const cropHeight = Math.min(maxCrop, bitmap.height) & ~7;
    if (cropWidth < 64 || cropHeight < 64) return null;

    const offsetX = Math.floor((bitmap.width - cropWidth) / 2) & ~7;
    const offsetY = Math.floor((bitmap.height - cropHeight) / 2) & ~7;

    const canvas = new OffscreenCanvas(cropWidth, cropHeight);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    // Source rect equals destination rect, so no resampling filter runs.
    ctx.drawImage(bitmap, offsetX, offsetY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
    return ctx.getImageData(0, 0, cropWidth, cropHeight);
}
