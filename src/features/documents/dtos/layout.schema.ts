import { z } from 'zod';

/**
 * What a receipt or a label looks like — the contract the app renders from
 * (`docs/reference/receipts_labels.md`).
 *
 * **Ordered sections, not a free canvas.** A template is a list of blocks the
 * administration reorders, shows or hides, and tunes with a few options. A
 * canvas with coordinates is hard to use with a finger on a phone and breaks
 * when the paper changes: an element placed on 80 mm falls off the edge of
 * 58 mm. Blocks reflow to any width, so one template survives a new printer.
 *
 * **The server stores the layout and never renders it.** Rendering happens on
 * the device that prints, and the live preview cannot afford a network round
 * trip per drag. What the server owns is that a stored layout is *valid*: every
 * option is present (defaults filled on the way in), every number in range, and
 * a label grid actually fits its sheet — a sheet that overflows prints its last
 * row onto the next page with nothing on screen saying so.
 *
 * **Amounts are not here.** A block chooses *what* is shown; every number on a
 * receipt comes from the sale as the server computed it.
 */

export const LAYOUT_VERSION = 1;

const align = z.enum(['start', 'center', 'end']).default('start');
const textSize = z.enum(['small', 'normal', 'large', 'xlarge']).default('normal');
const visible = z.boolean().default(true);

const shopName = z
  .object({ type: z.literal('shop_name'), visible, align, size: textSize, bold: z.boolean().default(true) })
  .strict();
const logo = z
  .object({ type: z.literal('logo'), visible, align, height_mm: z.number().min(5).max(40).default(14) })
  .strict();
const text = z
  .object({
    type: z.literal('text'),
    visible,
    align,
    size: textSize,
    bold: z.boolean().default(false),
    text_ar: z.string().trim().max(500).default(''),
    text_en: z.string().trim().max(500).default(''),
  })
  .strict();
const divider = z
  .object({ type: z.literal('divider'), visible, style: z.enum(['solid', 'dashed', 'double']).default('dashed') })
  .strict();
const spacer = z
  .object({ type: z.literal('spacer'), visible, height_mm: z.number().min(1).max(30).default(3) })
  .strict();

// ── Receipt blocks ─────────────────────────────────────────────────────────

const branchInfo = z
  .object({
    type: z.literal('branch_info'),
    visible,
    align,
    size: textSize,
    show_name: z.boolean().default(true),
    show_address: z.boolean().default(true),
    show_contact: z.boolean().default(true),
  })
  .strict();
const taxInfo = z
  .object({
    type: z.literal('tax_info'),
    visible,
    align,
    show_tax_number: z.boolean().default(true),
    show_commercial_register: z.boolean().default(false),
  })
  .strict();
const saleMeta = z
  .object({
    type: z.literal('sale_meta'),
    visible,
    show_number: z.boolean().default(true),
    show_date: z.boolean().default(true),
    show_cashier: z.boolean().default(true),
    show_customer: z.boolean().default(true),
  })
  .strict();
const lines = z
  .object({
    type: z.literal('lines'),
    visible,
    /** One line per item (name and total), or name above a qty × price row. */
    style: z.enum(['compact', 'detailed']).default('detailed'),
    show_unit_price: z.boolean().default(true),
    show_discount: z.boolean().default(true),
    show_sku: z.boolean().default(false),
  })
  .strict();
const totals = z
  .object({
    type: z.literal('totals'),
    visible,
    show_subtotal: z.boolean().default(true),
    show_discount: z.boolean().default(true),
    /** VAT is inside the price here — shown as «منها», never added. */
    show_tax: z.boolean().default(true),
    total_size: z.enum(['normal', 'large', 'xlarge']).default('large'),
  })
  .strict();
const payment = z
  .object({
    type: z.literal('payment'),
    visible,
    show_method: z.boolean().default(true),
    show_tendered: z.boolean().default(true),
    show_change: z.boolean().default(true),
  })
  .strict();
const saleBarcode = z
  .object({
    type: z.literal('sale_barcode'),
    visible,
    align: align.default('center'),
    height_mm: z.number().min(5).max(30).default(10),
    show_digits: z.boolean().default(true),
  })
  .strict();
const saleQr = z
  .object({
    type: z.literal('qr'),
    visible,
    align: align.default('center'),
    size_mm: z.number().min(10).max(50).default(22),
    /**
     * `sale` encodes the invoice number (scanned at the till for a return);
     * `link` encodes a URL the shop chose — a review page, a map pin, a menu.
     * A link QR with no link prints nothing rather than an empty square.
     */
    content: z.enum(['sale', 'link']).default('sale'),
    link: z.string().trim().max(300).default(''),
    /** A short line under the code saying what it opens («قيّمنا»). */
    caption_ar: z.string().trim().max(80).default(''),
    caption_en: z.string().trim().max(80).default(''),
  })
  .strict();
/** Signature and stamp boxes — for A4 invoices a business files. */
const signature = z
  .object({
    type: z.literal('signature'),
    visible,
    show_signature: z.boolean().default(true),
    show_stamp: z.boolean().default(true),
  })
  .strict();

export const receiptBlockSchema = z.discriminatedUnion('type', [
  logo,
  shopName,
  branchInfo,
  taxInfo,
  saleMeta,
  lines,
  totals,
  payment,
  saleBarcode,
  saleQr,
  signature,
  text,
  divider,
  spacer,
]);

// ── Label blocks ───────────────────────────────────────────────────────────

const productName = z
  .object({
    type: z.literal('product_name'),
    visible,
    align,
    size: textSize,
    bold: z.boolean().default(true),
    max_lines: z.number().int().min(1).max(3).default(2),
  })
  .strict();
const variantLabel = z
  .object({ type: z.literal('variant'), visible, align, size: textSize.default('small') })
  .strict();
const price = z
  .object({
    type: z.literal('price'),
    visible,
    align,
    size: textSize.default('xlarge'),
    /** The struck price before an offer — only when there is an offer. */
    show_before: z.boolean().default(true),
    show_currency: z.boolean().default(true),
  })
  .strict();
const unit = z.object({ type: z.literal('unit'), visible, align, size: textSize.default('small') }).strict();
const barcode = z
  .object({
    type: z.literal('barcode'),
    visible,
    align: align.default('center'),
    /** `auto` = EAN-13 when the code is a valid EAN-13, Code128 otherwise. */
    symbology: z.enum(['auto', 'ean13', 'code128']).default('auto'),
    height_mm: z.number().min(4).max(40).default(10),
    show_digits: z.boolean().default(true),
  })
  .strict();
const sku = z.object({ type: z.literal('sku'), visible, align, size: textSize.default('small') }).strict();
const labelQr = z
  .object({
    type: z.literal('qr'),
    visible,
    align: align.default('center'),
    size_mm: z.number().min(6).max(50).default(12),
    content: z.enum(['barcode', 'sku']).default('barcode'),
  })
  .strict();
const printDate = z
  .object({ type: z.literal('print_date'), visible, align, size: textSize.default('small') })
  .strict();

export const labelBlockSchema = z.discriminatedUnion('type', [
  shopName,
  productName,
  variantLabel,
  price,
  unit,
  barcode,
  sku,
  labelQr,
  printDate,
  logo,
  text,
  divider,
  spacer,
]);

/** Blocks that may appear more than once; every other type is at most once. */
export const REPEATABLE_BLOCKS: ReadonlySet<string> = new Set(['text', 'divider', 'spacer']);

function uniqueBlockTypes(blocks: { type: string }[], ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  blocks.forEach((block, i) => {
    if (REPEATABLE_BLOCKS.has(block.type)) return;
    if (seen.has(block.type)) {
      ctx.addIssue({ code: 'custom', path: ['blocks', i, 'type'], message: `"${block.type}" may appear once` });
    }
    seen.add(block.type);
  });
}

const fontScale = z.number().min(0.8).max(1.5).default(1);
const language = z.enum(['ar', 'en', 'both']).default('ar');

// ── Receipt layout ─────────────────────────────────────────────────────────

export const RECEIPT_PAPERS = ['roll_58', 'roll_80', 'a4', 'a5'] as const;
export const RECEIPT_STYLES = ['classic', 'modern', 'minimal', 'tabular', 'elegant', 'ticket'] as const;

export const receiptLayoutSchema = z
  .object({
    version: z.literal(LAYOUT_VERSION).default(LAYOUT_VERSION),
    page: z
      .object({
        paper: z.enum(RECEIPT_PAPERS),
        margin_mm: z.number().min(0).max(20).default(2),
        font_scale: fontScale,
        language,
        copies: z.number().int().min(1).max(5).default(1),
        // **نمط الرسم** — كيف تُرسم الأقسام نفسها (لا أيّها يظهر)، وفوقه ما
        // يعدّله كل محل بذوقه. `auto` يتبع النمط. الافتراضيات هي شكل الفاتورة
        // قبل وجود الأنماط، فقالبٌ محفوظ قبلها يُطبع كما كان.
        style: z.enum(RECEIPT_STYLES).default('classic'),
        density: z.enum(['comfortable', 'normal', 'compact']).default('normal'),
        total_style: z.enum(['auto', 'box', 'band', 'plain']).default('auto'),
        separator: z.enum(['auto', 'space', 'line', 'dots', 'double']).default('auto'),
        heading_font: z.enum(['auto', 'kufi', 'naskh', 'modern']).default('auto'),
        /** How items are laid out; `auto` follows the style. Replaces the lines block's own `style`. */
        item_layout: z.enum(['auto', 'two_lines', 'one_line', 'table']).default('auto'),
        /** The face for the whole receipt; headings keep `heading_font`. */
        body_font: z.enum(['noto', 'almarai', 'tajawal', 'naskh']).default('noto'),
        digits: z.enum(['latin', 'arabic']).default('latin'),
        /** `symbol` = «ل.س» / «SYP» by language · `code` = «SYP» always · `none`. */
        currency: z.enum(['symbol', 'code', 'none']).default('symbol'),
        time_format: z.enum(['h24', 'h12']).default('h24'),
        /**
         * A brand colour for A4/A5 and shared copies. A thermal head prints one
         * colour, so the app ignores it on rolls — stored anyway so switching
         * the paper does not lose it.
         */
        accent: z
          .string()
          .regex(/^#[0-9a-f]{6}$/)
          .nullable()
          .default(null),
      })
      .strict(),
    blocks: z.array(receiptBlockSchema).min(1).max(40),
  })
  .strict()
  .superRefine((layout, ctx) => uniqueBlockTypes(layout.blocks, ctx));

// ── Label layout ───────────────────────────────────────────────────────────

/**
 * Width a thermal head can actually print on each roll, in mm. The paper is
 * wider than the head; a label wider than this prints its edge into nothing.
 */
export const ROLL_PRINTABLE_MM = { roll_58: 48, roll_80: 72 } as const;

export const SHEET_SIZES_MM = {
  a4: { width: 210, height: 297 },
  a5: { width: 148, height: 210 },
  letter: { width: 216, height: 279 },
} as const;

const medium = z.discriminatedUnion('mode', [
  /** A label printer: one label per feed, the printer knows the gap. */
  z.object({ mode: z.literal('label_roll') }).strict(),
  /** A receipt printer, cut by hand — for a shop without a label printer. */
  z
    .object({
      mode: z.literal('receipt_roll'),
      roll: z.enum(['roll_58', 'roll_80']),
      gap_mm: z.number().min(0).max(20).default(3),
    })
    .strict(),
  /** An office printer on a sheet of stickers — a grid. */
  z
    .object({
      mode: z.literal('sheet'),
      sheet: z.enum(['a4', 'a5', 'letter', 'custom']),
      /** Only for `custom`; the named sheets carry their own size. */
      sheet_width_mm: z.number().min(50).max(500).nullable().default(null),
      sheet_height_mm: z.number().min(50).max(500).nullable().default(null),
      columns: z.number().int().min(1).max(10),
      rows: z.number().int().min(1).max(40),
      margin_top_mm: z.number().min(0).max(50).default(0),
      margin_side_mm: z.number().min(0).max(50).default(0),
      gap_x_mm: z.number().min(0).max(20).default(0),
      gap_y_mm: z.number().min(0).max(20).default(0),
    })
    .strict(),
]);

export const labelLayoutSchema = z
  .object({
    version: z.literal(LAYOUT_VERSION).default(LAYOUT_VERSION),
    page: z
      .object({
        width_mm: z.number().min(15).max(150),
        height_mm: z.number().min(10).max(150),
        margin_mm: z.number().min(0).max(10).default(1),
        font_scale: fontScale,
        language,
        medium,
      })
      .strict(),
    blocks: z.array(labelBlockSchema).min(1).max(20),
  })
  .strict()
  .superRefine((layout, ctx) => {
    uniqueBlockTypes(layout.blocks, ctx);
    const problem = labelFitProblem(layout.page);
    if (problem) ctx.addIssue({ code: 'custom', path: ['page', 'medium'], message: problem });
  });

export type ReceiptLayout = z.infer<typeof receiptLayoutSchema>;
export type LabelLayout = z.infer<typeof labelLayoutSchema>;
export type LabelPage = LabelLayout['page'];

const EPSILON = 0.01;

/**
 * Why a label does not fit its medium, or `null` when it does.
 *
 * Pure so the rule is tested on its own, with each case beside its opposite:
 * nothing fails at print time when it is wrong — the last column lands in the
 * margin, or the last row on a second sheet.
 */
export function labelFitProblem(page: LabelPage): string | null {
  const m = page.medium;
  if (m.mode === 'label_roll') return null;
  if (m.mode === 'receipt_roll') {
    const printable = ROLL_PRINTABLE_MM[m.roll];
    return page.width_mm > printable + EPSILON
      ? `A ${page.width_mm} mm label is wider than the ${printable} mm a ${m.roll} printer prints`
      : null;
  }
  const size =
    m.sheet === 'custom'
      ? m.sheet_width_mm !== null && m.sheet_height_mm !== null
        ? { width: m.sheet_width_mm, height: m.sheet_height_mm }
        : null
      : SHEET_SIZES_MM[m.sheet];
  if (size === null) return 'A custom sheet needs its width and height';

  const usedWidth = 2 * m.margin_side_mm + m.columns * page.width_mm + (m.columns - 1) * m.gap_x_mm;
  const usedHeight = m.margin_top_mm + m.rows * page.height_mm + (m.rows - 1) * m.gap_y_mm;
  if (usedWidth > size.width + EPSILON) {
    return `${m.columns} columns need ${round(usedWidth)} mm; the sheet is ${size.width} mm wide`;
  }
  if (usedHeight > size.height + EPSILON) {
    return `${m.rows} rows need ${round(usedHeight)} mm; the sheet is ${size.height} mm tall`;
  }
  return null;
}

const round = (n: number): number => Math.round(n * 10) / 10;

export const DOCUMENT_KINDS = ['receipt', 'label'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/** Validate and normalise (fill every default) a layout for its kind. */
export function layoutSchemaFor(kind: DocumentKind): z.ZodTypeAny {
  return kind === 'receipt' ? receiptLayoutSchema : labelLayoutSchema;
}
