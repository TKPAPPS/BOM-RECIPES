/**
 * recipeIOService.js
 *
 * Excel (xlsx) import / export for recipes.  Pure workbook logic only
 * — no database access lives here.  The route (routes/recipeIO.js)
 * owns DB resolution + persistence so this module stays unit-testable
 * and side-effect free.
 *
 * Layout (one row per ingredient; recipe-level fields appear on the
 * FIRST ingredient row of each recipe and are blank on the rest —
 * exactly like the sample screenshot the spec was based on):
 *
 *   IMAGE URL | Recipe Name | Recipe Reference Code | Recipe Type |
 *   Yield (kg) | Full Name | Description | Allergens | Spicy |
 *   Serving Suggestion | Servings | Total Weight (kg) |
 *   Ingredient | Ingredient Code | Qty for 1 kg | Waste % | Unit
 *
 * Export appends read-only columns (Cost/kg, Total Cost, Wholesale,
 * Retail, Version, Last Updated) which the importer simply ignores.
 */

const ExcelJS = require('exceljs');

// ── Brand palette (kept in sync with the client theme) ──────────────
const COLOR_HEADER_BG   = 'FF1F2A37'; // deep slate
const COLOR_HEADER_TEXT = 'FFCBAA6A'; // gold
const COLOR_READONLY_BG = 'FF6B7280'; // muted grey for info columns
const COLOR_BORDER      = 'FFD1D5DB';

// ── Canonical column definitions (single source of truth) ───────────
// group:    'recipe'   → recipe-level field, written on the first row only
//           'line'     → per-ingredient field, written on every row
//           'readonly' → export-only info column, ignored on import
// required: shown with a red ' *' suffix in the template header so the
//           user can tell at a glance what they MUST fill in.
// note:     optional cell-comment text attached to the header cell of
//           the template so the rule is reachable without flipping tabs.
const COLUMNS = [
  { key: 'image_url',          header: 'IMAGE URL',             width: 34, group: 'recipe',
    note: 'Optional. THREE ways: (1) Paste a public http(s) URL (right-click an online image → "Copy image address"). (2) Insert the picture INTO the cell — Excel: Insert → Pictures → "Picture in Cell". (3) Re-import a file the system exported (uploaded images round-trip automatically). Windows / Mac local file paths like "C:\\..." cannot be used — the browser blocks them.' },
  { key: 'name',               header: 'Recipe Name',           width: 26, group: 'recipe', required: true,
    note: 'Required. The recipe name shown across the system.' },
  { key: 'reference_code',     header: 'Recipe Reference Code', width: 20, group: 'recipe', required: true,
    note: 'Required. Unique SKU / code for the recipe (e.g. CKC-0018). Used to match an existing recipe on re-import.' },
  { key: 'recipe_type',        header: 'Recipe Type',           width: 14, group: 'recipe', required: true,
    note: 'Required. "base" = work-in-progress sub-recipe (Base Recipes list). "final" = sellable product (Final Products list).' },
  { key: 'yield_kg',           header: 'Yield (kg)',            width: 10, group: 'recipe',
    note: 'Optional. Total batch weight the ingredient quantities refer to. Defaults to 1.' },
  { key: 'full_name',          header: 'Full Name',             width: 24, group: 'recipe',
    note: 'Optional. Marketing / customer-facing name on the recipe card.' },
  { key: 'description',        header: 'Description',           width: 30, group: 'recipe',
    note: 'Optional. Short description shown on the recipe card.' },
  { key: 'allergens',          header: 'Allergens',             width: 22, group: 'recipe',
    note: 'Optional. Comma-separated list, e.g. "gluten, dairy, nuts".' },
  { key: 'is_spicy',           header: 'Spicy',                 width: 8,  group: 'recipe',
    note: 'Optional. Yes / No. Marks the dish as spicy on the recipe card.' },
  { key: 'serving_suggestion', header: 'Serving Suggestion',    width: 24, group: 'recipe',
    note: 'Optional. Free-text plating / heating note.' },
  { key: 'servings_count',     header: 'Servings',              width: 10, group: 'recipe',
    note: 'Optional. Number of portions the batch yields.' },
  { key: 'total_weight',       header: 'Total Weight (kg)',     width: 14, group: 'recipe',
    note: 'Optional. Finished / packed net weight (may differ from Yield once shrinkage is accounted for).' },
  { key: 'ingredient_name',    header: 'Ingredient',            width: 26, group: 'line',
    note: 'Optional helper text. The ingredient is actually linked by Ingredient Code below — this column is shown for human reference.' },
  { key: 'ingredient_code',    header: 'Ingredient Code',       width: 16, group: 'line', required: true,
    note: 'Required. Must match an existing item reference code (e.g. FRZ-0035). If any code is not found the WHOLE recipe is skipped.' },
  { key: 'quantity_kg',        header: 'Qty for 1 kg',          width: 13, group: 'line', required: true,
    note: 'Required. Quantity of this ingredient needed per 1 kg of recipe yield. Numbers only.' },
  { key: 'line_uom',           header: 'Unit',                  width: 8,  group: 'line',
    note: 'Optional. The unit of measure for the line — defaults to kg.' },
  // ── export-only info columns ──
  { key: 'cost_per_kg',        header: 'Cost / kg',             width: 11, group: 'readonly' },
  { key: 'total_cost',         header: 'Total Cost',            width: 12, group: 'readonly' },
  { key: 'wholesale_price',    header: 'Wholesale Price',       width: 14, group: 'readonly' },
  { key: 'retail_price',       header: 'Retail Price',          width: 13, group: 'readonly' },
  { key: 'version',            header: 'Version',               width: 8,  group: 'readonly' },
  { key: 'updated_at',         header: 'Last Updated',          width: 18, group: 'readonly' },
];

/**
 * Normalise a header string for fuzzy matching: lower-case and strip
 * everything that is not a letter or digit (keeps Unicode letters so
 * Hebrew headers survive).  "Recipe Refernce Code:" → "recipereferncecode".
 */
function normHeader(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

// Normalised header → canonical field key.  Includes the screenshot's
// misspellings ("refernce", "ingradients") and Hebrew labels so a
// file exported from this system OR hand-built from the sample both
// import cleanly.
const HEADER_ALIASES = {
  // image
  imageurl: 'image_url', image: 'image_url', img: 'image_url',
  picture: 'image_url', photo: 'image_url',
  תמונה: 'image_url', קישורתמונה: 'image_url',
  // recipe name
  recipename: 'name', name: 'name', recipe: 'name',
  שםמתכון: 'name', שם: 'name',
  // recipe reference code
  recipereferencecode: 'reference_code', recipereferncecode: 'reference_code',
  referencecode: 'reference_code', recipecode: 'reference_code',
  refcode: 'reference_code', code: 'reference_code',
  קודמתכון: 'reference_code', קוד: 'reference_code',
  // recipe type
  recipetype: 'recipe_type', type: 'recipe_type',
  סוג: 'recipe_type', סוגמתכון: 'recipe_type',
  // yield
  yieldkg: 'yield_kg', yield: 'yield_kg',
  תפוקה: 'yield_kg', תפוקהקג: 'yield_kg',
  // full name
  fullname: 'full_name', שםמלא: 'full_name',
  // description
  description: 'description', desc: 'description', תיאור: 'description',
  // allergens
  allergens: 'allergens', allergen: 'allergens',
  אלרגנים: 'allergens', אלרגן: 'allergens',
  // spicy
  spicy: 'is_spicy', isspicy: 'is_spicy', hot: 'is_spicy', חריף: 'is_spicy',
  // serving suggestion
  servingsuggestion: 'serving_suggestion', serving: 'serving_suggestion',
  הצעתהגשה: 'serving_suggestion',
  // servings count
  servingscount: 'servings_count', servings: 'servings_count',
  portions: 'servings_count', מנות: 'servings_count', מספרמנות: 'servings_count',
  // total weight
  totalweight: 'total_weight', totalweightkg: 'total_weight',
  netweight: 'total_weight', weight: 'total_weight',
  משקלכולל: 'total_weight', משקל: 'total_weight',
  // ingredient name
  ingredient: 'ingredient_name', ingredients: 'ingredient_name',
  ingradients: 'ingredient_name', ingredientname: 'ingredient_name',
  רכיב: 'ingredient_name', רכיבים: 'ingredient_name', שםרכיב: 'ingredient_name',
  // ingredient code — `ireferncecode` matches the misspelt
  // "I_Refernce Code:" header used in the source screenshot
  ireferencecode: 'ingredient_code', ireferncecode: 'ingredient_code',
  irefcode: 'ingredient_code', ingredientcode: 'ingredient_code',
  ingredientreferencecode: 'ingredient_code', componentcode: 'ingredient_code',
  קודרכיב: 'ingredient_code',
  // quantity
  qtyfor1kg: 'quantity_kg', qty: 'quantity_kg', quantity: 'quantity_kg',
  qtykg: 'quantity_kg', quantitykg: 'quantity_kg', amount: 'quantity_kg',
  כמות: 'quantity_kg', כמותל1קג: 'quantity_kg', כמותלקג: 'quantity_kg',
  // waste
  wastepct: 'waste_pct', waste: 'waste_pct', פחת: 'waste_pct', אחוזפחת: 'waste_pct',
  // unit
  lineuom: 'line_uom', uom: 'line_uom', unit: 'line_uom',
  יחידה: 'line_uom', יחידתמידה: 'line_uom',
};

// Truthy strings for the boolean "Spicy" column (EN + HE + symbols)
const TRUTHY = new Set(['1', 'true', 'yes', 'y', 't', 'x', '✓', 'כן', 'חריף', 'spicy']);

function parseBool(v) {
  if (v === true) return true;
  if (v === false || v == null) return false;
  return TRUTHY.has(String(v).trim().toLowerCase());
}

function parseNum(v) {
  if (v == null || v === '') return null;
  // ExcelJS may hand back a formula/result object for computed cells
  const raw = typeof v === 'object' && v !== null && 'result' in v ? v.result : v;
  const n = parseFloat(String(raw).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function cellText(v) {
  if (v == null) return '';
  // ExcelJS rich text / hyperlink / formula cell objects
  if (typeof v === 'object') {
    if ('text' in v && v.text != null) return String(v.text).trim();
    if ('hyperlink' in v && v.hyperlink) return String(v.hyperlink).trim();
    if ('result' in v && v.result != null) return String(v.result).trim();
    if ('richText' in v && Array.isArray(v.richText))
      return v.richText.map((r) => r.text).join('').trim();
  }
  return String(v).trim();
}

/**
 * Validate / classify an image-URL cell value.  The browser can only
 * render an http(s) URL or a data: URI — anything else (most often a
 * Windows / macOS local file path the user pasted in) gets stripped
 * and surfaced as a soft warning so the user knows WHY their image
 * didn't show up, instead of seeing a broken image in the UI.
 *
 * @returns {{ url: string|null, warning: string|null }}
 */
function classifyImageUrl(text) {
  if (!text) return { url: null, warning: null };
  if (/^https?:\/\//i.test(text))   return { url: text, warning: null };
  if (/^data:image\//i.test(text))  return { url: text, warning: null };
  // Heuristic for a local filesystem path — Windows (C:\, \\share),
  // POSIX (/Users/..., /home/...), or file:// URIs.
  const looksLocal = /^([a-zA-Z]:[\\/]|\\\\|file:\/\/|\/(?:Users|home|var|tmp|mnt)\/)/i.test(text);
  const preview = text.length > 60 ? text.slice(0, 57) + '…' : text;
  return {
    url: null,
    warning: looksLocal
      ? `Image "${preview}" is a local file path. The browser cannot load files from your computer's disk for security reasons. Either (a) paste a public http(s) URL, or (b) insert the picture directly into the IMAGE URL cell from Excel (Insert → Pictures → "Picture in Cell").`
      : `Image "${preview}" is not a valid URL. Use a public http(s) link, or insert the picture into the cell from Excel.`,
  };
}

function splitAllergens(v) {
  return cellText(v)
    .split(/[,;،、|/]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Parse an uploaded .xlsx buffer into structured recipe drafts.
 *
 * @param {Buffer} buffer
 * @returns {Promise<{ recipes: Array, fatalError: string|null }>}
 *   Each recipe: {
 *     rowNumber, name, reference_code, recipe_type, yield_kg,
 *     full_name, description, image_url, allergens, is_spicy,
 *     serving_suggestion, servings_count, total_weight,
 *     lines: [{ rowNumber, code, name, quantity_kg, waste_pct, line_uom }]
 *   }
 */
async function parseRecipeWorkbook(buffer) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch (e) {
    return { recipes: [], fatalError: 'The file could not be read as a valid .xlsx workbook.' };
  }

  if (!wb.worksheets.length) {
    return { recipes: [], fatalError: 'The workbook contains no worksheets.' };
  }

  // ── Locate the data sheet + its header row ──
  // Scan every worksheet's first rows for a header that maps BOTH a
  // "Recipe Name" column AND an ingredient column.  Requiring both
  // avoids latching onto a cover/instructions sheet that merely
  // mentions one of the labels in prose.
  let ws = null;
  let headerRowIdx = -1;
  let colMap = {};
  for (const sheet of wb.worksheets) {
    for (let r = 1; r <= Math.min(8, sheet.rowCount); r++) {
      const map = {};
      sheet.getRow(r).eachCell({ includeEmpty: false }, (cell, colNumber) => {
        const key = HEADER_ALIASES[normHeader(cellText(cell.value))];
        if (key && !(colNumber in map)) map[colNumber] = key;
      });
      const keys = Object.values(map);
      const hasName = keys.includes('name');
      const hasIngredient =
        keys.includes('ingredient_code') ||
        keys.includes('ingredient_name') ||
        keys.includes('quantity_kg');
      if (hasName && hasIngredient) {
        ws = sheet;
        headerRowIdx = r;
        colMap = map;
        break;
      }
    }
    if (ws) break;
  }

  if (headerRowIdx === -1) {
    return {
      recipes: [],
      fatalError:
        'No recognizable header row found. The file must include at least a "Recipe Name" and an "Ingredient Code" column. Download the template for the exact format.',
    };
  }

  // colNumber → fieldKey lookup, reversed to fieldKey → colNumber for reads
  const fieldCol = {};
  for (const [colNum, key] of Object.entries(colMap)) fieldCol[key] = Number(colNum);

  // ── Extract embedded images keyed by their anchor row ──
  // buildExportWorkbook anchors each recipe's uploaded image to the
  // IMAGE URL cell of the recipe's first row.  We rebuild a row →
  // data-URI map here so the recipe-creation loop below can pick it
  // up the same way it picks up the IMAGE URL cell text.  Safe to
  // skip silently — workbooks built by hand simply won't have any
  // embedded images and the map stays empty.
  const imagesByRow = new Map();
  try {
    const placements = typeof ws.getImages === 'function' ? ws.getImages() : [];
    const mediaIndex = new Map();
    if (wb.model && Array.isArray(wb.model.media)) {
      for (const m of wb.model.media) mediaIndex.set(`${m.index}`, m);
    }
    for (const p of placements) {
      const media = mediaIndex.get(`${p.imageId}`);
      if (!media || !media.buffer) continue;
      const ext = media.extension === 'jpg' ? 'jpeg' : (media.extension || 'png');
      const dataUri = `data:image/${ext};base64,${Buffer.from(media.buffer).toString('base64')}`;
      const tl = p.range && p.range.tl;
      if (!tl) continue;
      // nativeRow is 0-indexed; Excel row 2 corresponds to nativeRow=1
      const nr = tl.nativeRow != null ? tl.nativeRow : tl.row;
      if (nr == null) continue;
      const anchorRow = nr + 1;
      if (!imagesByRow.has(anchorRow)) imagesByRow.set(anchorRow, dataUri);
    }
  } catch (_e) { /* ignore — embedded-image extraction is best-effort */ }

  const read = (row, key) => {
    const c = fieldCol[key];
    if (!c) return null;
    const cell = row.getCell(c);
    // Slave cells of a vertical merge echo the master's value via the
    // cell.value API.  Treat them as blank so a merged "Recipe Name"
    // column starts a new recipe ONLY on the master row, not on every
    // row inside the merge range.  Unmerged cells have master===self.
    if (cell.isMerged && cell.master && cell.master !== cell) return null;
    return cell.value;
  };

  const recipes = [];
  let current = null;

  for (let r = headerRowIdx + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);

    const nameVal = cellText(read(row, 'name'));
    const code    = cellText(read(row, 'ingredient_code'));
    const ingName = cellText(read(row, 'ingredient_name'));
    const qty     = parseNum(read(row, 'quantity_kg'));

    const rowIsBlank = !nameVal && !code && !ingName && qty == null;
    if (rowIsBlank) continue;

    // A non-empty Recipe Name begins a new recipe group.
    if (nameVal) {
      // Validate the image-URL cell; bad values become warnings on the
      // recipe draft (the route surfaces them in the import report)
      // rather than silently producing a broken image in the UI.
      const { url: validatedUrl, warning: imageWarning } = classifyImageUrl(cellText(read(row, 'image_url')));
      const warnings = [];
      if (imageWarning) warnings.push(imageWarning);

      current = {
        rowNumber:          r,
        name:               nameVal,
        reference_code:     cellText(read(row, 'reference_code')) || null,
        recipe_type:        /final|סופי/i.test(cellText(read(row, 'recipe_type'))) ? 'final' : 'base',
        yield_kg:           parseNum(read(row, 'yield_kg')) || 1,
        full_name:          cellText(read(row, 'full_name')) || null,
        description:        cellText(read(row, 'description')) || null,
        // Cell URL (if valid) wins; otherwise an image embedded at this
        // row (the path the export takes for recipes whose image was
        // uploaded directly to the system).
        image_url:          validatedUrl || imagesByRow.get(r) || null,
        allergens:          splitAllergens(read(row, 'allergens')),
        is_spicy:           parseBool(read(row, 'is_spicy')),
        serving_suggestion: cellText(read(row, 'serving_suggestion')) || null,
        servings_count:     parseNum(read(row, 'servings_count')),
        total_weight:       parseNum(read(row, 'total_weight')),
        warnings,
        lines:              [],
      };
      recipes.push(current);
    }

    // Ingredient line on this row (the recipe-start row also carries one).
    if (current && (code || ingName) && qty != null) {
      current.lines.push({
        rowNumber:   r,
        code:        code || null,
        name:        ingName || null,
        quantity_kg: qty,
        waste_pct:   parseNum(read(row, 'waste_pct')) || 0,
        line_uom:    (cellText(read(row, 'line_uom')) || 'kg').toLowerCase(),
      });
    }
  }

  return { recipes, fatalError: null };
}

// ── Shared styling helpers for written workbooks ────────────────────
// markRequired=true renders required headers with a red asterisk and
// attaches the per-column `note` as a cell comment.  The export path
// keeps markRequired=false so exported workbooks stay visually quiet
// (the user already filled the data — they don't need the prompts).
function styleHeaderRow(ws, headers, { markRequired = false } = {}) {
  const headerRow = ws.getRow(1);
  headerRow.height = 24;
  headers.forEach((h, i) => {
    const cell = headerRow.getCell(i + 1);
    if (markRequired && h.required) {
      // Rich-text: gold header + red ' *' so the eye catches required
      // columns without colour-coding the whole cell.
      cell.value = {
        richText: [
          { text: h.header, font: { bold: true, color: { argb: COLOR_HEADER_TEXT }, size: 11 } },
          { text: ' *',     font: { bold: true, color: { argb: 'FFE53935' },         size: 12 } },
        ],
      };
    } else {
      cell.value = h.header;
      cell.font = { bold: true, color: { argb: COLOR_HEADER_TEXT }, size: 11 };
    }
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: h.group === 'readonly' ? COLOR_READONLY_BG : COLOR_HEADER_BG },
    };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = {
      bottom: { style: 'thin', color: { argb: COLOR_BORDER } },
      right:  { style: 'hair', color: { argb: COLOR_BORDER } },
    };
    if (markRequired && h.note) {
      cell.note = {
        texts: [{ text: h.note }],
        margins: { insetmode: 'auto' },
      };
    }
  });
  ws.columns = headers.map((h) => ({ width: h.width }));
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}

// Apply Excel data-validation dropdowns to the template columns whose
// values must come from a fixed set (Recipe Type, Spicy).  Applied to
// a wide range so the user can paste 100s of recipes underneath the
// example without losing the dropdown arrow.
function applyTemplateValidations(ws, headers) {
  const colIndex = (key) => headers.findIndex((h) => h.key === key) + 1;
  const colLetter = (n) => {
    let s = '';
    while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
    return s;
  };

  const VALIDATIONS = [
    { key: 'recipe_type', list: '"base,final"',  prompt: 'Pick "base" for sub-recipes / "final" for sellable products.' },
    { key: 'is_spicy',    list: '"Yes,No"',      prompt: 'Yes or No.' },
  ];

  for (const { key, list, prompt } of VALIDATIONS) {
    const c = colIndex(key);
    if (c <= 0) continue;
    const letter = colLetter(c);
    ws.dataValidations.add(`${letter}2:${letter}500`, {
      type: 'list',
      allowBlank: true,
      formulae: [list],
      showErrorMessage: true,
      errorStyle: 'warning',
      promptTitle: 'Allowed values',
      prompt,
      showInputMessage: true,
    });
  }
}

function recipeRowValues(headers, recipe, line, isFirstLine) {
  return headers.map((h) => {
    if (h.group === 'line') {
      if (!line) return null;
      switch (h.key) {
        case 'ingredient_name': return line.name ?? '';
        case 'ingredient_code': return line.code ?? '';
        case 'quantity_kg':     return line.quantity_kg ?? null;
        case 'waste_pct':       return line.waste_pct || null;
        case 'line_uom':        return line.line_uom || 'kg';
        default: return null;
      }
    }
    // recipe-level + readonly fields print on the first line only
    if (!isFirstLine) return null;
    switch (h.key) {
      case 'image_url':
        // data:… URIs are embedded as real Excel images later in
        // buildExportWorkbook — never write the base64 blob as cell
        // text (Excel's 32K-character per-cell limit would truncate
        // and corrupt the image).  Plain URLs go in as-is.
        if (recipe.image_url && /^data:image\//i.test(recipe.image_url)) return '';
        return recipe.image_url ?? '';
      case 'name':               return recipe.name ?? '';
      case 'reference_code':     return recipe.reference_code ?? '';
      case 'recipe_type':        return recipe.recipe_type ?? 'base';
      case 'yield_kg':           return recipe.yield_kg ?? null;
      case 'full_name':          return recipe.full_name ?? '';
      case 'description':        return recipe.description ?? '';
      case 'allergens':          return Array.isArray(recipe.allergens) ? recipe.allergens.join(', ') : '';
      case 'is_spicy':           return recipe.is_spicy ? 'Yes' : 'No';
      case 'serving_suggestion': return recipe.serving_suggestion ?? '';
      case 'servings_count':     return recipe.servings_count ?? null;
      case 'total_weight':       return recipe.total_weight ?? null;
      case 'cost_per_kg':        return recipe.cost_per_kg ?? null;
      case 'total_cost':         return recipe.total_cost ?? null;
      case 'wholesale_price':    return recipe.wholesale_price ?? null;
      case 'retail_price':       return recipe.retail_price ?? null;
      case 'version':            return recipe.version ?? null;
      case 'updated_at':         return recipe.updated_at ?? '';
      default: return null;
    }
  });
}

function writeRecipeRows(ws, headers, recipes) {
  let zebra = false;
  for (const recipe of recipes) {
    const lines = recipe.lines && recipe.lines.length ? recipe.lines : [null];
    const startRow = ws.rowCount + 1;
    lines.forEach((line, idx) => {
      const row = ws.addRow(recipeRowValues(headers, recipe, line, idx === 0));
      row.alignment = { vertical: 'middle' };
      if (zebra) {
        row.eachCell({ includeEmpty: true }, (cell) => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7F5EF' } };
        });
      }
    });
    // Visually group a multi-ingredient recipe by merging its
    // recipe-level cells down the block (image, name, code …).
    const endRow = ws.rowCount;
    if (endRow > startRow) {
      headers.forEach((h, i) => {
        if (h.group === 'recipe' || h.group === 'readonly') {
          try { ws.mergeCells(startRow, i + 1, endRow, i + 1); } catch { /* ignore */ }
          ws.getCell(startRow, i + 1).alignment = { vertical: 'middle', wrapText: true };
        }
      });
    }
    zebra = !zebra;
  }
}

/**
 * Build the downloadable template: a Recipes sheet (with two worked
 * examples — one base, one final — plus data-validation dropdowns and
 * red-asterisk required headers), followed by an Instructions sheet
 * as a reference.  Recipes is the active tab on open.
 * @returns {Promise<Buffer>}
 */
async function buildTemplateWorkbook() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'The Kosher Place — BOM System';
  wb.created = new Date();

  // Template excludes the read-only (export-only) columns.
  const headers = COLUMNS.filter((c) => c.group !== 'readonly');

  // ── Recipes sheet (added FIRST so it opens by default) ──
  const ws = wb.addWorksheet('Recipes', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  styleHeaderRow(ws, headers, { markRequired: true });

  // Two examples so the importer demonstrates BOTH lists:
  //   #1 "Hamin Chicken Catering Tray" → recipe_type=final → Final Products
  //   #2 "Roasted Vegetable Base"      → recipe_type=base  → Base Recipes
  const examples = [
    {
      // Real, public placeholder image so the thumbnail visibly works
      // right after importing the template — proves the image_url
      // column is wired end-to-end.  Swap for your own URL afterwards.
      image_url: 'https://placehold.co/600x400/56133A/CBAA6A/png?text=Hamin+Tray',
      name: 'Hamin Chicken Catering Tray',
      reference_code: 'CKC-0018',
      recipe_type: 'final',
      yield_kg: 1,
      full_name: 'Hamin Chicken Catering Tray',
      description: 'Slow-cooked Shabbat hamin with chicken, beans and potatoes.',
      allergens: ['legumes'],
      is_spicy: false,
      serving_suggestion: 'Serve hot. Reheat covered at 150°C.',
      servings_count: 6,
      total_weight: 1,
      lines: [
        { name: 'Whole Chicken Retail kg',         code: 'FRZ-0035', quantity_kg: 0.253, waste_pct: 0, line_uom: 'kg' },
        { name: 'Soaked beans',                     code: 'BAS-0018', quantity_kg: 0.122, waste_pct: 0, line_uom: 'kg' },
        { name: 'Sweet potato cubes',               code: 'BAS-0017', quantity_kg: 0.076, waste_pct: 0, line_uom: 'kg' },
        { name: 'Cube Potato',                      code: 'BAS-0002', quantity_kg: 0.202, waste_pct: 0, line_uom: 'kg' },
        { name: 'Fried onions',                     code: 'BAS-0016', quantity_kg: 0.063, waste_pct: 0, line_uom: 'kg' },
        { name: 'Tomato Paste',                     code: 'ING-0217', quantity_kg: 0.032, waste_pct: 0, line_uom: 'kg' },
        { name: 'Baharat',                          code: 'ING-0006', quantity_kg: 0.002, waste_pct: 0, line_uom: 'kg' },
        { name: 'Onion Soup Powder Knorr 400 gr',   code: 'DRY-0190', quantity_kg: 0.003, waste_pct: 0, line_uom: 'kg' },
        { name: 'Soybean Cooking Oil',              code: 'ING-0199', quantity_kg: 0.004, waste_pct: 0, line_uom: 'kg' },
        { name: 'Salt',                             code: 'ING-0183', quantity_kg: 0.006, waste_pct: 0, line_uom: 'kg' },
        { name: 'Honey',                            code: 'ING-0106', quantity_kg: 0.011, waste_pct: 0, line_uom: 'kg' },
        { name: 'Sweet Paprika powder',             code: 'ING-0210', quantity_kg: 0.004, waste_pct: 0, line_uom: 'kg' },
        { name: 'Wheat Sugat 500 gr',               code: 'DRY-0353', quantity_kg: 0.021, waste_pct: 0, line_uom: 'kg' },
        { name: 'Drinking Water',                   code: 'ING-0065', quantity_kg: 0.202, waste_pct: 0, line_uom: 'kg' },
      ],
    },
    {
      image_url: 'https://placehold.co/600x400/CBAA6A/56133A/png?text=Veg+Base',
      name: 'Roasted Vegetable Base',
      reference_code: 'BAS-DEMO-01',
      recipe_type: 'base',
      yield_kg: 1,
      full_name: '',
      description: 'A reusable roasted-veg base used inside catering trays. Lands in the Base Recipes list.',
      allergens: [],
      is_spicy: false,
      serving_suggestion: '',
      servings_count: null,
      total_weight: 1,
      lines: [
        { name: 'Sweet potato cubes', code: 'BAS-0017', quantity_kg: 0.40, waste_pct: 2, line_uom: 'kg' },
        { name: 'Cube Potato',        code: 'BAS-0002', quantity_kg: 0.40, waste_pct: 2, line_uom: 'kg' },
        { name: 'Fried onions',       code: 'BAS-0016', quantity_kg: 0.10, waste_pct: 0, line_uom: 'kg' },
        { name: 'Soybean Cooking Oil',code: 'ING-0199', quantity_kg: 0.06, waste_pct: 0, line_uom: 'kg' },
        { name: 'Salt',               code: 'ING-0183', quantity_kg: 0.02, waste_pct: 0, line_uom: 'kg' },
        { name: 'Sweet Paprika powder',code: 'ING-0210',quantity_kg: 0.02, waste_pct: 0, line_uom: 'kg' },
      ],
    },
  ];

  writeRecipeRows(ws, headers, examples);
  applyTemplateValidations(ws, headers);

  // ── Instructions sheet (reference, added second) ──
  const info = wb.addWorksheet('Instructions', {
    properties: { defaultColWidth: 22 },
    views: [{ showGridLines: false }],
  });
  info.mergeCells('A1:B1');
  info.getCell('A1').value = 'Recipe Import — How to fill this file';
  info.getCell('A1').font = { bold: true, size: 14, color: { argb: COLOR_HEADER_BG } };
  info.getColumn(1).width = 26;
  info.getColumn(2).width = 70;
  info.addRow([]); // spacer
  const notes = [
    ['Rule', 'Detail'],
    ['Required columns', 'Headers marked with a red * (Recipe Name, Recipe Reference Code, Recipe Type, Ingredient Code, Qty for 1 kg) MUST be filled.'],
    ['One row per ingredient', 'List every ingredient of a recipe on its own row.'],
    ['Recipe header fields', 'Fill Recipe Name, Code, Type, etc. ONLY on the first ingredient row of each recipe. Leave them blank on the following rows.'],
    ['Recipe Type', 'Use the dropdown in the Recipe Type column: "base" → goes to the Base Recipes list. "final" → goes to the Final Products list.'],
    ['Ingredient Code', 'Must match an existing item reference code in the system (e.g. FRZ-0035). This is how ingredients are linked.'],
    ['Qty for 1 kg', 'Quantity of the ingredient needed per 1 kg of recipe yield (numbers only).'],
    ['Yield (kg)', 'Total batch output the quantities refer to. Defaults to 1.'],
    ['Spicy', 'Pick Yes or No from the dropdown.'],
    ['Allergens', 'Comma-separated, e.g. "gluten, dairy, nuts".'],
    ['Image — URL', 'Paste a PUBLIC http(s) link (right-click an online image → "Copy image address").'],
    ['Image — file from your computer', 'Excel can\'t use "C:\\…" paths (the browser blocks local-disk access). Instead insert the picture INTO the IMAGE URL cell from Excel (Insert → Pictures → "Picture in Cell"), or upload the image inside the recipe form. Both round-trip cleanly through re-export.'],
    ['Duplicate ingredients', 'Two lines for the same ingredient are merged automatically — quantities are summed and a note appears in the import report.'],
    ['Unmatched ingredient', 'If ANY ingredient code is not found, the WHOLE recipe is skipped and reported — nothing partial is imported.'],
  ];
  notes.forEach((n, i) => {
    const row = info.addRow(n);
    if (i === 0) {
      row.font = { bold: true, color: { argb: COLOR_HEADER_TEXT } };
      row.eachCell((c) => {
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_HEADER_BG } };
      });
    } else {
      row.getCell(1).font = { bold: true };
      row.alignment = { vertical: 'top', wrapText: true };
    }
  });

  // Force Recipes to be the active tab when the file opens.
  wb.views = [{
    x: 0, y: 0, width: 22000, height: 14000,
    firstSheet: 0, activeTab: 0, visibility: 'visible',
  }];

  return wb.xlsx.writeBuffer();
}

/**
 * Build an export workbook from enriched recipe rows.
 *
 * Recipes with an uploaded image (image_url starts with `data:image/`)
 * have that image embedded as a real Excel image, anchored to the
 * IMAGE URL cell of the recipe's first ingredient row.  Plain http(s)
 * URLs stay as text in the cell.  parseRecipeWorkbook reverses this on
 * re-import so a recipe with an uploaded image round-trips cleanly.
 *
 * @param {Array} recipes  Recipe objects with a `lines` array.
 * @param {object} [opts]   { includePrices: boolean }
 * @returns {Promise<Buffer>}
 */
async function buildExportWorkbook(recipes, opts = {}) {
  const includePrices = opts.includePrices !== false;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'The Kosher Place — BOM System';
  wb.created = new Date();

  const PRICE_KEYS = new Set(['cost_per_kg', 'total_cost', 'wholesale_price', 'retail_price']);
  const headers = COLUMNS.filter((c) => includePrices || !PRICE_KEYS.has(c.key));

  const ws = wb.addWorksheet('Recipes');
  styleHeaderRow(ws, headers);
  writeRecipeRows(ws, headers, recipes);

  // Number formatting for numeric columns
  headers.forEach((h, i) => {
    if (['quantity_kg', 'cost_per_kg', 'total_cost', 'wholesale_price', 'retail_price', 'total_weight'].includes(h.key)) {
      ws.getColumn(i + 1).numFmt = '#,##0.000';
    }
  });

  // ── Embed base64 images visually ──
  // writeRecipeRows writes rows in the order of `recipes`, with one
  // row per ingredient (or a single empty row when a recipe has none).
  // We replay that cursor here to figure out where each recipe's first
  // row lives so addImage anchors land in the right cell.
  const imageColIdx = headers.findIndex((h) => h.key === 'image_url') + 1; // 1-based
  if (imageColIdx > 0) {
    let cursor = 2; // header is row 1, data starts at row 2
    for (const recipe of recipes) {
      const firstRow  = cursor;
      const lineCount = Math.max(1, (recipe.lines && recipe.lines.length) || 0);
      cursor += lineCount;

      const url = recipe.image_url;
      if (typeof url !== 'string' || !/^data:image\//i.test(url)) continue;

      const m = url.match(/^data:image\/([a-zA-Z0-9+.\-]+);base64,(.+)$/i);
      if (!m) continue;
      // Excel only recognises a small set of image extensions — normalise.
      const rawExt = m[1].toLowerCase();
      const ext = rawExt === 'jpg' ? 'jpeg' : (['png', 'jpeg', 'gif'].includes(rawExt) ? rawExt : 'png');

      let imageId;
      try {
        imageId = wb.addImage({ base64: m[2], extension: ext });
      } catch (err) {
        console.warn('[buildExportWorkbook] embed failed for', recipe.name, '—', err.message);
        continue;
      }

      // Make the recipe's first row tall enough for the thumbnail to
      // be visible without clipping the surrounding ingredient rows.
      const masterRow = ws.getRow(firstRow);
      if (!masterRow.height || masterRow.height < 80) masterRow.height = 80;

      // ExcelJS image-anchor coords are 0-indexed; col=A → 0, row=2 → 1.
      ws.addImage(imageId, {
        tl: { col: imageColIdx - 1, row: firstRow - 1 },
        ext: { width: 110, height: 78 },
        editAs: 'oneCell',
      });
    }
  }

  return wb.xlsx.writeBuffer();
}

module.exports = {
  COLUMNS,
  parseRecipeWorkbook,
  buildTemplateWorkbook,
  buildExportWorkbook,
};
