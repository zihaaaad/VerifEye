/**
 * VerifEye - Metadata & Provenance Analyzer
 * Inspects binary image chunks (PNG, JPEG, WebP, XMP, EXIF, C2PA)
 * for AI generation tags, prompt parameters, and authentic camera signatures.
 */

export function analyzeMetadata(arrayBuffer) {
    const result = {
        detected: false,
        isAi: false,
        isCamera: false,
        confidence: 0,
        generator: null,
        details: [],
        rawSignatures: []
    };

    if (!arrayBuffer || arrayBuffer.byteLength < 16) return result;

    const bytes = new Uint8Array(arrayBuffer);

    // Format detection and chunk traversal
    if (isPng(bytes)) {
        parsePngMetadata(bytes, result);
    } else if (isJpeg(bytes)) {
        parseJpegMetadata(bytes, result);
    } else if (isWebP(bytes)) {
        parseWebpMetadata(bytes, result);
    }

    // Binary text scan across header and metadata space (up to 128KB)
    scanBinaryForAiSignatures(bytes, result);

    return result;
}

function isPng(bytes) {
    return bytes.length >= 8 &&
           bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47 &&
           bytes[4] === 0x0D && bytes[5] === 0x0A && bytes[6] === 0x1A && bytes[7] === 0x0A;
}

function isJpeg(bytes) {
    return bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xD8;
}

function isWebP(bytes) {
    return bytes.length >= 12 &&
           bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
           bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
}

/**
 * Scan PNG chunks for tEXt, iTXt, zTXt, and C2PA
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

        if (type === 'tEXt' || type === 'iTXt' || type === 'zTXt') {
            const chunkData = bytes.subarray(dataOffset, dataOffset + length);
            const text = decoder.decode(chunkData);
            checkTextForSignatures(text, result, 'PNG ' + type);
            checkExifCameraSignatures(text, result);
        }

        // C2PA manifest chunk in PNG
        if (type === 'caDX' || type === 'caVP' || type === 'c2pa') {
            setAiResult(result, 'C2PA Manifest Container', 0.99, 'PNG ' + type);
        }

        if (type === 'IEND') break;
        offset = nextChunk;
    }
}

/**
 * Scan JPEG APP1/APP2/APP3/COM segments
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

        if (marker === 0xE1 || marker === 0xE2 || marker === 0xE3 || marker === 0xFE) { // APP1 (Exif/XMP), APP2, APP3, COM
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

        if (type === 'EXIF' || type === 'XMP ' || type === 'ICCP') {
            const chunkData = bytes.subarray(dataOffset, dataOffset + length);
            const text = decoder.decode(chunkData);
            checkTextForSignatures(text, result, 'WebP ' + type);
            checkExifCameraSignatures(text, result);
        }

        offset = nextChunk;
    }
}

/**
 * Scan binary buffer for signature keywords across header and metadata
 */
function scanBinaryForAiSignatures(bytes, result) {
    const sampleSize = Math.min(bytes.length, 131072); // First 128KB
    const headerBytes = bytes.subarray(0, sampleSize);
    const decoder = new TextDecoder('utf-8', { fatal: false });
    const text = decoder.decode(headerBytes);

    checkTextForSignatures(text, result, 'Binary Header Scan');
    checkExifCameraSignatures(text, result);
}

function checkTextForSignatures(text, result, source) {
    if (!text) return;
    const lower = text.toLowerCase();

    // 1. C2PA / Content Credentials Standard Manifests (Adobe, Microsoft, OpenAI, Google, Truepic)
    if (lower.includes('c2pa.created') ||
        lower.includes('trainedalgorithmicmedia') ||
        lower.includes('contentcredentials.org') ||
        lower.includes('c2pa.claim') ||
        lower.includes('http://cv.iptc.org/newscodes/digitalsourcetype/trainedalgorithmicmedia') ||
        lower.includes('c2pa.actions') && lower.includes('c2pa.ai_generated')) {
        setAiResult(result, 'C2PA Synthetic Media Manifest (Trained Algorithmic Media)', 1.00, source);
        return;
    }

    // 2. Stable Diffusion / Automatic1111 / WebUI-Forge / Fooocus / SD.Next / SwarmUI
    if (lower.includes('negative prompt:') ||
        (lower.includes('steps:') && lower.includes('sampler:') && lower.includes('cfg scale:')) ||
        (lower.includes('hires upscale:') || lower.includes('denoising strength:')) && lower.includes('model:')) {
        setAiResult(result, 'Stable Diffusion / WebUI Parameters', 0.99, source);
        return;
    }

    // 3. ComfyUI / Node-based Diffusion Graphs
    if (lower.includes('comfyui') ||
        lower.includes('ksampler') ||
        lower.includes('"class_type": "checkpointloadersimple"') ||
        lower.includes('"class_type": "emptylatentimage"') ||
        lower.includes('"class_type": "vaedecode"')) {
        setAiResult(result, 'ComfyUI Workflow Metadata', 0.99, source);
        return;
    }

    // 4. Flux.1 / Black Forest Labs
    if (lower.includes('flux.1') || lower.includes('flux-schnell') || lower.includes('flux-dev') || lower.includes('black forest labs') || lower.includes('flux_guidance')) {
        setAiResult(result, 'Flux.1 Generation Provenance (Black Forest Labs)', 0.99, source);
        return;
    }

    // 5. Midjourney
    if (lower.includes('midjourney') ||
        (lower.includes('--v 4') || lower.includes('--v 5') || lower.includes('--v 6') || lower.includes('--v 6.1') || lower.includes('--niji') || lower.includes('--ar ') || lower.includes('--stylize ') || lower.includes('--sref '))) {
        setAiResult(result, 'Midjourney Generation Parameters', 0.98, source);
        return;
    }

    // 6. DALL-E / OpenAI / ChatGPT
    if (lower.includes('dall·e') || lower.includes('dall-e') ||
        (lower.includes('openai') && (lower.includes('prompt') || lower.includes('generation') || lower.includes('image_generator')))) {
        setAiResult(result, 'DALL-E / OpenAI Provenance', 0.99, source);
        return;
    }

    // 7. Adobe Firefly / Generative Fill
    if (lower.includes('adobe firefly') || lower.includes('adobe generative fill') || lower.includes('generative fill')) {
        setAiResult(result, 'Adobe Firefly / Generative Fill Metadata', 0.98, source);
        return;
    }

    // 8. Ideogram AI
    if (lower.includes('ideogram') || lower.includes('ideogram.ai')) {
        setAiResult(result, 'Ideogram AI Generation Metadata', 0.98, source);
        return;
    }

    // 9. Leonardo AI / Alchemy
    if (lower.includes('leonardo.ai') || lower.includes('leonardo-diffusion') || lower.includes('alchemy refinement')) {
        setAiResult(result, 'Leonardo AI Metadata', 0.98, source);
        return;
    }

    // 10. NovelAI
    if (lower.includes('novelai') || lower.includes('nai diffusion') || lower.includes('smea') || lower.includes('dyn:')) {
        setAiResult(result, 'NovelAI Generation Parameters', 0.99, source);
        return;
    }

    // 11. Google Imagen / SynthID
    if (lower.includes('synthid') || lower.includes('google imagen') || lower.includes('deepmind imagen')) {
        setAiResult(result, 'Google Imagen / SynthID Provenance', 0.99, source);
        return;
    }

    // 12. Bing Image Creator / Microsoft Designer
    if (lower.includes('bing image creator') || lower.includes('designer.microsoft.com') || lower.includes('ms-designer')) {
        setAiResult(result, 'Bing / Microsoft Designer Signature', 0.98, source);
        return;
    }

    // 13. Recraft AI
    if (lower.includes('recraft.ai') || lower.includes('recraft vector/raster')) {
        setAiResult(result, 'Recraft AI Metadata', 0.98, source);
        return;
    }

    // 14. SeaArt / Civitai
    if (lower.includes('civitai.com') || lower.includes('civitai:')) {
        setAiResult(result, 'Civitai Model Signature', 0.95, source);
        return;
    }
}

function checkExifCameraSignatures(text, result) {
    if (result.isCamera) return;

    // Authentic physical camera and smartphone makers
    const cameraMakers = [
        'canon', 'nikon', 'sony', 'fujifilm', 'leica', 'panasonic', 'olympus',
        'hasselblad', 'apple', 'samsung', 'google', 'xiaomi', 'huawei', 'oneplus',
        'dji', 'gopro', 'pentax', 'sigma', 'ricoh', 'motorola'
    ];

    const lower = text.toLowerCase();

    for (const maker of cameraMakers) {
        if (lower.includes(maker)) {
            // Check for realistic camera EXIF tags
            const hasExifTags = lower.includes('exposuretime') ||
                                lower.includes('fnumber') ||
                                lower.includes('iso') ||
                                lower.includes('focallength') ||
                                lower.includes('shutter speed') ||
                                lower.includes('aperturevalue') ||
                                lower.includes('datetimeoriginal') ||
                                lower.includes('lensmodel');

            if (hasExifTags) {
                result.isCamera = true;
                const formattedMaker = maker.charAt(0).toUpperCase() + maker.slice(1);
                const detailStr = `Authentic EXIF camera metadata found (${formattedMaker})`;
                if (!result.details.includes(detailStr)) {
                    result.details.push(detailStr);
                }
                break;
            }
        }
    }
}

function setAiResult(result, generator, confidence, source) {
    result.detected = true;
    result.isAi = true;
    result.confidence = Math.max(result.confidence, confidence);
    result.generator = generator;
    const desc = `${generator} (${source})`;
    if (!result.details.includes(desc)) {
        result.details.push(desc);
    }
}
