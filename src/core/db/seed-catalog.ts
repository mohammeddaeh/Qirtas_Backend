import { eq } from 'drizzle-orm';
import { db } from './client.js';
import { logger } from '../logger/logger.js';
import { normalizeArabic } from '../i18n/arabic-normalize.js';
import { catalogUnitsTable } from '../../features/catalog/schemas/units.schema.js';
import {
  catalogAttributeTypesTable,
  catalogAttributeValuesTable,
} from '../../features/catalog/schemas/attributes.schema.js';
import {
  catalogCategoriesTable,
  catalogCategoryAttributesTable,
} from '../../features/catalog/schemas/categories.schema.js';
import { catalogBrandsTable } from '../../features/catalog/schemas/brands.schema.js';
import type {
  PricePolicy,
  PricingCurrency,
  ProductKind,
} from '../../features/catalog/schemas/catalog-enums.schema.js';

/**
 * The catalog's starting data — docs/reference/catalog_seed.md, approved
 * 2026-09-22.
 *
 * **Insert-if-missing, never update.** Seeded rows carry a `code`; a row whose
 * code exists is left exactly as it is, because once the shop runs, an admin
 * renaming «مقلمات» or dropping an attribute from a category is the truth and a
 * re-seed must not quietly revert it. Allowed attributes are written only for
 * a category this run creates, for the same reason. Brands match by folded
 * name.
 *
 * Runs with the core seed (every `npm run db:seed`): a deployment without the
 * units cannot create a single product.
 */

// ── Units ───────────────────────────────────────────────────────────────────
const UNITS: { code: string; ar: string; en: string; fraction?: true }[] = [
  { code: 'piece', ar: 'قطعة', en: 'Piece' },
  { code: 'box', ar: 'علبة', en: 'Box' },
  { code: 'dozen', ar: 'دزينة', en: 'Dozen' },
  { code: 'ream', ar: 'رزمة', en: 'Ream' },
  { code: 'carton', ar: 'طرد', en: 'Carton' },
  { code: 'set', ar: 'طقم', en: 'Set' },
  { code: 'roll', ar: 'لفّة', en: 'Roll' },
  { code: 'meter', ar: 'متر', en: 'Metre', fraction: true },
  { code: 'kilogram', ar: 'كيلوغرام', en: 'Kilogram', fraction: true },
  { code: 'milliliter', ar: 'مل', en: 'Millilitre', fraction: true },
];

// ── Attribute library ───────────────────────────────────────────────────────
type SeedValue = [ar: string, en: string | null, hex?: string];
const ATTRIBUTES: {
  code: string;
  ar: string;
  en: string;
  display?: 'swatch';
  values: SeedValue[];
}[] = [
  {
    code: 'color',
    ar: 'اللون',
    en: 'Colour',
    display: 'swatch',
    values: [
      ['أسود', 'Black', '#000000'],
      ['أزرق', 'Blue', '#1e56c8'],
      ['أحمر', 'Red', '#d32f2f'],
      ['أخضر', 'Green', '#2e7d32'],
      ['أصفر', 'Yellow', '#fbc02d'],
      ['برتقالي', 'Orange', '#f57c00'],
      ['بنفسجي', 'Purple', '#7b1fa2'],
      ['وردي', 'Pink', '#ec407a'],
      ['بني', 'Brown', '#6d4c41'],
      ['رمادي', 'Grey', '#9e9e9e'],
      ['أبيض', 'White', '#ffffff'],
      ['ذهبي', 'Gold', '#c9a227'],
      ['فضي', 'Silver', '#c0c0c0'],
      ['متعدد الألوان', 'Multicolour'],
    ],
  },
  {
    code: 'tip_size',
    ar: 'سماكة الرأس (مم)',
    en: 'Tip size (mm)',
    values: t('0.3 0.5 0.7 1.0 1.6'),
  },
  { code: 'lead_grade', ar: 'درجة الرصاص', en: 'Lead grade', values: t('2H H HB B 2B 4B 6B 8B') },
  { code: 'paper_size', ar: 'مقاس الورق', en: 'Paper size', values: t('A3 A4 A5 A6 B5 Letter') },
  { code: 'sheet_count', ar: 'عدد الأوراق', en: 'Sheets', values: t('40 60 80 100 120 200') },
  {
    code: 'ruling',
    ar: 'التسطير',
    en: 'Ruling',
    values: [
      ['مسطّر', 'Lined'],
      ['مربعات', 'Squared'],
      ['سادة', 'Plain'],
      ['نقاط', 'Dotted'],
    ],
  },
  {
    code: 'paper_weight',
    ar: 'وزن الورق (غ/م²)',
    en: 'Paper weight (gsm)',
    values: t('70 80 100 120 160 250 300'),
  },
  {
    code: 'color_count',
    ar: 'عدد الألوان',
    en: 'Number of colours',
    values: t('6 12 18 24 36 48'),
  },
  {
    code: 'cover_type',
    ar: 'نوع الغلاف',
    en: 'Cover',
    values: [
      ['عادي', 'Soft'],
      ['مقوّى', 'Hard'],
      ['بلاستيك', 'Plastic'],
    ],
  },
  {
    code: 'binding',
    ar: 'التجليد',
    en: 'Binding',
    values: [
      ['سلك', 'Spiral'],
      ['خياطة', 'Sewn'],
      ['دبوس', 'Stapled'],
      ['لاصق', 'Glued'],
    ],
  },
  { code: 'length_cm', ar: 'الطول (سم)', en: 'Length (cm)', values: t('15 20 30 50') },
  { code: 'capacity_ml', ar: 'السعة (مل)', en: 'Capacity (ml)', values: t('330 350 500 750 1000') },
  {
    code: 'apparel_size',
    ar: 'المقاس (ملابس)',
    en: 'Size (apparel)',
    values: t('XS S M L XL XXL'),
  },
  {
    code: 'theme',
    ar: 'الثيم',
    en: 'Theme',
    values: [
      ['سادة', 'Plain'],
      ['أطفال', 'Kids'],
      ['رياضي', 'Sport'],
      ['شخصيات كرتونية', 'Cartoon characters'],
      ['بنات', 'Girls'],
      ['شباب', 'Boys'],
    ],
  },
  {
    code: 'material',
    ar: 'المادة',
    en: 'Material',
    values: [
      ['بلاستيك', 'Plastic'],
      ['معدن', 'Metal'],
      ['خشب', 'Wood'],
      ['قماش', 'Fabric'],
      ['سيراميك', 'Ceramic'],
      ['زجاج', 'Glass'],
    ],
  },
];

/** Values whose Arabic and English spelling are the same token (sizes, grades). */
function t(tokens: string): SeedValue[] {
  return tokens.split(' ').map((token) => [token, null]);
}

// ── Category tree ───────────────────────────────────────────────────────────
interface SeedCategory {
  code: string;
  ar: string;
  en: string;
  kind?: ProductKind;
  policy?: PricePolicy;
  currency?: PricingCurrency;
  attrs?: string[];
  children?: SeedCategory[];
}

/** Leaves under one parent: `[code, ar, en]`. */
function leaves(prefix: string, items: [string, string, string][]): SeedCategory[] {
  return items.map(([code, ar, en]) => ({ code: `${prefix}.${code}`, ar, en }));
}

const TREE: SeedCategory[] = [
  {
    code: 'writing',
    ar: 'أدوات الكتابة',
    en: 'Writing Instruments',
    kind: 'retail',
    policy: 'branch_banded',
    currency: 'SYP',
    attrs: ['color', 'tip_size'],
    children: [
      {
        code: 'writing.pens',
        ar: 'أقلام حبر',
        en: 'Pens',
        children: leaves('writing.pens', [
          ['ballpoint', 'جاف', 'Ballpoint'],
          ['gel', 'جل', 'Gel'],
          ['rollerball', 'حبر سائل (رولر)', 'Rollerball'],
          ['premium', 'أقلام فاخرة', 'Premium Pens'],
        ]),
      },
      {
        code: 'writing.pencils',
        ar: 'أقلام رصاص',
        en: 'Pencils',
        attrs: ['lead_grade'],
        children: leaves('writing.pencils', [
          ['wooden', 'خشبية', 'Wooden'],
          ['mechanical', 'ميكانيكية', 'Mechanical'],
          ['leads', 'رصاص بديل', 'Refill Leads'],
        ]),
      },
      {
        code: 'writing.markers',
        ar: 'أقلام تحديد وماركر',
        en: 'Highlighters & Markers',
        children: leaves('writing.markers', [
          ['highlighter', 'فوسفوري', 'Highlighters'],
          ['whiteboard', 'ماركر سبورة', 'Whiteboard Markers'],
          ['permanent', 'ماركر دائم', 'Permanent Markers'],
          ['calligraphy', 'أقلام خط عربي', 'Arabic Calligraphy Pens'],
        ]),
      },
      {
        code: 'writing.correction',
        ar: 'التصحيح',
        en: 'Correction',
        children: leaves('writing.correction', [
          ['pen', 'قلم تصحيح', 'Correction Pens'],
          ['tape', 'شريط تصحيح', 'Correction Tape'],
        ]),
      },
    ],
  },
  {
    code: 'paper',
    ar: 'الدفاتر والورق',
    en: 'Notebooks & Paper',
    kind: 'retail',
    policy: 'branch_banded',
    currency: 'SYP',
    attrs: ['paper_size', 'sheet_count', 'ruling', 'cover_type', 'binding'],
    children: [
      {
        code: 'paper.notebooks',
        ar: 'دفاتر',
        en: 'Notebooks',
        children: leaves('paper.notebooks', [
          ['school', 'مدرسية', 'School Notebooks'],
          ['spiral', 'سلكية', 'Spiral Notebooks'],
          ['diaries', 'مذكرات ومفكرات', 'Diaries & Journals'],
          ['sketch', 'دفاتر رسم', 'Sketchbooks'],
        ]),
      },
      {
        code: 'paper.sheets',
        ar: 'ورق',
        en: 'Paper',
        attrs: ['paper_weight', 'color'],
        children: leaves('paper.sheets', [
          ['copy', 'ورق طباعة وتصوير', 'Copy & Printing Paper'],
          ['colored', 'ورق ملوّن ومقوّى', 'Coloured Paper & Card'],
          ['sticky', 'ملاحظات لاصقة', 'Sticky Notes'],
          ['photo', 'ورق فوتوغرافي', 'Photo Paper'],
        ]),
      },
      {
        code: 'paper.records',
        ar: 'سجلات وأجندات',
        en: 'Registers & Planners',
        children: leaves('paper.records', [
          ['ledgers', 'سجلات ودفاتر حسابات', 'Ledgers'],
          ['invoice_books', 'دفاتر فواتير وإيصالات', 'Invoice & Receipt Books'],
          ['planners', 'أجندات وتقاويم', 'Planners & Calendars'],
        ]),
      },
    ],
  },
  {
    code: 'school',
    ar: 'الأدوات المدرسية',
    en: 'School Supplies',
    kind: 'retail',
    policy: 'branch_banded',
    currency: 'SYP',
    attrs: ['color', 'theme'],
    children: [
      {
        code: 'school.geometry',
        ar: 'القياس والهندسة',
        en: 'Rulers & Geometry',
        attrs: ['length_cm'],
        children: leaves('school.geometry', [
          ['rulers', 'مساطر', 'Rulers'],
          ['sets', 'علب هندسة', 'Geometry Sets'],
          ['compasses', 'فرجار ومنقلة', 'Compasses & Protractors'],
        ]),
      },
      { code: 'school.erasers', ar: 'محايات وبرايات', en: 'Erasers & Sharpeners' },
      { code: 'school.scissors', ar: 'مقصات وقطّاعات', en: 'Scissors & Cutters' },
      {
        code: 'school.glue',
        ar: 'لاصق وغراء',
        en: 'Glue & Tape',
        children: leaves('school.glue', [
          ['liquid', 'غراء سائل', 'Liquid Glue'],
          ['sticks', 'أصابع لاصق', 'Glue Sticks'],
          ['tape', 'شريط لاصق', 'Adhesive Tape'],
        ]),
      },
      {
        code: 'school.covering',
        ar: 'تغليف الكتب',
        en: 'Book Covering',
        children: leaves('school.covering', [
          ['rolls', 'ورق تغليف كتب', 'Book Cover Rolls'],
          ['labels', 'ملصقات أسماء', 'Name Labels'],
        ]),
      },
    ],
  },
  {
    code: 'bags',
    ar: 'الحقائب والتنظيم المدرسي',
    en: 'Bags & School Organisation',
    kind: 'retail',
    policy: 'branch_free',
    currency: 'SYP',
    attrs: ['color', 'theme', 'capacity_ml'],
    children: [
      {
        code: 'bags.school',
        ar: 'حقائب مدرسية',
        en: 'School Bags',
        children: leaves('bags.school', [
          ['backpacks', 'ظهر', 'Backpacks'],
          ['trolley', 'بعجلات', 'Trolley Bags'],
          ['kindergarten', 'روضة', 'Kindergarten Bags'],
        ]),
      },
      { code: 'bags.pencil_cases', ar: 'مقلمات', en: 'Pencil Cases' },
      { code: 'bags.lunch', ar: 'علب طعام ومطرات', en: 'Lunch Boxes & Bottles' },
    ],
  },
  {
    code: 'art',
    ar: 'الألوان والرسم',
    en: 'Colours & Art',
    kind: 'retail',
    policy: 'branch_free',
    currency: 'SYP',
    attrs: ['color_count', 'color'],
    children: [
      {
        code: 'art.school',
        ar: 'ألوان مدرسية',
        en: 'School Colours',
        children: leaves('art.school', [
          ['pencils', 'خشبية', 'Colouring Pencils'],
          ['crayons', 'شمعية', 'Crayons'],
          ['felt', 'فلوماستر', 'Felt Pens'],
          ['water', 'مائية', 'Watercolours'],
        ]),
      },
      {
        code: 'art.pro',
        ar: 'ألوان احترافية',
        en: 'Professional Colours',
        // Imported: its price follows the exchange rate directly.
        policy: 'central_locked',
        currency: 'USD',
        children: leaves('art.pro', [
          ['oil', 'زيتية', 'Oil Colours'],
          ['acrylic', 'أكريليك', 'Acrylics'],
          ['gouache', 'مائية وغواش', 'Watercolour & Gouache'],
          ['pastel', 'باستيل وفحم', 'Pastel & Charcoal'],
        ]),
      },
      {
        code: 'art.supplies',
        ar: 'مستلزمات الرسم',
        en: 'Art Supplies',
        attrs: ['paper_size', 'paper_weight'],
        children: leaves('art.supplies', [
          ['brushes', 'فرش', 'Brushes'],
          ['canvas', 'كانفاس وحوامل', 'Canvas & Easels'],
          ['pads', 'دفاتر ولوحات رسم', 'Drawing Pads'],
          ['palettes', 'باليتات', 'Palettes'],
        ]),
      },
    ],
  },
  {
    code: 'crafts',
    ar: 'الأشغال اليدوية',
    en: 'Arts & Crafts',
    kind: 'retail',
    policy: 'branch_free',
    currency: 'SYP',
    attrs: ['color', 'material'],
    children: [
      { code: 'crafts.clay', ar: 'صلصال وطين', en: 'Clay & Modelling' },
      { code: 'crafts.stickers', ar: 'ملصقات وستيكرات', en: 'Stickers' },
      {
        code: 'crafts.materials',
        ar: 'مواد حرفية',
        en: 'Craft Materials',
        children: leaves('crafts.materials', [
          ['foam', 'فوم وكرتون ملوّن', 'Foam & Coloured Card'],
          ['beads', 'خرز وإكسسوارات', 'Beads & Accessories'],
          ['hot_glue', 'غراء حراري', 'Hot Glue'],
        ]),
      },
    ],
  },
  {
    code: 'office',
    ar: 'الأدوات المكتبية',
    en: 'Office Supplies',
    kind: 'retail',
    policy: 'branch_banded',
    currency: 'SYP',
    attrs: ['color', 'material'],
    children: [
      {
        code: 'office.filing',
        ar: 'الحفظ والتنظيم',
        en: 'Filing & Organisation',
        children: leaves('office.filing', [
          ['files', 'ملفات', 'Files & Folders'],
          ['sleeves', 'حافظات وفواصل', 'Sleeves & Dividers'],
          ['organisers', 'منظّمات مكتب', 'Desk Organisers'],
        ]),
      },
      {
        code: 'office.stapling',
        ar: 'التدبيس والتثقيب',
        en: 'Stapling & Punching',
        children: leaves('office.stapling', [
          ['staplers', 'دبّاسات ودبابيس', 'Staplers & Staples'],
          ['punches', 'خرّامات', 'Hole Punches'],
          ['clips', 'مشابك ودبابيس ورق', 'Clips & Pins'],
        ]),
      },
      {
        code: 'office.machines',
        ar: 'أجهزة مكتبية',
        en: 'Office Machines',
        children: leaves('office.machines', [
          ['calculators', 'آلات حاسبة', 'Calculators'],
          ['laminators', 'آلات تغليف حراري', 'Laminators'],
          ['cutters', 'قطّاعات وفرّامات', 'Cutters & Shredders'],
        ]),
      },
      { code: 'office.envelopes', ar: 'أظرف', en: 'Envelopes' },
      {
        code: 'office.boards',
        ar: 'سبورات',
        en: 'Boards',
        children: leaves('office.boards', [
          ['whiteboards', 'سبورة بيضاء', 'Whiteboards'],
          ['cork', 'لوح فلّين', 'Cork Boards'],
          ['accessories', 'ملحقات السبورة', 'Board Accessories'],
        ]),
      },
    ],
  },
  {
    code: 'gifts',
    ar: 'الهدايا والتغليف',
    en: 'Gifts & Wrapping',
    kind: 'retail',
    policy: 'branch_free',
    currency: 'SYP',
    attrs: ['color', 'theme', 'material'],
    children: [
      {
        code: 'gifts.wrapping',
        ar: 'تغليف الهدايا',
        en: 'Gift Wrapping',
        children: leaves('gifts.wrapping', [
          ['paper', 'ورق تغليف', 'Wrapping Paper'],
          ['bags', 'أكياس هدايا', 'Gift Bags'],
          ['boxes', 'صناديق هدايا', 'Gift Boxes'],
        ]),
      },
      {
        code: 'gifts.cards',
        ar: 'بطاقات ومناسبات',
        en: 'Cards & Occasions',
        children: leaves('gifts.cards', [
          ['greeting', 'بطاقات معايدة', 'Greeting Cards'],
          ['ribbons', 'شرائط وفيونكات', 'Ribbons & Bows'],
        ]),
      },
      {
        code: 'gifts.ready',
        ar: 'هدايا جاهزة',
        en: 'Ready Gifts',
        children: leaves('gifts.ready', [
          ['pen_sets', 'أطقم أقلام هدايا', 'Pen Gift Sets'],
          ['frames', 'براويز', 'Photo Frames'],
          ['desk_decor', 'ديكور مكتبي', 'Desk Décor'],
          ['keychains', 'ميداليات', 'Keychains'],
        ]),
      },
      {
        code: 'gifts.party',
        ar: 'الحفلات',
        en: 'Party',
        children: leaves('gifts.party', [
          ['balloons', 'بالونات', 'Balloons'],
          ['decorations', 'زينة', 'Decorations'],
        ]),
      },
    ],
  },
  {
    code: 'computing',
    ar: 'مستلزمات الحاسوب والطباعة',
    en: 'Computer & Printing Supplies',
    kind: 'retail',
    policy: 'central_locked',
    currency: 'USD',
    attrs: ['color'],
    children: [
      { code: 'computing.ink', ar: 'أحبار وتونر', en: 'Ink & Toner' },
      { code: 'computing.storage', ar: 'ذواكر وتخزين', en: 'Memory & Storage' },
      {
        code: 'computing.accessories',
        ar: 'ملحقات',
        en: 'Accessories',
        children: leaves('computing.accessories', [
          ['input', 'فأرة ولوحات مفاتيح', 'Mice & Keyboards'],
          ['cables', 'كابلات', 'Cables'],
        ]),
      },
    ],
  },
  {
    code: 'books',
    ar: 'الكتب والمطبوعات',
    en: 'Books',
    kind: 'retail',
    policy: 'central_locked',
    currency: 'SYP',
    children: [
      { code: 'books.kids', ar: 'كتب أطفال وتلوين', en: "Children's & Colouring Books" },
      { code: 'books.school', ar: 'كتب مدرسية ومساعدة', en: 'School & Study Books' },
      { code: 'books.fiction', ar: 'قصص وروايات', en: 'Stories & Novels' },
      { code: 'books.religious', ar: 'كتب دينية', en: 'Religious Books' },
    ],
  },
  {
    code: 'blanks',
    ar: 'خامات التخصيص',
    en: 'Customisation Blanks',
    kind: 'blank',
    attrs: ['apparel_size', 'capacity_ml', 'color', 'material'],
    children: [
      {
        code: 'blanks.mugs',
        ar: 'أكواب',
        en: 'Mugs',
        children: leaves('blanks.mugs', [
          ['ceramic', 'سيراميك', 'Ceramic Mugs'],
          ['magic', 'سحري', 'Magic Mugs'],
          ['steel', 'ستانلس', 'Stainless Steel'],
        ]),
      },
      {
        code: 'blanks.apparel',
        ar: 'ملابس',
        en: 'Apparel',
        children: leaves('blanks.apparel', [
          ['tshirts', 'تيشيرت', 'T-Shirts'],
          ['hoodies', 'هودي', 'Hoodies'],
          ['caps', 'قبّعات', 'Caps'],
        ]),
      },
      { code: 'blanks.notebooks', ar: 'دفاتر وأجندات للتخصيص', en: 'Custom Notebooks & Planners' },
      {
        code: 'blanks.accessories',
        ar: 'إكسسوارات',
        en: 'Accessories',
        children: leaves('blanks.accessories', [
          ['keychains', 'ميداليات', 'Keychains'],
          ['pillows', 'وسائد', 'Pillows'],
          ['mousepads', 'ماوس باد', 'Mouse Pads'],
        ]),
      },
      { code: 'blanks.frames', ar: 'براويز ولوحات', en: 'Frames & Panels' },
    ],
  },
  {
    code: 'production',
    ar: 'مواد الإنتاج',
    en: 'Production Materials',
    kind: 'raw_material',
    attrs: ['paper_size', 'paper_weight', 'color'],
    children: [
      { code: 'production.paper', ar: 'ورق الإنتاج', en: 'Production Paper' },
      { code: 'production.ink', ar: 'أحبار وتونر الإنتاج', en: 'Production Ink & Toner' },
      {
        code: 'production.binding',
        ar: 'مواد التجليد',
        en: 'Binding Materials',
        children: leaves('production.binding', [
          ['coils', 'سلك', 'Binding Coils'],
          ['covers', 'أغلفة شفافة', 'Clear Covers'],
          ['boards', 'كرتون ظهر', 'Back Boards'],
        ]),
      },
      { code: 'production.lamination', ar: 'أفلام التغليف الحراري', en: 'Lamination Film' },
      { code: 'production.sublimation', ar: 'مواد النقل الحراري', en: 'Sublimation Materials' },
    ],
  },
];

const BRANDS = [
  'Faber-Castell',
  'Staedtler',
  'Pelikan',
  'Stabilo',
  'Bic',
  'Pilot',
  'Uni-ball',
  'Maped',
  'Deli',
  'M&G',
  'Canson',
  'Double A',
];

export async function seedCatalogReference(): Promise<void> {
  const created = { units: 0, attributes: 0, values: 0, categories: 0, brands: 0 };

  for (const [i, unit] of UNITS.entries()) {
    const rows = await db
      .insert(catalogUnitsTable)
      .values({
        code: unit.code,
        name_ar: unit.ar,
        name_en: unit.en,
        allows_fraction: unit.fraction ?? false,
        sort_order: i,
      })
      .onConflictDoNothing({ target: catalogUnitsTable.code })
      .returning({ id: catalogUnitsTable.id });
    created.units += rows.length;
  }

  const typeIdByCode = new Map<string, number>();
  for (const [i, attr] of ATTRIBUTES.entries()) {
    await db
      .insert(catalogAttributeTypesTable)
      .values({
        code: attr.code,
        name_ar: attr.ar,
        name_en: attr.en,
        display: attr.display ?? 'text',
        sort_order: i,
      })
      .onConflictDoNothing({ target: catalogAttributeTypesTable.code })
      .returning({ id: catalogAttributeTypesTable.id })
      .then((rows) => (created.attributes += rows.length));
    const [type] = await db
      .select({ id: catalogAttributeTypesTable.id })
      .from(catalogAttributeTypesTable)
      .where(eq(catalogAttributeTypesTable.code, attr.code));
    typeIdByCode.set(attr.code, type!.id);

    for (const [j, [ar, en, hex]] of attr.values.entries()) {
      const rows = await db
        .insert(catalogAttributeValuesTable)
        .values({
          attribute_type_id: type!.id,
          value_ar: ar,
          value_en: en,
          value_normalized: normalizeArabic(ar),
          color_hex: hex ?? null,
          sort_order: j,
        })
        .onConflictDoNothing()
        .returning({ id: catalogAttributeValuesTable.id });
      created.values += rows.length;
    }
  }

  const walk = async (nodes: SeedCategory[], parentId: number | null, level: number) => {
    for (const [i, node] of nodes.entries()) {
      const inserted = await db
        .insert(catalogCategoriesTable)
        .values({
          code: node.code,
          parent_id: parentId,
          level,
          name_ar: node.ar,
          name_en: node.en,
          product_kind: node.kind ?? null,
          price_policy: node.policy ?? null,
          pricing_currency: node.currency ?? null,
          sort_order: i,
        })
        .onConflictDoNothing({ target: catalogCategoriesTable.code })
        .returning({ id: catalogCategoriesTable.id });

      let id: number;
      if (inserted[0]) {
        id = inserted[0].id;
        created.categories += 1;
        const attrs = (node.attrs ?? []).map((code) => typeIdByCode.get(code)!);
        if (attrs.length > 0) {
          await db
            .insert(catalogCategoryAttributesTable)
            .values(attrs.map((attribute_type_id) => ({ category_id: id, attribute_type_id })));
        }
      } else {
        const [existing] = await db
          .select({ id: catalogCategoriesTable.id })
          .from(catalogCategoriesTable)
          .where(eq(catalogCategoriesTable.code, node.code));
        id = existing!.id;
      }
      if (node.children) await walk(node.children, id, level + 1);
    }
  };
  await walk(TREE, null, 1);

  for (const name of BRANDS) {
    const rows = await db
      .insert(catalogBrandsTable)
      .values({ name, name_normalized: normalizeArabic(name) })
      .onConflictDoNothing({ target: catalogBrandsTable.name_normalized })
      .returning({ id: catalogBrandsTable.id });
    created.brands += rows.length;
  }

  logger.info(
    created,
    'Catalog reference data seeded (insert-if-missing — existing rows untouched)',
  );
}
