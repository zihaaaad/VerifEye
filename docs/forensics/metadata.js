/**
 * VerifEye - Metadata & Provenance Analyzer
 * Inspects binary image chunks (PNG, JPEG, WebP, XMP, EXIF, C2PA)
 * for AI generation tags, prompt parameters, and camera signatures.
 */

export function analyzeMetadata(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const result = {
        detected: false,
        isAi: false,
        isCamera: false,
        confidence: 0,
        generator: null,
        details: [],
        rawSignatures: []
    };

    if (!bytes || bytes.length < 16) return result;

    // Detect format
    if (isPng(bytes)) {
        parsePngMetadata(bytes, result);
    } else if (isJpeg(bytes)) {
        parseJpegMetadata(bytes, result);
    } else if (isWebP(bytes)) {
        parseWebpMetadata(bytes, result);
    }

    // Binary text scan for embedded XMP / Prompts / C2PA strings
    scanBinaryForAiSignatures(bytes, result);

    return result;
}

function isPng(bytes) {
    return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47 &&
           bytes[4] === 0x0D && bytes[5] === 0x0A && bytes[6] === 0x1A && bytes[0x07] === 0x0A;
}

function isJpeg(bytes) {
    return bytes[0] === 0xFF && bytes[1] === 0xD8;
}

function isWebP(bytes) {
    return bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
           bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
}

/**
 * Scan PNG chunks for tEXt, iTXt, zTXt
 */
function parsePngMetadata(bytes, result) {
    let offset = 8;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const decoder = new TextDecoder('utf-8', { fatal: false });

    while (offset + 8 < bytes.length) {
        const length = view.getUint32(offset);
        const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
        const dataOffset = offset + 8;
        const nextChunk = dataOffset + length + 4; // +4 for CRC

        if (nextChunk > bytes.length) break;

        if (type === 'tEXt' || type === 'iTXt') {
            const chunkData = bytes.subarray(dataOffset, dataOffset + length);
            const text = decoder.decode(chunkData);
            checkTextForSignatures(text, result, 'PNG ' + type);
        }

        if (type === 'IEND') break;
        offset = nextChunk;
    }
}

/**
 * Scan JPEG APP1/APP2/COM segments
 */
function parseJpegMetadata(bytes, result) {
    let offset = 2;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const decoder = new TextDecoder('utf-8', { fatal: false });

    while (offset + 4 < bytes.length) {
        if (bytes[offset] !== 0xFF) {
            offset++;
            continue;
        }

        const marker = bytes[offset + 1];
        if (marker === 0xD9 || marker === 0xDA) break; // EOI or SOS

        // Skip standalone markers without length
        if (marker === 0x00 || (marker >= 0xD0 && marker <= 0xD7)) {
            offset += 2;
            continue;
        }

        const length = view.getUint16(offset + 2);
        const segData = bytes.subarray(offset + 4, offset + 2 + length);

        if (marker === 0xE1 || marker === 0xE2 || marker === 0xFE) { // APP1 (Exif/XMP), APP2, COM
            const text = decoder.decode(segData);
            checkTextForSignatures(text, result, 'JPEG APP' + (marker - 0xE0));
            checkExifCameraSignatures(text, result);
        }

        offset += 2 + length;
    }
}

/**
 * Scan WebP RIFF chunks
 */
function parseWebpMetadata(bytes, result) {
    let offset = 12;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const decoder = new TextDecoder('utf-8', { fatal: false });

    while (offset + 8 < bytes.length) {
        const type = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
        const length = view.getUint32(offset + 4, true);
        const dataOffset = offset + 8;
        const nextChunk = dataOffset + length + (length % 2);

        if (nextChunk > bytes.length) break;

        if (type === 'EXIF' || type === 'XMP ') {
            const chunkData = bytes.subarray(dataOffset, dataOffset + length);
            const text = decoder.decode(chunkData);
            checkTextForSignatures(text, result, 'WebP ' + type);
            checkExifCameraSignatures(text, result);
        }

        offset = nextChunk;
    }
}

/**
 * Scan binary buffer for signature keywords
 */
function scanBinaryForAiSignatures(bytes, result) {
    if (result.isAi) return;

    const sampleSize = Math.min(bytes.length, 65536); // Scan header & metadata space (first 64KB)
    const headerBytes = bytes.subarray(0, sampleSize);
    const decoder = new TextDecoder('utf-8', { fatal: false });
    const text = decoder.decode(headerBytes);

    checkTextForSignatures(text, result, 'Header Scan');
    checkExifCameraSignatures(text, result);
}

function checkTextForSignatures(text, result, source) {
    if (!text) return;
    const lower = text.toLowerCase();

    // 1. Stable Diffusion / Automatic1111 / ComfyUI / Fooocus / Forge
    if (lower.includes('negative prompt:') || (lower.includes('steps:') && lower.includes('sampler:') && lower.includes('cfg scale:'))) {
        setAiResult(result, 'Stable Diffusion / WebUI Parameters', 0.99, source);
        return;
    }
    if (lower.includes('comfyui') || lower.includes('ksampler') || lower.includes('"class_type": "checkpointloadersimple"')) {
        setAiResult(result, 'ComfyUI Workflow Metadata', 0.99, source);
        return;
    }
    if (lower.includes('novelai') || lower.includes('smea') || lower.includes('nai diffusion')) {
        setAiResult(result, 'NovelAI Generation Parameters', 0.99, source);
        return;
    }

    // 2. Midjourney
    if (lower.includes('midjourney') || (lower.includes('--v 5') || lower.includes('--v 6') || lower.includes('--ar ') || lower.includes('--chaos'))) {
        setAiResult(result, 'Midjourney Generation Parameters', 0.98, source);
        return;
    }

    // 3. DALL-E / OpenAI
    if (lower.includes('dall·e') || lower.includes('dall-e') || (lower.includes('openai') && (lower.includes('prompt') || lower.includes('generation')))) {
        setAiResult(result, 'DALL-E / OpenAI Provenance', 0.99, source);
        return;
    }

    // 4. C2PA / Content Credentials (Adobe Firefly, Google, Microsoft, OpenAI)
    if (lower.includes('c2pa.created') || lower.includes('trainedalgorithmicmedia') || lower.includes('contentcredentials.org')) {
        setAiResult(result, 'C2PA Synthetic Media Manifest (Trained Algorithmic Media)', 1.00, source);
        return;
    }

    // 5. Adobe Firefly
    if (lower.includes('adobe firefly') || lower.includes('firefly')) {
        setAiResult(result, 'Adobe Firefly Metadata', 0.98, source);
        return;
    }

    // 6. Bing Image Creator / Microsoft Designer
    if (lower.includes('bing image creator') || lower.includes('designer.microsoft')) {
        setAiResult(result, 'Bing / Microsoft Designer Signature', 0.98, source);
        return;
    }
}

function checkExifCameraSignatures(text, result) {
    if (result.isCamera) return;

    // Look for authentic physical camera maker / model / lens signatures
    const cameraMakers = ['canon', 'nikon', 'sony', 'fujifilm', 'leica', 'panasonic', 'olympus', 'hasselblad', 'apple', 'samsung'];
    const lower = text.toLowerCase();

    for (const maker of cameraMakers) {
        if (lower.includes(maker) && (lower.includes('exposuretime') || lower.includes('fnumber') || lower.includes('iso') || lower.includes('focal length'))) {
            result.isCamera = true;
            result.details.push(`Authentic EXIF camera data found (${maker.toUpperCase()})`);
            break;
        }
    }
}

function setAiResult(result, generator, confidence, source) {
    result.detected = true;
    result.isAi = true;
    result.confidence = confidence;
    result.generator = generator;
    result.details.push(`${generator} (${source})`);
}
