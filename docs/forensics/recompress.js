/**
 * VerifEye - JPEG Recompression Residual (true Error Level Analysis front-end)
 *
 * Genuine ELA re-encodes the image at a known quality and differences the result
 * against the original. Regions that arrived with a different compression history --
 * a splice, an inpainted patch, a regenerated face -- settle at a visibly different
 * error level than their surroundings. The blocking-index heuristic in ela.js
 * approximates this from a single decode; this module produces the real thing.
 *
 * Browser-only: it needs a JPEG encoder, which comes from OffscreenCanvas. Node test
 * runs skip it and ela.js falls back to the blocking-index path, so the analyzer
 * still returns a defined result everywhere.
 */

export function isRecompressionSupported() {
    return typeof OffscreenCanvas !== 'undefined' &&
           typeof createImageBitmap !== 'undefined' &&
           typeof OffscreenCanvas.prototype.convertToBlob === 'function';
}

/**
 * Re-encode `imageData` as JPEG at `quality` and return the per-pixel luminance
 * difference against the original.
 *
 * @returns {Promise<{residual: Float32Array, width: number, height: number, quality: number}|null>}
 *          null when the platform has no encoder, so callers can degrade rather than throw.
 */
export async function computeRecompressionResidual(imageData, options = {}) {
    if (!isRecompressionSupported() || !imageData) return null;

    const quality = options.quality ?? 0.90;
    const { width, height, data } = imageData;
    if (width < 16 || height < 16) return null;

    try {
        const source = new OffscreenCanvas(width, height);
        const sourceCtx = source.getContext('2d', { willReadFrequently: true });
        sourceCtx.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);

        const blob = await source.convertToBlob({ type: 'image/jpeg', quality });
        const bitmap = await createImageBitmap(blob);

        const round = new OffscreenCanvas(width, height);
        const roundCtx = round.getContext('2d', { willReadFrequently: true });
        roundCtx.drawImage(bitmap, 0, 0);
        const recompressed = roundCtx.getImageData(0, 0, width, height).data;

        if (typeof bitmap.close === 'function') bitmap.close();

        const residual = new Float32Array(width * height);
        for (let i = 0; i < width * height; i++) {
            const o = i * 4;
            const originalLum = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
            const roundLum = 0.299 * recompressed[o] + 0.587 * recompressed[o + 1] + 0.114 * recompressed[o + 2];
            residual[i] = Math.abs(originalLum - roundLum);
        }

        return { residual, width, height, quality };
    } catch (e) {
        // A tainted canvas or an unavailable encoder is a degradation, not a failure.
        return null;
    }
}
