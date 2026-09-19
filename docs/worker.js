/**
 * VerifEye Studio - Analysis Worker
 *
 * The whole forensic pipeline runs here, off the main thread. A 2D FFT over several
 * 128x128 tiles plus a kurtosis pass plus a recompression round trip is tens of
 * milliseconds of straight-line arithmetic; on the main thread that is dropped frames
 * on every scroll and hover while an analysis is in flight.
 *
 * The page hands over a raw ArrayBuffer and gets back a verdict and a real spectrum.
 * Decoding happens here too, so the transfer is one buffer rather than several
 * megabytes of RGBA.
 */

import { runLocalForensicEnsemble } from './forensics/ensemble.js';
import { decodeImage } from './forensics/decode.js';
import { computeRecompressionResidual, isRecompressionSupported } from './forensics/recompress.js';

self.onmessage = async (event) => {
    const { id, arrayBuffer, sensitivity, deepScan } = event.data;

    try {
        const started = performance.now();

        const decoded = await decodeImage(arrayBuffer, { deepScan: true });

        // The studio always pays for true ELA: it is a deliberate single-image
        // inspection, not a hover, so a few extra milliseconds buy a better answer.
        let residual = null;
        if (isRecompressionSupported()) {
            const recompressed = await computeRecompressionResidual(decoded.imageData, { quality: 0.90 });
            residual = recompressed ? recompressed.residual : null;
        }

        const result = runLocalForensicEnsemble(arrayBuffer, decoded.imageData, {
            sensitivity: sensitivity || 'balanced',
            nativeData: decoded.nativeData,
            wasResampled: decoded.wasResampled,
            includeSpectrum: true,
            residual
        });

        result.sourceDimensions = decoded.sourceDimensions;
        result.analyzedDimensions = { width: decoded.imageData.width, height: decoded.imageData.height };
        result.nativeCropAvailable = !!decoded.nativeData;
        result.wallClockMs = Number((performance.now() - started).toFixed(2));

        // Lift the spectrum out of `result` before posting. Listing a buffer in the
        // transfer list while the same buffer is still reachable from the cloned
        // message throws DataCloneError, so it travels as its own top-level field.
        const spectrum = result.signals?.fft?.spectrum || null;
        if (result.signals?.fft) result.signals.fft.spectrum = null;

        const transfer = spectrum ? [spectrum.data.buffer] : [];
        self.postMessage({ id, ok: true, result, spectrum }, transfer);
    } catch (error) {
        self.postMessage({ id, ok: false, error: error?.message || 'Analysis failed' });
    }
};
