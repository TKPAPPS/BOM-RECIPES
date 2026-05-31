/**
 * Tiny image helpers shared by every Recipe Book view.
 * Mirrors the logic already used in WhereUsedPage / IngredientRow.
 *
 * Three input shapes are accepted (in priority order):
 *   1. Already a `data:image/...` URI → returned as-is.
 *   2. An http(s):// URL → returned as-is (the browser fetches it).
 *   3. A raw base64 payload (no prefix) coming from Odoo's image_*
 *      fields → wrapped with the right data-URI prefix.  Detected by
 *      length + base64 charset to avoid mis-wrapping a plain string.
 */

// Loose guard: the string only contains valid base64 characters
// (a-z A-Z 0-9 + / =) and is long enough to plausibly be an image
// payload.  Stops us from mis-wrapping a short label / file path as
// a "raw base64 image".
function looksLikeRawBase64(s: string): boolean {
  return s.length >= 100 && /^[A-Za-z0-9+/=\s]+$/.test(s);
}

export function getImageSrc(url: string | null | boolean | undefined): string | null {
  if (!url || url === 'false' || typeof url !== 'string') return null;
  const v = url.trim();
  if (!v) return null;
  if (v.startsWith('data:image'))  return v;
  if (/^https?:\/\//i.test(v))     return v;
  if (looksLikeRawBase64(v)) {
    const isJpeg = v.startsWith('/9j/');
    return `data:image/${isJpeg ? 'jpeg' : 'png'};base64,${v}`;
  }
  // Anything else (local file paths, garbage, empty-after-trim) is
  // intentionally rejected — the browser cannot render it and the
  // <img> would just produce a console-spammy 404.
  return null;
}

/**
 * Coerce a value to a finite number. Handles postgres `numeric` columns
 * which the pg driver returns as strings (e.g. "744.10") by default.
 */
export const toNum = (v: unknown): number | null => {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

export const fmtMoney = (n: number | string | null | undefined): string => {
  const num = toNum(n);
  return num != null
    ? new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(num)
    : '—';
};

export const fmtQty = (n: number | string | null | undefined, digits = 2): string => {
  const num = toNum(n);
  return num != null
    ? new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(num)
    : '—';
};

/**
 * Read an uploaded image File as a data: URI, transparently
 * downscaling oversized photos so we never reject the user but
 * also never POST a 20 MB body to the server.
 *
 * Behaviour:
 *   • file ≤ softLimitBytes (default 1.5 MB)  → read as-is so PNGs
 *     with transparency / GIFs / small JPEGs keep their bytes.
 *   • file >  softLimitBytes                  → decode in a canvas,
 *     scale longest side to maxDim, re-encode as JPEG at the given
 *     quality.  A phone photo (~4–6 MB, 4000+ px) becomes ~300 KB
 *     while staying visually crisp.
 *
 * Throws on decode failure so the caller can toast a clear error.
 */
export async function readImageFileSmart(
  file: File,
  opts: { maxDim?: number; jpegQuality?: number; softLimitBytes?: number } = {},
): Promise<string> {
  const maxDim         = opts.maxDim         ?? 1920;
  const jpegQuality    = opts.jpegQuality    ?? 0.88;
  const softLimitBytes = opts.softLimitBytes ?? 1_500_000;

  // Small files — read as-is to preserve format + metadata.
  if (file.size <= softLimitBytes) {
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload  = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('Could not read the file.'));
      reader.readAsDataURL(file);
    });
  }

  // Large files — decode, scale, re-encode as JPEG.
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload  = () => resolve(el);
      el.onerror = () => reject(new Error('The file does not look like a valid image.'));
      el.src = objectUrl;
    });

    let w = img.naturalWidth;
    let h = img.naturalHeight;
    const scale = Math.min(1, maxDim / Math.max(w, h));
    if (scale < 1) { w = Math.round(w * scale); h = Math.round(h * scale); }

    const canvas = document.createElement('canvas');
    canvas.width  = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser cannot resize the image — please pick a smaller one.');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);

    return canvas.toDataURL('image/jpeg', jpegQuality);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
