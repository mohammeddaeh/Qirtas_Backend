/**
 * Showcase dataset — `npm run db:showcase` (= `db:seed -- --showcase`).
 *
 * Builds a catalog of ~64 stationery products with real photos and
 * descriptions, then walks every workflow into every state it has — stock
 * documents, pricing, promotions, collections, till sales and returns, online
 * orders, print jobs — so each screen of the app has something to show.
 *
 * The orchestrator (`seed.ts`) empties the business tables first
 * (`seed-wipe.ts`) and re-creates the reference data; this step only builds.
 *
 * Everything goes through the real HTTP API of an in-process app (the e2e
 * harness pattern in tests/), so every row passes the same rules, state
 * machines and ledgers the phone would. A handful of timestamps are back-dated
 * with SQL afterwards (age of drafts, expired reservations, sales history
 * spread over a month) — states that only time can produce.
 *
 * Photos come from Wikimedia Commons search (free licences), falling back to
 * picsum.photos, and are cached under the OS temp dir so a re-run is fast.
 * Offline, products are created without photos rather than failing.
 *
 * Needs the Super Admin (`--admin`, credentials from `SEED_ADMIN_*`) and three
 * active branches — the default one plus the demo branches «فرع دمشق - المزة»
 * and «فرع حلب - الفرقان» when they exist (`--demo`). Dev only.
 *
 * Invoked by the orchestrator in `seed.ts`; never opens or closes the pool.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import sharp from 'sharp';
import { db } from './client.js';
import { env } from '../config/env.js';
import { logger } from '../logger/logger.js';
import { buildApp } from '../../app.js';
import { setEmailSender, type EmailSender } from '../auth/ports/email-sender.js';
import { createSession } from '../auth/services/session.service.js';
import { staffAuthRealm } from '../../features/identity/auth-realm.js';
import { customerAuthRealm } from '../../features/customers/auth-realm.js';

const ADMIN_EMAIL = process.env['SEED_ADMIN_EMAIL'] ?? 'super_admin@admin.com';
const ADMIN_PASSWORD = process.env['SEED_ADMIN_PASSWORD'] ?? 'P@ssw0rd@123';
const CUSTOMER_PASSWORD = 'Qirtas@2026';

/** Branches the dataset lives in — resolved by name at run time, see `resolveBranches`. */
let B1 = 0;
let B2 = 0;
let B3 = 0;
const SECOND_BRANCH = 'فرع دمشق - المزة';
const THIRD_BRANCH = 'فرع حلب - الفرقان';

async function resolveBranches(): Promise<void> {
  const rows = (
    await db.execute<{ id: number; name: string; is_default: boolean }>(
      sql`select id, name, is_default from branches
          where archived_at is null and status = 'active'
          order by is_default desc, id`,
    )
  ).rows;
  if (rows.length < 3) {
    throw new Error(`showcase needs 3 active branches, found ${rows.length} — run with --demo`);
  }
  B1 = rows[0]!.id;
  const rest = rows.slice(1);
  const pick = (name: string) => rest.find((r) => r.name === name) ?? rest.find((r) => r.id !== B2)!;
  B2 = pick(SECOND_BRANCH).id;
  B3 = (rest.find((r) => r.name === THIRD_BRANCH && r.id !== B2) ?? rest.find((r) => r.id !== B2)!).id;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. HTTP harness
// ─────────────────────────────────────────────────────────────────────────────

let server: Server | undefined;
let ORIGIN = '';
let API = '';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly key: string | undefined,
    readonly body: Any,
    where: string,
  ) {
    super(`${where} → ${status} ${key ?? ''} ${JSON.stringify(body?.data ?? body?.errors ?? body?.message ?? '').slice(0, 300)}`);
  }
}

async function call(method: string, path: string, body?: unknown, token?: string): Promise<Any> {
  const r = await fetch(API + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await r.json().catch(() => null)) as Any;
  if (!r.ok || json?.status === false) {
    throw new ApiError(r.status, json?.data?.message_key ?? json?.message_key, json, `${method} ${path}`);
  }
  return json?.data;
}

let failures = 0;
function log(msg: string): void {
  console.log(`  ${msg}`);
}
/** One scenario: a failure is reported and the run goes on — one broken state must not cost all the others. */
async function step<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    failures++;
    console.log(`  ❌ ${name}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
function section(title: string): void {
  console.log(`\n▶ ${title}`);
}

let ST = ''; // staff (super admin) token
const S = (method: string, path: string, body?: unknown) => call(method, path, body, ST);

const days = (n: number) => new Date(Date.now() + n * 86_400_000);
const iso = (d: Date) => d.toISOString();

// ─────────────────────────────────────────────────────────────────────────────
// 3. Images
// ─────────────────────────────────────────────────────────────────────────────

const CACHE = join(tmpdir(), 'qirtas-showcase-img');
mkdirSync(CACHE, { recursive: true });
const UA = 'QirtasDevSeed/1.0 (local development test data)';

async function commonsCandidates(query: string): Promise<string[]> {
  const cacheFile = join(CACHE, `q_${hash(query)}.json`);
  if (existsSync(cacheFile)) return JSON.parse(readFileSync(cacheFile, 'utf8')) as string[];
  const url =
    'https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search' +
    `&gsrsearch=${encodeURIComponent(`${query} filetype:bitmap`)}&gsrnamespace=6&gsrlimit=15` +
    '&prop=imageinfo&iiprop=url|mime|size&iiurlwidth=960';
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA } });
    const json = (await r.json()) as Any;
    const pages = Object.values(json?.query?.pages ?? {}) as Any[];
    const urls = pages
      .sort((a, b) => a.index - b.index)
      .map((p) => p.imageinfo?.[0])
      .filter(
        (i) =>
          i &&
          (i.mime === 'image/jpeg' || i.mime === 'image/png') &&
          Math.min(i.width, i.height) >= 400,
      )
      .map((i) => i.thumburl as string);
    writeFileSync(cacheFile, JSON.stringify(urls));
    return urls;
  } catch {
    return [];
  }
}

function hash(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 16);
}

async function download(url: string): Promise<Buffer | null> {
  const file = join(CACHE, `i_${hash(url)}.bin`);
  if (existsSync(file)) return readFileSync(file);
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow' });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    const meta = await sharp(buf).metadata();
    if (!meta.width || !meta.height || Math.min(meta.width, meta.height) < 250) return null;
    // Square-ish product shots: centre-crop to 1:1 so every card looks alike.
    const edge = Math.min(meta.width, meta.height);
    const out = await sharp(buf)
      .rotate()
      .resize({ width: edge, height: edge, fit: 'cover' })
      .jpeg({ quality: 85 })
      .toBuffer();
    writeFileSync(file, out);
    return out;
  } catch {
    return null;
  }
}

/** Up to `n` photos for a search phrase, skipping the first `offset` hits. */
async function photos(query: string, n: number, offset = 0): Promise<Buffer[]> {
  const out: Buffer[] = [];
  const candidates = (await commonsCandidates(query)).slice(offset);
  for (const url of candidates) {
    if (out.length >= n) break;
    const b = await download(url);
    if (b) out.push(b);
  }
  for (let i = 0; out.length < n && i < n + 3; i++) {
    const b = await download(`https://picsum.photos/seed/${encodeURIComponent(`${query}-${offset}-${i}`)}/900/900`);
    if (b) out.push(b);
  }
  return out;
}

async function uploadImage(bytes: Buffer, path = '/catalog/media/images'): Promise<number | null> {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'image/jpeg' }), 'photo.jpg');
  const r = await fetch(API + path, {
    method: 'POST',
    headers: { authorization: `Bearer ${ST}` },
    body: form,
  });
  const json = (await r.json().catch(() => null)) as Any;
  if (r.status !== 201) {
    log(`image upload ${r.status} ${json?.data?.message_key ?? ''}`);
    return null;
  }
  return json.data.id as number;
}

async function uploadPhotos(query: string, n: number, offset = 0): Promise<number[]> {
  const ids: number[] = [];
  for (const b of await photos(query, n, offset)) {
    const id = await uploadImage(b);
    if (id) ids.push(id);
  }
  return ids;
}

/** A flat logo tile — brand marks on Commons are mostly SVG wordmarks too thin to pass the 200 px rule. */
async function logoTile(text: string, bg: string, fg = '#ffffff'): Promise<Buffer> {
  const safe = text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const size = safe.length > 9 ? 64 : 84;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600">
    <rect width="600" height="600" rx="80" fill="${bg}"/>
    <circle cx="300" cy="230" r="90" fill="${fg}" fill-opacity="0.18"/>
    <text x="300" y="420" font-family="Segoe UI, Arial, sans-serif" font-size="${size}" font-weight="700"
      fill="${fg}" text-anchor="middle">${safe}</text></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Reference lookups
// ─────────────────────────────────────────────────────────────────────────────

const unitId = new Map<string, number>(); // code → id
const catId = new Map<string, number>(); // code → id
const brandId = new Map<string, number>(); // name → id
const attrValue = new Map<string, { id: number; en: string | null }>(); // `${attrCode}:${value_ar}` → value

async function loadReference(): Promise<void> {
  for (const u of (await S('GET', '/catalog/units')) as Any[]) if (u.code) unitId.set(u.code, u.id);
  for (const c of (await S('GET', '/catalog/categories')) as Any[]) if (c.code) catId.set(c.code, c.id);
  const brands = await S('GET', '/catalog/brands?limit=100');
  for (const b of brands.items as Any[]) brandId.set(b.name, b.id);
  const attrs = (await S('GET', '/catalog/attributes')) as Any[];
  const codeByName: Record<string, string> = {
    'اللون': 'color',
    'سماكة الرأس (مم)': 'tip_size',
    'درجة الرصاص': 'lead_grade',
    'مقاس الورق': 'paper_size',
    'عدد الأوراق': 'sheet_count',
    'التسطير': 'ruling',
    'وزن الورق (غ/م²)': 'paper_weight',
    'عدد الألوان': 'color_count',
    'نوع الغلاف': 'cover_type',
    'التجليد': 'binding',
    'الطول (سم)': 'length_cm',
    'السعة (مل)': 'capacity_ml',
    'المقاس (ملابس)': 'apparel_size',
    'الثيم': 'theme',
    'المادة': 'material',
  };
  for (const a of attrs) {
    const code = a.code ?? codeByName[a.name_ar];
    for (const v of a.values as Any[]) attrValue.set(`${code}:${v.value_ar}`, { id: v.id, en: v.value_en });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. The catalog
// ─────────────────────────────────────────────────────────────────────────────

type Axis = [attr: string, values: string[]];

interface ProductSpec {
  key: string;
  cat: string;
  brand?: string;
  ar: string;
  en: string;
  dAr: string;
  dEn: string;
  kw?: string[];
  /** Commons search phrase for the gallery. */
  img: string;
  imgCount?: number;
  /** One photo per variant, searched as `<value in English> <img>` along the first axis. */
  variantImages?: boolean;
  axes?: Axis[];
  base?: string;
  /** Extra sale units: [unit code, factor]. */
  units?: [string, number][];
  /** Central price per variant (SYP unless `usd`). A function gets the variant's combination. */
  price?: number | ((combo: string[], i: number) => number);
  usd?: boolean;
  wholesale?: { off: number; min: number };
  /**
   * On hand per branch *slot* — 1 main, 2 second, 3 third (resolved to ids at
   * run time). A number applies to every variant, an array is per variant.
   */
  stock?: Partial<Record<1 | 2 | 3, number | number[]>>;
  status?: 'draft' | 'active' | 'discontinued';
  sellable?: false;
  expiresInDays?: number;
}

const P: ProductSpec[] = [
  // ── Writing ──────────────────────────────────────────────────────────────
  {
    key: 'bic', cat: 'writing.pens.ballpoint', brand: 'Bic',
    ar: 'قلم جاف بيك كريستال', en: 'Bic Cristal Ballpoint Pen',
    dAr: 'القلم الجاف الأشهر عالمياً: رأس ١٫٠ مم، حبر ينساب بسلاسة ويكفي لكتابة أكثر من ٢ كم. جسم شفاف سداسي يُظهر مستوى الحبر، وغطاء بلون الحبر نفسه. مثالي للمدرسة والمكتب.',
    dEn: 'The world’s best-known ballpoint: 1.0 mm tip, smooth ink that writes over 2 km. Clear hexagonal barrel shows the ink level, cap matches the ink colour.',
    kw: ['قلم ازرق', 'بيك', 'قلم ناشف'], img: 'ballpoint pen', variantImages: true,
    axes: [['color', ['أزرق', 'أسود', 'أحمر', 'أخضر']]], units: [['box', 50]],
    price: 1500, wholesale: { off: 1200, min: 50 }, stock: { 1: [240, 180, 90, 60], 2: 120, 3: 80 },
  },
  {
    key: 'g2', cat: 'writing.pens.gel', brand: 'Pilot',
    ar: 'قلم جل بايلوت G2', en: 'Pilot G2 Gel Pen',
    dAr: 'قلم جل بضغطة زر وقبضة مطاطية مريحة. حبر جل كثيف يجف بسرعة ولا يلطّخ الورق — الخيار المفضّل لطلاب الجامعة وكتابة الملاحظات الطويلة.',
    dEn: 'Retractable gel pen with a comfortable rubber grip. Dense, fast-drying gel ink that does not smear.',
    img: 'gel pen', axes: [['color', ['أزرق', 'أسود']], ['tip_size', ['0.5', '0.7']]],
    price: (c) => (c[1] === '0.5' ? 4500 : 4000),
    stock: { 1: [40, 3, 25, 0], 2: [10, 10, 10, 15] },
  },
  {
    key: 'rollerball', cat: 'writing.pens.rollerball', brand: 'Uni-ball',
    ar: 'قلم رولر يوني-بول آي', en: 'Uni-ball Eye Rollerball',
    dAr: 'قلم حبر سائل برأس ٠٫٥ مم ونافذة لرؤية الحبر. حبر مقاوم للماء والبهتان — مناسب للتوقيع والوثائق الرسمية.',
    dEn: 'Liquid-ink rollerball, 0.5 mm, with an ink window. Water- and fade-resistant ink for signatures and documents.',
    img: 'rollerball pen', price: 6000, stock: { 1: 0, 2: 20 },
  },
  {
    key: 'fountain', cat: 'writing.pens.premium', brand: 'Pelikan',
    ar: 'قلم حبر فاخر بيليكان', en: 'Pelikan Fountain Pen',
    dAr: 'قلم حبر سائل ألماني بريشة من الفولاذ المصقول وجسم معدني متين، يأتي في علبة هدية أنيقة. هدية مثالية للتخرّج والمناسبات.',
    dEn: 'German fountain pen with a polished steel nib and a solid metal body, in an elegant gift box.',
    img: 'fountain pen', imgCount: 3, price: 350000, stock: { 1: 2, 2: 1 },
  },
  {
    key: 'noris', cat: 'writing.pencils.wooden', brand: 'Staedtler',
    ar: 'قلم رصاص ستيدلر نوريس', en: 'Staedtler Noris Pencil',
    dAr: 'قلم الرصاص المدرسي الكلاسيكي بخطوطه الصفراء والسوداء، مع ممحاة في الطرف. رصاص مقاوم للكسر ويُبرى بسهولة.',
    dEn: 'The classic yellow-and-black school pencil with an eraser tip. Break-resistant lead, easy to sharpen.',
    img: 'wooden pencil', axes: [['lead_grade', ['HB', '2B', '4B']]], units: [['dozen', 12]],
    price: 800, stock: { 1: [600, 300, 120], 2: 200, 3: 150 },
  },
  {
    key: 'mech', cat: 'writing.pencils.mechanical', brand: 'M&G',
    ar: 'قلم رصاص ميكانيكي', en: 'Mechanical Pencil',
    dAr: 'قلم رصاص ميكانيكي بقبضة مريحة وآلية تغذية دقيقة، مع ممحاة قابلة للاستبدال.',
    dEn: 'Mechanical pencil with a soft grip, precise lead advance and a replaceable eraser.',
    img: 'mechanical pencil', axes: [['tip_size', ['0.5', '0.7']]], price: 3500, stock: { 1: 45, 2: 20 },
  },
  {
    key: 'leads', cat: 'writing.pencils.leads', brand: 'Faber-Castell',
    ar: 'رصاص بديل ٠٫٥ مم', en: 'Refill Leads 0.5 mm',
    dAr: 'علبة ١٢ رصاصة بديلة بدرجة HB، مقاومة للكسر ومناسبة لكل الأقلام الميكانيكية ٠٫٥ مم.',
    dEn: 'Tube of 12 HB refill leads, break-resistant, for any 0.5 mm mechanical pencil.',
    img: 'pencil leads', imgCount: 1, price: 1200, stock: { 1: 80 },
  },
  {
    key: 'stabilo', cat: 'writing.markers.highlighter', brand: 'Stabilo',
    ar: 'قلم فوسفوري ستابيلو بوس', en: 'Stabilo Boss Highlighter',
    dAr: 'القلم الفوسفوري الأيقوني بشكله المسطّح. رأس مشطوف للخطوط العريضة والرفيعة، وحبر فلوري لا يجف بسرعة إذا تُرك مفتوحاً حتى ٤ ساعات.',
    dEn: 'The iconic flat highlighter. Chisel tip for broad and fine lines; anti-dry-out ink lasts up to 4 hours uncapped.',
    img: 'highlighter pen', variantImages: true,
    axes: [['color', ['أصفر', 'أخضر', 'وردي', 'برتقالي']]], price: 3000, stock: { 1: 60, 2: 30, 3: 25 },
  },
  {
    key: 'wb_marker', cat: 'writing.markers.whiteboard', brand: 'Deli',
    ar: 'ماركر سبورة بيضاء', en: 'Whiteboard Marker',
    dAr: 'ماركر سبورة قابل للمسح الجاف، حبر منخفض الرائحة ورأس مستدير متين.',
    dEn: 'Dry-erase whiteboard marker, low-odour ink, durable bullet tip.',
    img: 'whiteboard marker', axes: [['color', ['أسود', 'أزرق', 'أحمر']]], price: 2500, stock: { 1: 10 },
  },
  {
    key: 'permanent', cat: 'writing.markers.permanent', brand: 'Staedtler',
    ar: 'ماركر دائم لوموكولور', en: 'Lumocolor Permanent Marker',
    dAr: 'ماركر دائم يكتب على كل السطوح: البلاستيك والزجاج والمعدن والكرتون. حبر مقاوم للماء يجف خلال ثوانٍ.',
    dEn: 'Permanent marker for every surface — plastic, glass, metal, cardboard. Waterproof, dries in seconds.',
    img: 'permanent marker', price: 2800, stock: { 2: 40, 3: 20 },
  },
  {
    key: 'calligraphy', cat: 'writing.markers.calligraphy',
    ar: 'طقم أقلام خط عربي', en: 'Arabic Calligraphy Pen Set',
    dAr: 'طقم ٦ أقلام خط عربي بسماكات مختلفة (١٫٥ – ٦ مم) لخطوط النسخ والرقعة والثلث، مع دليل مبسّط للمبتدئين.',
    dEn: 'Set of 6 calligraphy pens (1.5–6 mm) for Naskh, Ruq’ah and Thuluth, with a beginner’s guide.',
    img: 'arabic calligraphy', imgCount: 3, price: 7000, stock: { 1: 18 },
  },
  {
    key: 'tape', cat: 'writing.correction.tape', brand: 'Deli',
    ar: 'شريط تصحيح ٥ مم', en: 'Correction Tape 5 mm',
    dAr: 'شريط تصحيح جاف بطول ٨ أمتار — اكتب فوقه فوراً بلا انتظار. غطاء واقٍ للرأس.',
    dEn: '8 m dry correction tape — write over it instantly. Protective tip cover.',
    img: 'correction tape', price: 2200, stock: { 1: 35, 2: 20 },
  },
  // ── Paper ────────────────────────────────────────────────────────────────
  {
    key: 'school_nb', cat: 'paper.notebooks.school',
    ar: 'دفتر مدرسي', en: 'School Notebook',
    dAr: 'دفتر مدرسي بورق أبيض ٧٠ غرام لا يشفّ الحبر، غلاف مقوّى ملوّن وجدول ضرب على الغلاف الخلفي.',
    dEn: 'School notebook, 70 gsm white paper that does not bleed, colourful card cover with a times table on the back.',
    kw: ['دفتر', 'كراسة'], img: 'school notebook exercise book', imgCount: 3,
    axes: [['sheet_count', ['60', '100', '200']], ['ruling', ['مسطّر', 'مربعات']]],
    units: [['carton', 40]],
    price: (c) => ({ '60': 2500, '100': 3500, '200': 6000 })[c[0]!]!,
    wholesale: { off: 0.85, min: 20 },
    stock: { 1: [300, 200, 250, 150, 80, 40], 2: 100, 3: 60 },
  },
  {
    key: 'spiral', cat: 'paper.notebooks.spiral', brand: 'Canson',
    ar: 'دفتر سلكي بغلاف بلاستيك', en: 'Spiral Notebook',
    dAr: 'دفتر سلكي بفواصل ملوّنة وغلاف بلاستيكي مقاوم للماء، أوراق مثقّبة سهلة النزع.',
    dEn: 'Spiral notebook with colour dividers, water-resistant plastic cover and micro-perforated pages.',
    img: 'spiral notebook', axes: [['paper_size', ['A4', 'A5']]],
    price: (c) => (c[0] === 'A4' ? 9000 : 6500), stock: { 1: 30, 2: 12 },
  },
  {
    key: 'journal', cat: 'paper.notebooks.diaries',
    ar: 'مفكرة جلدية فاخرة', en: 'Leather Journal',
    dAr: 'مفكرة بغلاف من الجلد الصناعي وخيط إشارة وشريط مطاطي للإغلاق. ١٩٢ صفحة بورق كريمي ٨٠ غرام.',
    dEn: 'Faux-leather journal with ribbon marker and elastic closure. 192 pages of 80 gsm cream paper.',
    img: 'leather journal notebook', imgCount: 3, price: 12000, stock: { 1: 14, 3: 6 },
  },
  {
    key: 'sketch', cat: 'paper.notebooks.sketch', brand: 'Canson',
    ar: 'دفتر رسم كانسون', en: 'Canson Sketchbook',
    dAr: 'دفتر رسم بورق ١٢٠ غرام خالٍ من الأحماض، مناسب للرصاص والفحم والحبر.',
    dEn: 'Acid-free 120 gsm sketch paper for pencil, charcoal and ink.',
    img: 'sketchbook drawing', axes: [['paper_size', ['A4', 'A3']]],
    price: (c) => (c[0] === 'A4' ? 9000 : 15000), stock: { 1: 20, 2: 8 },
  },
  {
    key: 'copy_paper', cat: 'paper.sheets.copy', brand: 'Double A',
    ar: 'ورق طباعة دبل إيه ٨٠ غرام', en: 'Double A Copy Paper 80 gsm',
    dAr: 'رزمة ٥٠٠ ورقة بيضاء ناصعة ٨٠ غرام، تمرّ في الطابعة بلا انحشار. مناسبة للطابعات الليزرية والنافثة للحبر وآلات التصوير.',
    dEn: 'Ream of 500 bright-white 80 gsm sheets that feed jam-free. For laser, inkjet and copiers.',
    kw: ['ورق A4', 'رزمة ورق'], img: 'ream of paper', base: 'ream', units: [['carton', 5]],
    axes: [['paper_size', ['A4', 'A3']]], price: (c) => (c[0] === 'A4' ? 65000 : 130000),
    wholesale: { off: 0.9, min: 5 }, stock: { 1: [120, 20], 2: 40, 3: 30 },
  },
  {
    key: 'colored_paper', cat: 'paper.sheets.colored',
    ar: 'ورق ملوّن مقوّى ١٦٠ غرام', en: 'Coloured Card 160 gsm',
    dAr: 'ورق مقوّى بألوان زاهية للأشغال اليدوية والبطاقات والمشاريع المدرسية.',
    dEn: 'Bright coloured card for crafts, cards and school projects.',
    img: 'colored paper', axes: [['color', ['أحمر', 'أزرق', 'أصفر', 'أخضر']]], price: 500, stock: { 1: 400 },
  },
  {
    key: 'sticky', cat: 'paper.sheets.sticky',
    ar: 'ملاحظات لاصقة ٧٦×٧٦', en: 'Sticky Notes 76×76',
    dAr: 'مكعّب ١٠٠ ورقة لاصقة تُنزع وتُلصق مراراً بلا أثر.',
    dEn: 'Pad of 100 repositionable sticky notes that leave no residue.',
    img: 'sticky notes', axes: [['color', ['أصفر', 'وردي', 'أخضر']]], price: 1800, stock: { 1: 90, 2: 30 },
  },
  {
    key: 'invoice_book', cat: 'paper.records.invoice_books', status: 'draft',
    ar: 'دفتر فواتير ثلاثي النسخ', en: 'Triplicate Invoice Book',
    dAr: 'دفتر فواتير مرقّم بثلاث نسخ كربونية. (مسودة — لم يُنشر بعد)',
    dEn: 'Numbered invoice book, three carbonless copies. (Draft — not published yet)',
    img: 'receipt book', imgCount: 1, price: 3000,
  },
  {
    key: 'planner', cat: 'paper.records.planners',
    ar: 'أجندة ٢٠٢٧ اليومية', en: 'Daily Planner 2027',
    dAr: 'أجندة يومية لعام ٢٠٢٧ بصفحة لكل يوم، تقويم سنوي وصفحات للأهداف والملاحظات.',
    dEn: '2027 daily planner, a page per day, yearly calendar and goal pages.',
    img: 'planner diary', price: 15000, stock: { 1: 25 },
  },
  // ── School ───────────────────────────────────────────────────────────────
  {
    key: 'ruler', cat: 'school.geometry.rulers', brand: 'Maped',
    ar: 'مسطرة بلاستيك شفافة', en: 'Clear Plastic Ruler',
    dAr: 'مسطرة شفافة بتدريج دقيق بالسنتيمتر والمليمتر، مرنة ومقاومة للكسر.',
    dEn: 'Clear ruler with precise cm/mm scale, flexible and shatter-resistant.',
    img: 'plastic ruler', axes: [['length_cm', ['15', '20', '30']]],
    price: (c) => ({ '15': 700, '20': 900, '30': 1200 })[c[0]!]!, stock: { 1: 150, 2: 60 },
  },
  {
    key: 'geo_set', cat: 'school.geometry.sets', brand: 'Maped',
    ar: 'علبة هندسة معدنية', en: 'Metal Geometry Set',
    dAr: 'علبة هندسة كاملة: فرجار معدني، منقلة، مثلثان، مسطرة، براية ومحاية — في علبة معدنية متينة.',
    dEn: 'Complete geometry set: metal compass, protractor, two set squares, ruler, sharpener and eraser in a tin.',
    img: 'geometry set compass', imgCount: 3, price: 9000, stock: { 1: 40, 3: 10 },
  },
  {
    key: 'eraser', cat: 'school.erasers', brand: 'Faber-Castell',
    ar: 'محاية بيضاء فابر كاستل', en: 'Faber-Castell White Eraser',
    dAr: 'محاية بيضاء خالية من PVC تمسح الرصاص بنظافة دون أن تمزّق الورق.',
    dEn: 'PVC-free white eraser that erases cleanly without tearing paper.',
    img: 'rubber eraser', price: 500, wholesale: { off: 400, min: 30 }, units: [['box', 30]],
    stock: { 1: 900, 2: 300, 3: 200 },
  },
  {
    key: 'scissors', cat: 'school.scissors', brand: 'Maped',
    ar: 'مقص أطفال آمن', en: 'Kids Safety Scissors',
    dAr: 'مقص برؤوس مستديرة آمنة للأطفال ومقابض مريحة لليد اليمنى واليسرى.',
    dEn: 'Round-tip safety scissors with comfortable handles for left and right hands.',
    img: 'scissors', variantImages: true, axes: [['color', ['أزرق', 'وردي']]], price: 2000, stock: { 1: 50 },
  },
  {
    key: 'liquid_glue', cat: 'school.glue.liquid', brand: 'Pelikan', status: 'discontinued',
    ar: 'غراء سائل ٥٠ مل', en: 'Liquid Glue 50 ml',
    dAr: 'غراء أبيض سائل للورق والكرتون. (متوقّف عن البيع)', dEn: 'White liquid glue for paper and card. (Discontinued)',
    img: 'glue bottle', imgCount: 1, price: 1500, stock: { 1: 5 },
  },
  {
    key: 'glue_stick', cat: 'school.glue.sticks', brand: 'Pelikan',
    ar: 'إصبع لاصق ٢١ غرام', en: 'Glue Stick 21 g',
    dAr: 'إصبع لاصق نظيف وآمن للأطفال، خالٍ من المذيبات، يُغسل بالماء.',
    dEn: 'Clean, child-safe glue stick, solvent-free and washable.',
    img: 'glue stick', price: 1800, stock: { 1: 70, 2: 25 }, expiresInDays: 20,
  },
  {
    key: 'adhesive', cat: 'school.glue.tape', brand: 'Deli',
    ar: 'شريط لاصق شفاف مع حامل', en: 'Clear Tape with Dispenser',
    dAr: 'شريط لاصق شفاف ١٨ مم × ٢٠ م مع حامل بشفرة قطع آمنة.', dEn: 'Clear tape 18 mm × 20 m with a safe cutting dispenser.',
    img: 'adhesive tape dispenser', price: 1000, stock: { 1: 100 },
  },
  // ── Bags ─────────────────────────────────────────────────────────────────
  {
    key: 'backpack', cat: 'bags.school.backpacks',
    ar: 'حقيبة ظهر مدرسية', en: 'School Backpack',
    dAr: 'حقيبة ظهر مدرسية بظهر مبطّن يوزّع الوزن، ثلاثة جيوب وجيب جانبي للمطرة، وأشرطة عاكسة للأمان.',
    dEn: 'School backpack with a padded back, three pockets, a bottle pocket and reflective safety strips.',
    img: 'school backpack', variantImages: true, imgCount: 3,
    axes: [['color', ['أزرق', 'وردي', 'أسود']]], price: 85000, stock: { 1: [12, 8, 4], 2: 6, 3: 5 },
  },
  {
    key: 'trolley', cat: 'bags.school.trolley',
    ar: 'حقيبة مدرسية بعجلات', en: 'Trolley School Bag',
    dAr: 'حقيبة بعجلات صامتة ومقبض قابل للسحب بثلاث مستويات — تخفّف الحمل عن ظهر الطفل.',
    dEn: 'Trolley bag with silent wheels and a 3-level telescopic handle — takes the load off a child’s back.',
    img: 'trolley bag', price: 150000, stock: { 1: 3 },
  },
  {
    key: 'pencil_case', cat: 'bags.pencil_cases',
    ar: 'مقلمة بطبقتين', en: 'Two-Layer Pencil Case',
    dAr: 'مقلمة بسحّابين وطبقتين تتسع لـ٣٠ قلماً، قماش متين سهل التنظيف.',
    dEn: 'Two-zip, two-layer pencil case holding 30 pens, durable easy-clean fabric.',
    img: 'pencil case', variantImages: true, axes: [['color', ['أزرق', 'بنفسجي', 'رمادي']]],
    price: 12000, stock: { 1: 25, 2: 10 },
  },
  {
    key: 'bottle', cat: 'bags.lunch',
    ar: 'مطرة ماء للأطفال', en: 'Kids Water Bottle',
    dAr: 'مطرة خالية من BPA بغطاء قلّاب ومصّاصة، لا تسرّب في الحقيبة.',
    dEn: 'BPA-free bottle with a flip lid and straw, leak-proof in the bag.',
    img: 'water bottle', axes: [['capacity_ml', ['500', '750']]],
    price: (c) => (c[0] === '500' ? 18000 : 22000), stock: { 1: 30 },
  },
  // ── Art ──────────────────────────────────────────────────────────────────
  {
    key: 'colored_pencils', cat: 'art.school.pencils', brand: 'Faber-Castell',
    ar: 'ألوان خشبية فابر كاستل', en: 'Faber-Castell Colour Pencils',
    dAr: 'ألوان خشبية بألوان زاهية وغنية، رصاص مقاوم للكسر بفضل تقنية الربط SV. علبة كرتونية مع براية.',
    dEn: 'Vivid colour pencils with break-resistant SV-bonded leads, in a card box with sharpener.',
    kw: ['الوان', 'تلوين'], img: 'colored pencils', imgCount: 3,
    axes: [['color_count', ['12', '24', '36']]],
    price: (c) => ({ '12': 18000, '24': 32000, '36': 48000 })[c[0]!]!, stock: { 1: [60, 35, 12], 2: 20, 3: 15 },
  },
  {
    key: 'crayons', cat: 'art.school.crayons', brand: 'Maped',
    ar: 'ألوان شمعية ١٢ لون', en: 'Wax Crayons 12',
    dAr: 'ألوان شمعية سميكة مناسبة لأيدي الصغار، ألوان زاهية وآمنة.', dEn: 'Chunky wax crayons for small hands, bright and safe.',
    img: 'crayons', price: 5000, stock: { 1: 45 },
  },
  {
    key: 'felt', cat: 'art.school.felt', brand: 'Stabilo',
    ar: 'أقلام فلوماستر', en: 'Felt-Tip Pens',
    dAr: 'أقلام فلوماستر بحبر مائي يُغسل من الملابس، رؤوس متينة لا تنغرز.', dEn: 'Washable felt-tip pens with durable, push-proof tips.',
    img: 'felt tip pens', axes: [['color_count', ['12', '24']]],
    price: (c) => (c[0] === '12' ? 9000 : 16000), stock: { 1: 30, 2: 10 },
  },
  {
    key: 'watercolor', cat: 'art.school.water', brand: 'Pelikan',
    ar: 'علبة ألوان مائية ١٢ لون', en: 'Watercolour Set 12',
    dAr: 'علبة ألوان مائية بأقراص كبيرة وفرشاة، ألوان شفافة تمتزج بسهولة.', dEn: 'Watercolour tin with large pans and a brush; transparent colours that blend easily.',
    img: 'watercolor paint set', price: 8000, stock: { 1: 26 },
  },
  {
    key: 'oil', cat: 'art.pro.oil', usd: true,
    ar: 'ألوان زيتية احترافية ١٢ أنبوب', en: 'Artist Oil Colours 12 Tubes',
    dAr: 'ألوان زيتية بدرجة احترافية وتركيز صبغة عالٍ، أنابيب ٢١ مل. مستوردة — السعر بالدولار ويتبع سعر الصرف.',
    dEn: 'Artist-grade oil colours with high pigment load, 21 ml tubes. Imported — priced in USD.',
    img: 'oil paint tubes', imgCount: 3, price: 25, stock: { 1: 8 },
  },
  {
    key: 'acrylic', cat: 'art.pro.acrylic', usd: true,
    ar: 'ألوان أكريليك ٢٤ لون', en: 'Acrylic Colours 24',
    dAr: 'ألوان أكريليك سريعة الجفاف تعمل على الكانفاس والخشب والورق.', dEn: 'Fast-drying acrylics for canvas, wood and paper.',
    img: 'acrylic paint', price: 18, stock: { 1: 10, 2: 4 },
  },
  {
    key: 'brushes', cat: 'art.supplies.brushes',
    ar: 'طقم فرش رسم ١٠ قطع', en: 'Paint Brush Set 10',
    dAr: 'طقم ١٠ فرش بأشكال وأحجام مختلفة (مسطّحة ومستديرة) للمائي والأكريليك.', dEn: 'Set of 10 flat and round brushes for watercolour and acrylic.',
    img: 'paint brushes', price: 7000, stock: { 1: 22 },
  },
  {
    key: 'canvas', cat: 'art.supplies.canvas',
    ar: 'لوحة كانفاس مشدودة', en: 'Stretched Canvas',
    dAr: 'كانفاس قطني مجهّز مشدود على إطار خشبي، جاهز للرسم مباشرة.', dEn: 'Primed cotton canvas stretched on a wooden frame, ready to paint.',
    img: 'canvas painting easel', axes: [['paper_size', ['A4', 'A3']]],
    price: (c) => (c[0] === 'A4' ? 12000 : 20000), stock: { 1: 15 },
  },
  // ── Crafts ───────────────────────────────────────────────────────────────
  {
    key: 'clay', cat: 'crafts.clay',
    ar: 'صلصال ملوّن ١٢ لون', en: 'Modelling Clay 12 Colours',
    dAr: 'صلصال طري لا يجف، آمن للأطفال ويُعاد تشكيله مرات عديدة.', dEn: 'Soft, non-drying modelling clay, child-safe and reusable.',
    img: 'modeling clay', price: 4000, stock: { 1: 40 },
  },
  {
    key: 'stickers', cat: 'crafts.stickers',
    ar: 'ورقة ستيكرات', en: 'Sticker Sheet',
    dAr: 'ورقة ستيكرات ملوّنة بتصاميم مرحة لتزيين الدفاتر والهدايا.', dEn: 'Colourful sticker sheet to decorate notebooks and gifts.',
    img: 'stickers', price: 1000, stock: { 1: 200 },
  },
  // ── Office ───────────────────────────────────────────────────────────────
  {
    key: 'folder', cat: 'office.filing.files',
    ar: 'ملف بلاستيك بكبسة', en: 'Snap Button Folder',
    dAr: 'ملف بلاستيك شفاف بكبسة لحفظ أوراق A4 من الثني والماء.', dEn: 'Clear snap-button folder protecting A4 papers from folds and water.',
    img: 'document folder', axes: [['color', ['أزرق', 'أحمر', 'أخضر']]], price: 1500, stock: { 1: 150 },
  },
  {
    key: 'stapler', cat: 'office.stapling.staplers', brand: 'Deli',
    ar: 'دبّاسة مكتبية', en: 'Office Stapler',
    dAr: 'دبّاسة معدنية تدبّس حتى ٢٥ ورقة، مع علبة دبابيس ٢٤/٦.', dEn: 'Metal stapler for up to 25 sheets, with a box of 24/6 staples.',
    img: 'stapler', price: 12000, stock: { 1: 18 },
  },
  {
    key: 'calculator', cat: 'office.machines.calculators', brand: 'Deli',
    ar: 'آلة حاسبة علمية', en: 'Scientific Calculator',
    dAr: 'آلة حاسبة علمية بـ٢٤٠ وظيفة، شاشة سطرين، تعمل بالبطارية والطاقة الشمسية. مسموحة في الامتحانات.',
    dEn: '240-function scientific calculator, two-line display, battery + solar. Exam-approved.',
    img: 'scientific calculator', imgCount: 3, price: 55000, stock: { 1: 9, 2: 4 },
  },
  {
    key: 'envelopes', cat: 'office.envelopes',
    ar: 'أظرف بيضاء A4', en: 'White A4 Envelopes',
    dAr: 'ظرف أبيض بشريط لاصق ذاتي، مقاس A4.', dEn: 'Self-seal white envelope, A4.',
    img: 'envelopes', price: 300, units: [['box', 50]], stock: { 1: 500 },
  },
  {
    key: 'whiteboard', cat: 'office.boards.whiteboards',
    ar: 'سبورة بيضاء مغناطيسية', en: 'Magnetic Whiteboard',
    dAr: 'سبورة بيضاء مغناطيسية ٦٠×٩٠ سم بإطار ألمنيوم وحامل أقلام.', dEn: 'Magnetic whiteboard 60×90 cm, aluminium frame and pen tray.',
    img: 'whiteboard', price: 95000, stock: { 1: 4 },
  },
  // ── Gifts ────────────────────────────────────────────────────────────────
  {
    key: 'wrapping', cat: 'gifts.wrapping.paper',
    ar: 'ورق تغليف هدايا', en: 'Gift Wrapping Paper',
    dAr: 'لفّة ورق تغليف لامع ٧٠×٢٠٠ سم بتصاميم للمناسبات.', dEn: 'Glossy gift wrap roll 70×200 cm with occasion designs.',
    img: 'gift wrapping paper', axes: [['theme', ['أطفال', 'بنات', 'شباب']]], price: 1500, stock: { 1: 80 },
  },
  {
    key: 'pen_set', cat: 'gifts.ready.pen_sets', brand: 'Pelikan',
    ar: 'طقم أقلام هدية', en: 'Pen Gift Set',
    dAr: 'طقم قلم حبر وقلم جاف معدنيين في علبة خشبية فاخرة — هدية راقية للمدير والمعلّم.', dEn: 'Metal fountain pen and ballpoint in a luxury wooden box.',
    img: 'pen gift set', imgCount: 3, price: 250000, stock: { 1: 5 },
  },
  {
    key: 'frame', cat: 'gifts.ready.frames',
    ar: 'برواز صور خشبي', en: 'Wooden Photo Frame',
    dAr: 'برواز خشبي بزجاج واقٍ يُعلّق أو يُسند على المكتب.', dEn: 'Wooden frame with protective glass, hangs or stands.',
    img: 'photo frame', axes: [['material', ['خشب', 'معدن']]],
    price: (c) => (c[0] === 'خشب' ? 10000 : 15000), stock: { 1: 20 },
  },
  {
    key: 'balloons', cat: 'gifts.party.balloons',
    ar: 'بالونات ملوّنة ٢٠ قطعة', en: 'Colourful Balloons 20',
    dAr: 'كيس ٢٠ بالوناً مطاطياً بألوان متعددة لحفلات الأطفال.', dEn: 'Bag of 20 latex balloons for kids’ parties.',
    img: 'balloons', price: 3000, stock: { 1: 60 },
  },
  // ── Computing (USD, central) ─────────────────────────────────────────────
  {
    key: 'ink', cat: 'computing.ink', usd: true,
    ar: 'خرطوشة حبر طابعة أسود', en: 'Black Printer Ink Cartridge',
    dAr: 'خرطوشة حبر أسود متوافقة، تطبع حتى ٦٠٠ صفحة. السعر بالدولار ويتبع سعر الصرف.', dEn: 'Compatible black ink cartridge, up to 600 pages. Priced in USD.',
    img: 'ink cartridge', price: 35, stock: { 1: 12 },
  },
  {
    key: 'usb', cat: 'computing.storage', usd: true,
    ar: 'فلاشة USB 3.0', en: 'USB 3.0 Flash Drive',
    dAr: 'ذاكرة فلاش USB 3.0 بسرعة نقل حتى ١٠٠ ميغابايت/ثانية وغطاء معدني.', dEn: 'USB 3.0 flash drive, up to 100 MB/s, metal casing.',
    img: 'usb flash drive', axes: [['color', ['فضي', 'أسود']]], price: 8, stock: { 1: 25, 2: 10 },
  },
  {
    key: 'mouse', cat: 'computing.accessories.input',
    ar: 'فأرة لاسلكية', en: 'Wireless Mouse',
    dAr: 'فأرة لاسلكية صامتة ٢٫٤ غيغاهرتز. (بلا سعر بعد — تظهر بقائمة «يحتاج تسعيراً»)', dEn: 'Silent 2.4 GHz wireless mouse. (Unpriced — shows on the pricing worklist)',
    img: 'computer mouse', stock: { 1: 10 },
  },
  {
    key: 'cable', cat: 'computing.accessories.cables', usd: true, sellable: false,
    ar: 'كابل USB-C للاستخدام الداخلي', en: 'USB-C Cable (internal use)',
    dAr: 'كابل للاستخدام الداخلي في المحل — غير معروض للبيع.', dEn: 'Cable for in-store use — not for sale.',
    img: 'usb cable', imgCount: 1, price: 3, stock: { 1: 6 },
  },
  // ── Books ────────────────────────────────────────────────────────────────
  {
    key: 'coloring_book', cat: 'books.kids',
    ar: 'كتاب تلوين الحيوانات', en: 'Animals Colouring Book',
    dAr: 'كتاب تلوين بـ٤٨ صفحة من رسومات الحيوانات بخطوط عريضة مناسبة للأطفال من ٣ سنوات.', dEn: '48-page animal colouring book with bold outlines for ages 3+.',
    img: 'coloring book', price: 6000, stock: { 1: 35 },
  },
  {
    key: 'novel', cat: 'books.fiction',
    ar: 'رواية مترجمة', en: 'Translated Novel',
    dAr: 'رواية عالمية مترجمة إلى العربية بغلاف ورقي. (مؤرشف)', dEn: 'World classic translated into Arabic, paperback. (Archived)',
    img: 'novel book', imgCount: 1, price: 25000,
  },
  // ── Customisation blanks ─────────────────────────────────────────────────
  {
    key: 'mug', cat: 'blanks.mugs.ceramic',
    ar: 'كوب سيراميك أبيض للطباعة', en: 'White Ceramic Mug for Printing',
    dAr: 'كوب سيراميك أبيض ٣٣٠ مل مطلي للطباعة الحرارية — اطبع عليه صورتك أو شعارك.', dEn: '330 ml sublimation-coated white mug — print your photo or logo.',
    img: 'white ceramic mug', price: 8000, stock: { 1: 60 },
  },
  {
    key: 'tshirt', cat: 'blanks.apparel.tshirts',
    ar: 'تيشيرت قطني للطباعة', en: 'Cotton T-Shirt for Printing',
    dAr: 'تيشيرت قطن ١٠٠٪ بقصّة مريحة، جاهز للطباعة الحرارية أو السلك سكرين.', dEn: '100% cotton regular-fit tee, ready for heat transfer or screen print.',
    img: 't-shirt', variantImages: true,
    axes: [['color', ['أبيض', 'أسود']], ['apparel_size', ['S', 'M', 'L', 'XL']]], price: 30000, stock: { 1: 10 },
  },
  // ── Production materials (print consumption) ─────────────────────────────
  {
    key: 'prod_paper', cat: 'production.paper', sellable: false,
    ar: 'ورق إنتاج A4 ٨٠ غرام', en: 'Production Paper A4 80 gsm',
    dAr: 'ورق قسم الطباعة — يُخصم تلقائياً بالورقة عند بدء كل طلب طباعة.', dEn: 'Print-room paper, deducted per sheet when a print job starts.',
    img: 'white paper stack', imgCount: 1, base: 'piece', units: [['ream', 500]], price: 130, stock: { 1: 5000, 2: 2000 },
  },
  {
    key: 'prod_ink_bw', cat: 'production.ink', sellable: false,
    ar: 'تونر أسود للإنتاج', en: 'Production Black Toner',
    dAr: 'تونر آلة الطباعة — يكفي ٣٠٠٠ صفحة تقريباً.', dEn: 'Print-room toner, about 3,000 pages.',
    img: 'toner cartridge', imgCount: 1, price: 450000, stock: { 1: 3 },
  },
  {
    key: 'prod_ink_color', cat: 'production.ink', sellable: false,
    ar: 'حبر ملوّن للإنتاج', en: 'Production Colour Ink',
    dAr: 'حبر ملوّن لآلة الطباعة — يكفي ١٥٠٠ صفحة تقريباً.', dEn: 'Print-room colour ink, about 1,500 pages.',
    img: 'ink bottles printer', imgCount: 1, price: 600000, stock: { 1: 2 },
  },
  {
    key: 'prod_coil', cat: 'production.binding.coils', sellable: false,
    ar: 'سلك تجليد حلزوني', en: 'Spiral Binding Coil',
    dAr: 'سلك تجليد بلاستيكي — واحد لكل نسخة مجلّدة.', dEn: 'Plastic binding coil — one per bound copy.',
    img: 'spiral binding', imgCount: 1, price: 400, stock: { 1: 200 },
  },
  {
    key: 'prod_cover', cat: 'production.binding.covers', sellable: false,
    ar: 'غلاف شفاف للتجليد', en: 'Clear Binding Cover',
    dAr: 'غلاف بلاستيكي شفاف — لم يُستلم بعد، فيصير رصيده سالباً بأول طلب يستهلكه.', dEn: 'Clear plastic cover — never received, so the first job drives it negative.',
    img: 'plastic cover sheet', imgCount: 1, price: 300,
  },
];

interface Built {
  id: number;
  spec: ProductSpec;
  variants: { id: number; combo: string[]; baseUnitId: number; unitIds: Map<string, number> }[];
}
const built = new Map<string, Built>();

let eanSeq = 1000;
function ean13(): string {
  const body = `621${String(eanSeq++).padStart(9, '0')}`;
  const sum = [...body].reduce((s, d, i) => s + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return body + ((10 - (sum % 10)) % 10);
}

function combos(axes: Axis[]): string[][] {
  return axes.reduce<string[][]>((acc, [, values]) => acc.flatMap((c) => values.map((v) => [...c, v])), [[]]);
}

async function buildProduct(spec: ProductSpec): Promise<void> {
  const axes = spec.axes ?? [];
  const all = combos(axes);
  const baseUnit = unitId.get(spec.base ?? 'piece')!;
  const gallery = await uploadPhotos(spec.img, spec.imgCount ?? 2);

  const variants = [];
  for (const [i, combo] of all.entries()) {
    const valueIds = combo.map((v, j) => {
      const value = attrValue.get(`${axes[j]![0]}:${v}`);
      if (!value) throw new Error(`unknown attribute value ${axes[j]![0]}:${v}`);
      return value.id;
    });
    let image_ids: number[] = [];
    if (spec.variantImages && combo[0]) {
      const en = attrValue.get(`${axes[0]![0]}:${combo[0]}`)?.en ?? combo[0];
      image_ids = await uploadPhotos(`${en} ${spec.img}`, 1);
    }
    const units = (spec.units ?? []).map(([code, factor]) => ({ unit_id: unitId.get(code)!, factor }));
    const barcodes = [{ code: ean13(), unit_id: baseUnit }];
    for (const u of units) barcodes.push({ code: ean13(), unit_id: u.unit_id });
    variants.push({
      attribute_value_ids: valueIds,
      base_unit_id: baseUnit,
      units,
      barcodes,
      image_ids,
      sort_order: i,
    });
  }

  const created = await S('POST', '/catalog/products', {
    category_id: catId.get(spec.cat),
    brand_id: spec.brand ? brandId.get(spec.brand) : null,
    is_sellable: spec.sellable ?? true,
    name_ar: spec.ar,
    name_en: spec.en,
    description_ar: spec.dAr,
    description_en: spec.dEn,
    search_keywords: spec.kw,
    status: spec.status === 'draft' ? 'draft' : 'active',
    image_ids: gallery,
    variants,
  });

  const b: Built = { id: created.id, spec, variants: [] };
  for (const [i, v] of (created.variants as Any[]).entries()) {
    b.variants.push({
      id: v.id,
      combo: all[i]!,
      baseUnitId: v.base_unit_id,
      unitIds: new Map((v.units as Any[]).map((u) => [String(u.unit_id), u.unit_id])),
    });
  }
  built.set(spec.key, b);

  // Central prices.
  if (spec.price !== undefined) {
    for (const [i, v] of b.variants.entries()) {
      const amount = typeof spec.price === 'function' ? spec.price(v.combo, i) : spec.price;
      const body: Any = { amount, currency: spec.usd ? 'USD' : 'SYP' };
      if (spec.wholesale) {
        body.wholesale_amount =
          spec.wholesale.off < 1 ? Math.round(amount * spec.wholesale.off) : spec.wholesale.off;
        body.wholesale_min_qty = spec.wholesale.min;
      }
      await S('PUT', `/catalog/variants/${v.id}/price`, body);
    }
  }
  if (spec.status === 'discontinued') {
    await S('PATCH', `/catalog/products/${b.id}`, { status: 'discontinued' });
  }
}

const priceOf = (b: Built, i: number): number => {
  const p = b.spec.price;
  return p === undefined ? 0 : typeof p === 'function' ? p(b.variants[i]!.combo, i) : p;
};
const V = (key: string, i = 0): number => built.get(key)!.variants[i]!.id;

// ─────────────────────────────────────────────────────────────────────────────
// 6. Scenarios
// ─────────────────────────────────────────────────────────────────────────────

const USD_RATE = 14000;

async function settings(): Promise<void> {
  section('Settings — exchange rate, rounding, category rules, inventory, sales');
  await step('exchange rate (old)', () => S('POST', '/catalog/pricing/exchange-rate', { usd_to_syp: 13500 }));
  await step('exchange rate', () => S('POST', '/catalog/pricing/exchange-rate', { usd_to_syp: USD_RATE }));
  await step('rounding bands', () =>
    S('PUT', '/catalog/pricing/rounding', {
      bands: [
        { below: 1000, step: 50 },
        { below: 10000, step: 100 },
        { below: 100000, step: 500 },
        { below: null, step: 1000 },
      ],
    }),
  );
  const rules: [string, Any][] = [
    ['writing', { price_band_percent: 15 }],
    ['paper', { price_band_percent: 10, wholesale_discount_percent: 8, wholesale_min_qty: 10 }],
    ['school', { price_band_percent: 20 }],
    ['office', { price_band_percent: 10, tax_rate_percent: 5 }],
    ['computing', { tax_rate_percent: 5 }],
  ];
  for (const [code, body] of rules) {
    await step(`pricing rules ${code}`, () => S('PUT', `/catalog/categories/${catId.get(code)}/pricing-rules`, body));
  }
  await step('inventory settings', () =>
    S('PUT', '/inventory/settings', { approval_threshold_syp: 100000, expiry_alert_days: 30 }),
  );
  await step('sales settings', () => S('PUT', '/sales/settings', { return_window_days: 14, reservation_hours: 24 }));
  for (const [role, pct, approve] of [
    [1, 50, true],
    [3, 20, true],
    [9, 5, false],
  ] as const) {
    await step(`discount cap role ${role}`, () =>
      S('PUT', '/sales/caps', { role_id: role, max_discount_percent: pct, can_approve: approve }),
    );
  }
}

async function brandsAndCategories(): Promise<void> {
  section('Brands (logos) and category images');
  const colors = ['#1e56c8', '#2e7d32', '#d32f2f', '#f57c00', '#7b1fa2', '#00838f', '#5d4037', '#c2185b', '#455a64', '#fbc02d', '#303f9f', '#388e3c'];
  let i = 0;
  for (const [name, id] of brandId) {
    await step(`logo ${name}`, async () => {
      const logo = await uploadImage(await logoTile(name, colors[i++ % colors.length]!));
      await S('PATCH', `/catalog/brands/${id}`, { logo_image_id: logo });
    });
  }
  await step('archived brand', async () => {
    const b = await S('POST', '/catalog/brands', { name: 'Old Stationery Co.' });
    await S('POST', `/catalog/brands/${b.id}/archive`);
  });
  const queries: Record<string, string> = {
    writing: 'pens and pencils',
    paper: 'notebooks stack',
    school: 'school supplies',
    bags: 'school backpack',
    art: 'paint palette brushes',
    crafts: 'craft supplies',
    office: 'office supplies desk',
    gifts: 'gift box ribbon',
    computing: 'computer keyboard mouse',
    books: 'books shelf',
    blanks: 'white mug t-shirt',
    production: 'printing press paper',
  };
  for (const [code, q] of Object.entries(queries)) {
    await step(`category image ${code}`, async () => {
      const [img] = await uploadPhotos(q, 1, 1);
      if (img) await S('PATCH', `/catalog/categories/${catId.get(code)}`, { image_id: img });
    });
  }
  await step('archived category', async () => {
    const c = await S('POST', '/catalog/categories', {
      parent_id: catId.get('gifts.party'),
      name_ar: 'أزياء تنكرية',
      name_en: 'Costumes',
    });
    await S('POST', `/catalog/categories/${c.id}/archive`);
  });
}

const supplier: Record<string, number> = {};
async function suppliers(): Promise<void> {
  section('Suppliers');
  const list: [string, Any][] = [
    ['amal', { name: 'شركة الأمل للقرطاسية', phone: '0112233445', email: 'sales@amal-stationery.test', address: 'دمشق — الحريقة', notes: 'المورد الرئيسي لأدوات الكتابة والمكتب' }],
    ['warraq', { name: 'مؤسسة الورّاق للورق', phone: '0114455667', address: 'دمشق — القدم', notes: 'ورق ودفاتر، تسليم أسبوعي' }],
    ['funoon', { name: 'دار الفنون للتوريدات', phone: '0213344556', email: 'info@funoon.test', address: 'حلب — العزيزية' }],
    ['global', { name: 'Global Imports LLC', phone: '+971 4 555 0101', email: 'orders@global-imports.test', address: 'Dubai — Jebel Ali', notes: 'فواتير بالدولار' }],
    ['sham', { name: 'مطابع الشام', phone: '0116677889', address: 'دمشق — المنطقة الصناعية', notes: 'مواد الإنتاج والتجليد' }],
    ['old', { name: 'مورد سابق (متوقّف)', phone: '0110000000', notes: 'أُوقف التعامل معه' }],
  ];
  for (const [key, body] of list) {
    await step(`supplier ${key}`, async () => {
      supplier[key] = (await S('POST', '/suppliers', body)).id;
    });
  }
  await step('archive old supplier', () => S('POST', `/suppliers/${supplier['old']}/archive`));
}

function supplierFor(spec: ProductSpec): string {
  if (spec.usd) return 'global';
  const top = spec.cat.split('.')[0]!;
  if (top === 'paper' || top === 'books') return 'warraq';
  if (top === 'art' || top === 'crafts' || top === 'gifts') return 'funoon';
  if (top === 'production' || top === 'blanks' || top === 'bags') return 'sham';
  return 'amal';
}

const receipts: { id: number; branch: number; key: string }[] = [];
async function stock(): Promise<void> {
  section('Stock — purchase invoices');
  // Group lines per (branch, supplier).
  const groups = new Map<string, { branch: number; sup: string; usd: boolean; lines: Any[] }>();
  for (const b of built.values()) {
    for (const [branchStr, qtys] of Object.entries(b.spec.stock ?? {})) {
      const branch = [0, B1, B2, B3][Number(branchStr)]!;
      const sup = supplierFor(b.spec);
      const key = `${branch}:${sup}`;
      const g = groups.get(key) ?? { branch, sup, usd: sup === 'global', lines: [] };
      groups.set(key, g);
      for (const [i, v] of b.variants.entries()) {
        const qty = Array.isArray(qtys) ? qtys[i] ?? 0 : qtys ?? 0;
        if (qty <= 0) continue;
        const price = priceOf(b, i) || (b.spec.key === 'mouse' ? 150000 : 1000);
        g.lines.push({
          variant_id: v.id,
          unit_id: v.baseUnitId,
          qty,
          unit_cost: g.usd ? Math.round(price * 0.62 * 100) / 100 : Math.round(price * 0.6),
          expires_at: b.spec.expiresInDays ? iso(days(b.spec.expiresInDays)) : null,
        });
      }
    }
  }
  let n = 1;
  for (const [key, g] of groups) {
    if (g.lines.length === 0) continue;
    await step(`receipt ${key}`, async () => {
      const r = await S('POST', '/inventory/receipts', {
        branch_id: g.branch,
        supplier_id: supplier[g.sup],
        supplier_invoice_no: `INV-${2026}${String(n++).padStart(4, '0')}`,
        invoice_date: iso(days(-20 + n)),
        currency: g.usd ? 'USD' : 'SYP',
        exchange_rate: g.usd ? USD_RATE : null,
        note: g.usd ? 'شحنة مستوردة — بالدولار' : null,
        lines: g.lines,
      });
      receipts.push({ id: r.id, branch: g.branch, key });
    });
  }
  // A carton line: the invoice is written in cartons, the shelf gains pieces.
  await step('receipt in cartons', async () => {
    const b = built.get('school_nb')!;
    const carton = unitId.get('carton')!;
    const r = await S('POST', '/inventory/receipts', {
      branch_id: B1,
      supplier_id: supplier['warraq'],
      supplier_invoice_no: 'WR-7781',
      invoice_date: iso(days(-3)),
      currency: 'SYP',
      lines: [{ variant_id: b.variants[1]!.id, unit_id: carton, qty: 2, unit_cost: 80000 }],
    });
    receipts.push({ id: r.id, branch: B1, key: 'carton' });
  });
  log(`${receipts.length} purchase invoices`);
}

async function pricingScenarios(): Promise<void> {
  section('Pricing — branch prices, listing, out-of-band, bulk');
  // branch_free: backpack is cheaper in Mezzeh.
  await step('branch price (branch_free)', () =>
    S('PUT', `/catalog/branches/${B2}/variants/${V('backpack')}/price`, { amount: 79000 }),
  );
  // branch_banded inside the band.
  await step('branch price (banded)', () =>
    S('PUT', `/catalog/branches/${B2}/variants/${V('noris')}/price`, { amount: 850 }),
  );
  // out_of_band: the branch price stays, the central moves away from it.
  await step('out of band', async () => {
    await S('PUT', `/catalog/branches/${B2}/variants/${V('tape')}/price`, { amount: 2400 });
    await S('PUT', `/catalog/variants/${V('tape')}/price`, { amount: 3200, currency: 'SYP' });
  });
  // not listed at the main branch (stocked elsewhere).
  await step('unlisted at B1', () =>
    S('PUT', `/catalog/branches/${B1}/variants/${V('permanent')}/listing`, { is_listed: false }),
  );
  await step('bulk +5% office', async () => {
    await S('POST', '/catalog/pricing/bulk/preview', { category_id: catId.get('office'), percent: 5 });
    await S('POST', '/catalog/pricing/bulk/apply', { category_id: catId.get('office'), percent: 5 });
  });
  await step('price history (bic blue raised)', async () => {
    await S('PUT', `/catalog/variants/${V('bic')}/price`, { amount: 1400, currency: 'SYP', wholesale_amount: 1100, wholesale_min_qty: 50 });
    await S('PUT', `/catalog/variants/${V('bic')}/price`, { amount: 1500, currency: 'SYP', wholesale_amount: 1200, wholesale_min_qty: 50 });
  });
}

async function productStates(): Promise<void> {
  section('Product states — archived, shared barcode, internal barcode');
  await step('archive novel', () => S('POST', `/catalog/products/${built.get('novel')!.id}/archive`));
  // Factory error: the same code printed on every colour of the Bic box.
  await step('shared barcode', async () => {
    const b = built.get('bic')!;
    const box = unitId.get('box')!;
    const code = ean13();
    await S('POST', `/catalog/variants/${b.variants[0]!.id}/barcodes`, { code, unit_id: box });
    await S('POST', `/catalog/variants/${b.variants[1]!.id}/barcodes`, { code, unit_id: box });
  });
  await step('internal barcode', () =>
    S('POST', `/catalog/variants/${V('calligraphy')}/barcodes/internal`, { unit_id: unitId.get('piece') }),
  );
  await step('discontinued variant', () => S('PATCH', `/catalog/variants/${V('sticky', 2)}`, { status: 'discontinued' }));
}

async function inventoryScenarios(): Promise<void> {
  section('Inventory — thresholds, adjustments, transfers, counts, returns, drafts');
  // thresholds → low
  for (const [key, i, t] of [
    ['bic', 3, 80],
    ['trolley', 0, 5],
    ['backpack', 2, 6],
    ['colored_pencils', 2, 15],
    ['fountain', 0, 3],
  ] as const) {
    await step(`threshold ${key}`, () => S('PUT', `/inventory/variants/${V(key, i)}/threshold`, { branch_id: B1, threshold: t }));
  }
  await step('threshold 0 (notify when out)', () =>
    S('PUT', `/inventory/variants/${V('whiteboard')}/threshold`, { branch_id: B1, threshold: 0 }),
  );

  // adjustments
  await step('adjustment posted (damage)', () =>
    S('POST', '/inventory/adjustments', { branch_id: B1, reason: 'damage', note: 'علبة سقطت وانكسرت أقلامها', lines: [{ variant_id: V('bic', 2), qty_base: 5 }] }),
  );
  await step('adjustment posted (sample)', () =>
    S('POST', '/inventory/adjustments', { branch_id: B1, reason: 'sample', note: 'عيّنات للمدرسة', lines: [{ variant_id: V('noris'), qty_base: 12 }] }),
  );
  // Whiteboard markers: everything that arrived was ruined → out everywhere.
  await step('adjustment posted (expiry → out everywhere)', () =>
    S('POST', '/inventory/adjustments', {
      branch_id: B1, reason: 'expiry', note: 'جفّ الحبر بالكامل',
      lines: built.get('wb_marker')!.variants.map((v, i) => ({ variant_id: v.id, qty_base: i === 0 ? 10 : 10 })),
    }),
  );
  await step('adjustment pending approval', () =>
    S('POST', '/inventory/adjustments', { branch_id: B1, reason: 'loss', note: 'فُقدت عند الجرد الشهري', lines: [{ variant_id: V('calculator'), qty_base: 4 }] }),
  );
  await step('adjustment rejected', async () => {
    const a = await S('POST', '/inventory/adjustments', { branch_id: B2, reason: 'internal_use', note: 'استخدام بالمكتب', lines: [{ variant_id: V('copy_paper'), qty_base: 10 }] });
    if (a.status === 'pending_approval') await S('POST', `/inventory/adjustments/${a.id}/reject`, { note: 'الكمية كبيرة — أعد الطلب مفصّلاً' }).catch(() => S('POST', `/inventory/adjustments/${a.id}/reject`));
  });
  await step('adjustment approved', async () => {
    const a = await S('POST', '/inventory/adjustments', { branch_id: B1, reason: 'damage', note: 'تسرّب مياه على الرف', lines: [{ variant_id: V('journal'), qty_base: 4 }, { variant_id: V('planner'), qty_base: 8 }] });
    if (a.status === 'pending_approval') await S('POST', `/inventory/adjustments/${a.id}/approve`);
  });

  // transfers — every state.
  const tr = (lines: [string, number, number][], note: string) =>
    S('POST', '/inventory/transfers', { from_branch_id: B1, to_branch_id: B2, note, lines: lines.map(([k, i, q]) => ({ variant_id: V(k, i), qty_requested: q })) });
  const approved = await step('transfer approved', () => tr([['eraser', 0, 50]], 'تعزيز رصيد المزة'));
  const requested = await step('transfer requested', () => tr([['sticky', 0, 10]], 'طلب من فرع المزة'));
  if (requested) {
    await step('→ requested (branch request)', () => db.execute(sql`update stock_transfers set status = 'requested', approved_by_user_id = null where id = ${requested.id}`));
  }
  const rejected = await step('transfer to reject', () => tr([['fountain', 0, 1]], 'طلب قلم فاخر'));
  if (rejected) {
    await step('→ rejected', async () => {
      await db.execute(sql`update stock_transfers set status = 'requested', approved_by_user_id = null where id = ${rejected.id}`);
      await S('POST', `/inventory/transfers/${rejected.id}/reject`, { note: 'آخر قطعة بالفرع الرئيسي' }).catch(() => S('POST', `/inventory/transfers/${rejected.id}/reject`));
    });
  }
  const transit = await step('transfer in transit', () => tr([['ruler', 2, 20], ['clay', 0, 10]], 'بالطريق مع سيارة التوزيع'));
  if (transit) await step('→ shipped', () => S('POST', `/inventory/transfers/${transit.id}/ship`, { lines: [] }));
  const received = await step('transfer received', () => tr([['school_nb', 0, 30]], 'دفاتر لبداية العام'));
  if (received) {
    await step('→ received', async () => {
      await S('POST', `/inventory/transfers/${received.id}/ship`, { lines: [] });
      await S('POST', `/inventory/transfers/${received.id}/receive`, { lines: [] });
    });
  }
  const disc = await step('transfer with discrepancy', () => tr([['colored_paper', 0, 50], ['stickers', 0, 40]], 'شحنة ناقصة'));
  if (disc) {
    await step('→ received with discrepancy', async () => {
      await S('POST', `/inventory/transfers/${disc.id}/ship`, { lines: [] });
      await S('POST', `/inventory/transfers/${disc.id}/receive`, { lines: [{ variant_id: V('colored_paper'), qty: 44 }, { variant_id: V('stickers'), qty: 40 }] });
    });
  }
  const lost = await step('transfer resolved as loss', () => tr([['folder', 0, 20]], 'فُقد كرتون بالطريق'));
  if (lost) {
    await step('→ closed (loss)', async () => {
      await S('POST', `/inventory/transfers/${lost.id}/ship`, { lines: [] });
      await S('POST', `/inventory/transfers/${lost.id}/receive`, { lines: [{ variant_id: V('folder'), qty: 15 }] });
      await S('POST', `/inventory/transfers/${lost.id}/resolve`, { resolution: 'loss', note: 'لم يُعثر على الكرتون' });
    });
  }
  const back = await step('transfer resolved as returned', () => tr([['stapler', 0, 4]], 'دبّاسات'));
  if (back) {
    await step('→ closed (returned)', async () => {
      await S('POST', `/inventory/transfers/${back.id}/ship`, { lines: [] });
      await S('POST', `/inventory/transfers/${back.id}/receive`, { lines: [{ variant_id: V('stapler'), qty: 2 }] });
      await S('POST', `/inventory/transfers/${back.id}/resolve`, { resolution: 'returned', note: 'عادت قطعتان مع السائق' });
    });
  }
  void approved;

  // counts — open, closed, pending, rejected.
  await step('count open (blind)', async () => {
    const c = await S('POST', '/inventory/counts', { branch_id: B1, scope: 'category', category_id: catId.get('writing'), note: 'جرد أدوات الكتابة' });
    await S('POST', `/inventory/counts/${c.id}/lines`, { variant_id: V('bic'), counted_qty: 238 });
    await S('POST', `/inventory/counts/${c.id}/lines`, { variant_id: V('noris'), counted_qty: 585 });
  });
  await step('count closed (small diff)', async () => {
    const c = await S('POST', '/inventory/counts', { branch_id: B1, scope: 'list', note: 'جرد سريع للمحايات' });
    await S('POST', `/inventory/counts/${c.id}/lines`, { variant_id: V('eraser'), counted_qty: 846 });
    await S('POST', `/inventory/counts/${c.id}/close`);
  });
  await step('count pending approval', async () => {
    const c = await S('POST', '/inventory/counts', { branch_id: B1, scope: 'list', note: 'جرد الآلات الحاسبة' });
    await S('POST', `/inventory/counts/${c.id}/lines`, { variant_id: V('calculator'), counted_qty: 2 });
    await S('POST', `/inventory/counts/${c.id}/lines`, { variant_id: V('pen_set'), counted_qty: 3 });
    await S('POST', `/inventory/counts/${c.id}/close`);
  });
  await step('count rejected', async () => {
    const c = await S('POST', '/inventory/counts', { branch_id: B2, scope: 'list', note: 'جرد ورق الطباعة' });
    await S('POST', `/inventory/counts/${c.id}/lines`, { variant_id: V('copy_paper'), counted_qty: 10 });
    const closed = await S('POST', `/inventory/counts/${c.id}/close`);
    if (closed.status === 'pending_approval') await S('POST', `/inventory/counts/${c.id}/reject`, { note: 'أعد العدّ' }).catch(() => S('POST', `/inventory/counts/${c.id}/reject`));
  });

  // purchase returns
  await step('purchase return', async () => {
    const r = receipts.find((x) => x.key === `${B1}:amal`);
    if (!r) throw new Error('no amal receipt');
    await S('POST', '/inventory/returns', { receipt_id: r.id, note: 'أقلام معيبة من المصنع', lines: [{ variant_id: V('bic', 3), qty_base: 10 }] });
  });
  await step('purchase return (paper)', async () => {
    const r = receipts.find((x) => x.key === `${B1}:warraq`);
    if (!r) throw new Error('no warraq receipt');
    await S('POST', '/inventory/returns', { receipt_id: r.id, note: 'رزم مبلولة', lines: [{ variant_id: V('copy_paper'), qty_base: 2 }] });
  });

  // branch drafts
  const draft = (name: string, cat: string, barcode?: string) =>
    S('POST', '/catalog/drafts', {
      branch_id: B2, name_ar: name, category_id: catId.get(cat), base_unit_id: unitId.get('piece'),
      barcode, note: 'وصل مع شحنة ولا يعرفه النظام',
    });
  const d1 = await step('draft with stock', () => draft('قلم تحديد نيون مجهول', 'writing.markers.highlighter', '6290001112223'));
  if (d1) {
    await step('stock on draft', () =>
      S('POST', '/inventory/receipts', {
        branch_id: B2, supplier_id: supplier['amal'], invoice_date: iso(days(-6)), currency: 'SYP',
        lines: [{ variant_id: d1.variant_id ?? d1.variants?.[0]?.id, unit_id: unitId.get('piece'), qty: 24, unit_cost: 1500 }],
      }),
    );
  }
  await step('draft without stock', () => draft('مبراة معدنية مزدوجة', 'school.erasers'));
  const d3 = await step('draft to approve', () => draft('ممحاة على شكل حيوان', 'school.erasers'));
  if (d3) await step('→ approved', () => S('POST', `/catalog/drafts/${d3.id}/approve`, { name_ar: 'ممحاة حيوانات للأطفال', brand_id: brandId.get('Maped') }));
  const d4 = await step('draft to merge', () => draft('محاية بيضاء (مسجّلة خطأ)', 'school.erasers'));
  if (d4) await step('→ merged', () => S('POST', `/catalog/drafts/${d4.id}/merge`, { variant_id: V('eraser') }));
}

async function promotions(): Promise<void> {
  section('Promotions — every status and kind');
  await step('caps', async () => {
    await S('PUT', '/promotions/caps', { branch_id: B2, max_discount_percent: 15 });
    await S('PUT', '/promotions/caps', { branch_id: B3, max_discount_percent: 10 });
  });
  const base = { scope: 'all_branches', channel: 'both', segment: 'all', is_stackable: false, is_active: true };
  const promo = (b: Any) => S('POST', '/promotions', { ...base, ...b });
  const prod = (k: string) => built.get(k)!.id;
  await step('live percent', () => promo({ name_ar: 'خصم ١٠٪ على أقلام بيك', name_en: 'Bic 10% off', target_kind: 'product', target_id: prod('bic'), kind: 'percent', percent_value: 10, starts_at: iso(days(-5)), ends_at: iso(days(25)) }));
  await step('live amount, ending soon', () => promo({ name_ar: 'وفّر ٣٠٠٠ على الألوان الخشبية', name_en: 'Save 3,000 on colour pencils', target_kind: 'product', target_id: prod('colored_pencils'), kind: 'amount', amount_syp: 3000, starts_at: iso(days(-10)), ends_at: iso(days(2)) }));
  await step('qty tiers, never ending', () => promo({ name_ar: 'كلما زادت الكمية زاد الخصم — أقلام الرصاص', name_en: 'Buy more, save more — pencils', target_kind: 'product', target_id: prod('noris'), kind: 'qty_tiers', tiers: [{ min_qty: 10, percent_value: 10 }, { min_qty: 24, percent_value: 15 }], starts_at: iso(days(-30)), ends_at: null }));
  await step('buy 3 get 1', () => promo({ name_ar: 'اشترِ ٣ واحصل على الرابع مجاناً', name_en: 'Buy 3 get 1 free', target_kind: 'product', target_id: prod('stabilo'), kind: 'buy_x_get_y', buy_qty: 3, get_qty: 1, get_percent: 100, starts_at: iso(days(-2)), ends_at: iso(days(12)) }));
  await step('scheduled', () => promo({ name_ar: 'تخفيضات الحقائب — الأسبوع القادم', name_en: 'Bags sale — next week', target_kind: 'category', target_id: catId.get('bags'), kind: 'percent', percent_value: 15, starts_at: iso(days(7)), ends_at: iso(days(21)) }));
  await step('ended', () => promo({ name_ar: 'أسبوع مابد', name_en: 'Maped week', target_kind: 'brand', target_id: brandId.get('Maped'), kind: 'percent', percent_value: 20, starts_at: iso(days(-20)), ends_at: iso(days(-6)) }));
  await step('inactive', () => promo({ name_ar: 'خصم الألوان المدرسية (موقوف)', name_en: 'School colours (paused)', target_kind: 'category', target_id: catId.get('art.school'), kind: 'percent', percent_value: 5, is_active: false, starts_at: null, ends_at: null }));
  await step('archived', async () => {
    const p = await promo({ name_ar: 'عرض الصيف ٢٠٢٦', name_en: 'Summer 2026', target_kind: 'category', target_id: catId.get('gifts'), kind: 'percent', percent_value: 10, starts_at: iso(days(-90)), ends_at: iso(days(-60)) });
    await S('POST', `/promotions/${(p.promotion ?? p).id}/archive`, { archived: true });
  });
  await step('branch-scoped (Mezzeh)', () => promo({ name_ar: 'افتتاح فرع المزة — ١٢٪ على الدفاتر', name_en: 'Mezzeh opening — 12% notebooks', scope: 'branches', branch_ids: [B2], target_kind: 'category', target_id: catId.get('paper.notebooks'), kind: 'percent', percent_value: 12, starts_at: iso(days(-3)), ends_at: iso(days(10)) }));
  await step('online wholesale', () => promo({ name_ar: 'جملة أونلاين — ورق الطباعة', name_en: 'Online wholesale — copy paper', channel: 'online', segment: 'wholesale', target_kind: 'product', target_id: prod('copy_paper'), kind: 'percent', percent_value: 5, starts_at: null, ends_at: null }));
  await step('POS-only variant (loss warning)', () => promo({ name_ar: 'تصفية المقص الوردي', name_en: 'Pink scissors clearance', channel: 'pos', target_kind: 'variant', target_id: V('scissors', 1), kind: 'percent', percent_value: 50, starts_at: iso(days(-1)), ends_at: iso(days(6)) }));
}

async function collections(): Promise<void> {
  section('Collections — live, image-less, scheduled, ended, hidden');
  const make = async (name: string, en: string, keys: string[], opts: Any, imgQuery?: string) => {
    const image_id = imgQuery ? (await uploadPhotos(imgQuery, 1, 2))[0] ?? null : null;
    const c = await S('POST', '/catalog/collections', { name_ar: name, name_en: en, image_id, ...opts });
    await S('PUT', `/catalog/collections/${c.id}/products`, { product_ids: keys.map((k) => built.get(k)!.id) });
  };
  await step('back to school', () => make('العودة إلى المدارس', 'Back to School', ['school_nb', 'backpack', 'pencil_case', 'colored_pencils', 'ruler', 'eraser', 'noris', 'geo_set', 'bottle'], { is_active: true, sort_order: 0, starts_at: iso(days(-15)), ends_at: iso(days(30)) }, 'school supplies back to school'));
  await step('art corner (no image)', () => make('ركن الفنّان', 'Artist Corner', ['oil', 'acrylic', 'brushes', 'canvas', 'watercolor', 'sketch'], { is_active: true, sort_order: 1 }));
  await step('gifts', () => make('هدايا مميّزة', 'Special Gifts', ['pen_set', 'fountain', 'frame', 'journal', 'wrapping'], { is_active: true, sort_order: 2 }, 'gift box'));
  await step('office essentials', () => make('أساسيات المكتب', 'Office Essentials', ['stapler', 'calculator', 'folder', 'copy_paper', 'sticky', 'envelopes'], { is_active: true, sort_order: 3 }, 'office desk stationery'));
  await step('scheduled', () => make('هدايا رمضان', 'Ramadan Gifts', ['pen_set', 'journal', 'frame'], { is_active: true, sort_order: 4, starts_at: iso(days(20)), ends_at: iso(days(50)) }, 'lantern ramadan'));
  await step('ended', () => make('صيف ٢٠٢٦', 'Summer 2026', ['balloons', 'bottle'], { is_active: true, sort_order: 5, starts_at: iso(days(-80)), ends_at: iso(days(-40)) }));
  await step('hidden', () => make('رفّ تجريبي (مخفي)', 'Draft shelf (hidden)', ['clay', 'stickers'], { is_active: false, sort_order: 6 }));
}

interface Shopper {
  key: string;
  token: string;
  id: number;
}
const shoppers: Record<string, Shopper> = {};

async function customers(): Promise<void> {
  section('Showcase customers');
  const list: [string, string, string, boolean][] = [
    ['ahmad', 'أحمد', 'الخطيب', true],
    ['sara', 'سارة', 'العلي', true],
    ['khaled', 'خالد', 'الحسن', false],
    ['layla', 'ليلى', 'منصور', true],
    ['omar', 'عمر', 'الشامي', true],
  ];
  for (const [key, first, last, verified] of list) {
    await step(`customer ${key}`, async () => {
      const email = `showcase.${key}@qirtas.test`;
      let data: Any;
      try {
        data = await call('POST', '/customers/register', { accept_terms: true, first_name: first, last_name: last, email, password: CUSTOMER_PASSWORD });
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 409) throw e;
        data = await call('POST', '/users/login', { email, password: CUSTOMER_PASSWORD });
      }
      const id = (data.customer ?? data.user ?? data.account)?.id as number;
      await db.execute(
        verified
          ? sql`update customers set email_verified_at = coalesce(email_verified_at, now()), phone = coalesce(phone, ${'09' + String(33000000 + id).slice(-8)}), preferred_branch_id = ${B1} where id = ${id}`
          : sql`update customers set preferred_branch_id = ${B1} where id = ${id}`,
      );
      shoppers[key] = { key, token: data.token ?? data.access_token, id };
    });
  }
  const C = (k: string) => (method: string, path: string, body?: unknown) => call(method, path, body, shoppers[k]!.token);
  await step('addresses', async () => {
    const existing = (await C('ahmad')('GET', '/customers/me/addresses')) as Any[];
    if (existing.length === 0) {
      await C('ahmad')('POST', '/customers/me/addresses', { kind: 'home', label: 'البيت', area: 'دمشق — المزة', details: 'شارع الفيلات الغربية، بناء ١٢، الطابق الثالث', recipient_name: 'أحمد الخطيب' });
      await C('ahmad')('POST', '/customers/me/addresses', { kind: 'work', label: 'المكتب', area: 'دمشق — أبو رمانة', details: 'مقابل السفارة، بناء التجاري، مكتب ٤' });
    }
  });
  await step('wholesale approved (sara)', async () => {
    await C('sara')('POST', '/customers/me/wholesale-request', {}).catch(() => null);
    await S('POST', `/customers/${shoppers['sara']!.id}/wholesale/decide`, { decision: 'approve', reason: 'مكتبة مدرسية مسجّلة' }).catch((e) => {
      if (!(e instanceof ApiError && e.key === 'wholesale_not_pending')) throw e; // already approved by an earlier run
    });
  });
  await step('wholesale pending (layla)', () => C('layla')('POST', '/customers/me/wholesale-request', {}).catch((e) => { if (!(e instanceof ApiError && e.status === 409)) throw e; }));
  await step('wholesale rejected (omar)', async () => {
    await C('omar')('POST', '/customers/me/wholesale-request', {}).catch(() => null);
    await S('POST', `/customers/${shoppers['omar']!.id}/wholesale/decide`, { decision: 'reject', reason: 'لم يُرفق سجل تجاري — أعد الطلب مع صورة السجل' });
  });
  await step('credit limit (ahmad)', () => S('PUT', `/customers/${shoppers['ahmad']!.id}/account/limit`, { limit_syp: 200000 }));
  await step('deposit (layla)', () => S('POST', `/customers/${shoppers['layla']!.id}/account/entries`, { amount_syp: 50000, note: 'إيداع مسبق' }));
}

const paidSales: number[] = [];

async function sale(opts: {
  lines: [string, number, number][];
  customer?: string;
  name?: string;
  discount?: [number, string];
  pay?: Any[] | 'cash' | 'card';
  branch?: number;
}): Promise<Any> {
  const s = await S('POST', '/sales', {
    branch_id: opts.branch ?? B1,
    customer_id: opts.customer ? shoppers[opts.customer]!.id : null,
    customer_name: opts.name ?? null,
  });
  for (const [k, i, q] of opts.lines) await S('POST', `/sales/${s.id}/lines`, { variant_id: V(k, i), qty: q });
  if (opts.discount) await S('POST', `/sales/${s.id}/discount`, { percent: opts.discount[0], reason: opts.discount[1] });
  if (!opts.pay) return S('GET', `/sales/${s.id}`);
  const cur = await S('GET', `/sales/${s.id}`);
  const total = cur.total_syp as number;
  const payments =
    opts.pay === 'cash'
      ? [{ method: 'cash', amount_syp: total, tendered_syp: Math.ceil(total / 5000) * 5000 + (total % 5000 === 0 ? 5000 : 0) }]
      : opts.pay === 'card'
        ? [{ method: 'card', amount_syp: total, reference: `POS-${1000 + paidSales.length}` }]
        : opts.pay.map((p: Any) => (p.amount_syp === 'rest' ? { ...p, amount_syp: total - (opts.pay as Any[]).filter((x) => x !== p).reduce((a: number, x: Any) => a + x.amount_syp, 0) } : p));
  const paid = await S('POST', `/sales/${s.id}/pay`, { payments });
  paidSales.push(paid.id);
  return paid;
}

async function pos(): Promise<void> {
  section('Point of sale — paid, split, credit, discount, held, open, void, returns');
  const history: [string, number, number][][] = [
    [['bic', 0, 3], ['school_nb', 0, 2]],
    [['noris', 0, 12], ['eraser', 0, 2], ['ruler', 2, 1]],
    [['colored_pencils', 0, 1], ['crayons', 0, 1]],
    [['copy_paper', 0, 2]],
    [['stabilo', 0, 4]],
    [['backpack', 0, 1], ['pencil_case', 1, 1]],
    [['g2', 0, 2], ['sticky', 0, 3]],
    [['geo_set', 0, 1], ['mech', 1, 1], ['leads', 0, 2]],
    [['calculator', 0, 1]],
    [['folder', 0, 5], ['envelopes', 0, 10]],
    [['watercolor', 0, 1], ['brushes', 0, 1]],
    [['school_nb', 3, 4], ['bic', 1, 5]],
  ];
  for (const [i, lines] of history.entries()) {
    await step(`history sale ${i + 1}`, () => sale({ lines, pay: i % 3 === 1 ? 'card' : 'cash', name: i % 4 === 0 ? 'زبون عابر' : undefined }));
  }
  const s1 = await step('split cash + card', () => sale({ lines: [['fountain', 0, 1], ['journal', 0, 1]], name: 'م. رامي', pay: [{ method: 'card', amount_syp: 200000, reference: 'VISA-4411' }, { method: 'cash', amount_syp: 'rest', tendered_syp: null }] }));
  void s1;
  const onAccount = await step('on account (ahmad)', () => sale({ lines: [['copy_paper', 0, 1], ['stapler', 0, 1]], customer: 'ahmad', pay: [{ method: 'on_account', amount_syp: 'rest' }] }));
  void onAccount;
  await step('manual discount 5%', () => sale({ lines: [['canvas', 1, 2], ['acrylic', 0, 1]], name: 'أستاذة رنا', discount: [5, 'زبونة دائمة'], pay: 'cash' }));
  await step('promotions applied (bxgy + tiers)', () => sale({ lines: [['stabilo', 1, 4], ['noris', 1, 24]], pay: 'cash' }));
  const toReturn = await step('sale to be returned', () => sale({ lines: [['scissors', 0, 2], ['glue_stick', 0, 3], ['clay', 0, 1]], customer: 'sara', pay: 'cash' }));
  const oldSale = await step('old sale (beyond window)', () => sale({ lines: [['wrapping', 0, 3], ['balloons', 0, 2]], name: 'حفلة عيد ميلاد', pay: 'cash' }));

  // Returns
  if (toReturn) {
    await step('return — sellable, cash', async () => {
      const line = (toReturn.lines as Any[]).find((l) => l.variant_id === V('scissors'));
      await S('POST', '/returns', { branch_id: B1, sale_id: toReturn.id, lines: [{ sale_line_id: line.id, qty: 1, condition: 'sellable' }], refund_method: 'cash', reason: 'اشترت واحداً زائداً' });
    });
    await step('return — damaged, store credit', async () => {
      const line = (toReturn.lines as Any[]).find((l) => l.variant_id === V('glue_stick'));
      await S('POST', '/returns', { branch_id: B1, sale_id: toReturn.id, lines: [{ sale_line_id: line.id, qty: 2, condition: 'damaged' }], refund_method: 'customer_credit', reason: 'العبوة جافّة' });
    });
  }
  if (oldSale) {
    await step('return beyond window (manager approval)', async () => {
      await db.execute(sql`update sales set created_at = now() - interval '20 days', paid_at = now() - interval '20 days' where id = ${oldSale.id}`);
      const line = (oldSale.lines as Any[])[0];
      await S('POST', '/returns/approve', { branch_id: B1, sale_id: oldSale.id, lines: [{ sale_line_id: line.id, qty: 1, condition: 'sellable' }], refund_method: 'cash', reason: 'ورق ممزّق', email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    });
  }
  await step('pay with store credit (sara)', () => sale({ lines: [['sticky', 1, 1]], customer: 'sara', pay: [{ method: 'customer_credit', amount_syp: 'rest' }] }));
  await step('debt repayment (ahmad)', () => S('POST', `/customers/${shoppers['ahmad']!.id}/account/entries`, { amount_syp: 30000, note: 'تسديد جزء من الذمّة نقداً' }));

  // Held, open, void
  await step('held basket', async () => {
    const s = await sale({ lines: [['trolley', 0, 1], ['bottle', 1, 1]], name: 'زبون نسي محفظته' });
    await S('POST', `/sales/${s.id}/hold`, { held: true });
  });
  await step('open basket', () => sale({ lines: [['bic', 0, 2], ['tape', 0, 1]] }));
  await step('void basket', async () => {
    const s = await sale({ lines: [['frame', 1, 1]] });
    await S('POST', `/sales/${s.id}/void`);
  });
  await step('sale in Mezzeh', () => sale({ branch: B2, lines: [['backpack', 1, 1], ['eraser', 0, 3]], pay: 'cash' }));
}

async function online(): Promise<void> {
  section('Online — carts, orders (every state), demand');
  const C = (k: string) => (method: string, path: string, body?: unknown) => call(method, path, body, shoppers[k]!.token);
  const A = C('ahmad');
  const order = async (lines: [string, number, number][], note?: string) => {
    for (const [k, i, q] of lines) await A('POST', `/cart/items?branch_id=${B1}`, { variant_id: V(k, i), qty: q });
    return A('POST', '/cart/checkout', { branch_id: B1, note });
  };
  await step('order pending pickup', () => order([['colored_pencils', 1, 1], ['sketch', 0, 1]], 'سآتي بعد الظهر'));
  await step('order picked up', async () => {
    const o = await order([['school_nb', 1, 5], ['noris', 0, 12]]);
    const p = await S('POST', `/orders/${o.id}/pickup`);
    const s = await S('GET', `/sales/${p.sale_id}`);
    await S('POST', `/sales/${p.sale_id}/pay`, { payments: [{ method: 'cash', amount_syp: s.total_syp, tendered_syp: s.total_syp }] });
  });
  await step('order at the till', async () => {
    const o = await order([['calculator', 0, 1]]);
    await S('POST', `/orders/${o.id}/pickup`);
  });
  await step('order cancelled by customer', async () => {
    const o = await order([['backpack', 1, 1]]);
    await A('POST', `/my-orders/${o.id}/cancel`, { reason: 'اشتريت من مكان آخر' });
  });
  await step('order cancelled by branch', async () => {
    const o = await order([['journal', 0, 1]]);
    await S('POST', `/orders/${o.id}/cancel`, { reason: 'القطعة المعروضة تالفة — نعتذر، سنعلمك عند وصول غيرها' });
  });
  await step('order expired', async () => {
    const o = await order([['pen_set', 0, 1]]);
    await db.execute(sql`update orders set reserved_until = now() - interval '2 hours', created_at = now() - interval '26 hours' where id = ${o.id}`);
    await S('GET', `/orders?branch_id=${B1}`);
  });
  await step('order from Mezzeh', async () => {
    await A('POST', `/cart/items?branch_id=${B2}`, { variant_id: V('rollerball'), qty: 2 });
    await A('POST', '/cart/checkout', { branch_id: B2 });
  });
  // Open carts
  await step('cart (ahmad) with a problem line', async () => {
    await A('POST', `/cart/items?branch_id=${B1}`, { variant_id: V('bic', 0), qty: 10 });
    await A('POST', `/cart/items?branch_id=${B1}`, { variant_id: V('stabilo', 2), qty: 4 });
    await A('POST', `/cart/items?branch_id=${B1}`, { variant_id: V('fountain'), qty: 1 });
    await A('POST', `/cart/items?branch_id=${B1}`, { variant_id: V('trolley'), qty: 2 });
    // Someone bought the last trolley at the till after it went into the cart → not_enough.
    await sale({ lines: [['trolley', 0, 2]], pay: 'cash', name: 'زبون الصندوق' });
  });
  await step('cart (sara, wholesale)', async () => {
    const Sa = C('sara');
    await Sa('POST', `/cart/items?branch_id=${B1}`, { variant_id: V('copy_paper'), qty: 10 });
    await Sa('POST', `/cart/items?branch_id=${B1}`, { variant_id: V('school_nb', 1), qty: 40 });
  });
  // Demand
  await step('demand: notify (out everywhere)', async () => {
    await A('POST', '/storefront/interest', { variant_id: V('wb_marker', 0), branch_id: B1, kind: 'notify' });
    await C('layla')('POST', '/storefront/interest', { variant_id: V('wb_marker', 0), branch_id: B1, kind: 'notify' });
    await C('omar')('POST', '/storefront/interest', { variant_id: V('wb_marker', 1), branch_id: B1, kind: 'notify' });
  });
  await step('demand: request here (in another branch)', async () => {
    await A('POST', '/storefront/interest', { variant_id: V('rollerball'), branch_id: B1, kind: 'request_here' });
    await C('sara')('POST', '/storefront/interest', { variant_id: V('rollerball'), branch_id: B1, kind: 'request_here' });
    await C('layla')('POST', '/storefront/interest', { variant_id: V('g2', 3), branch_id: B1, kind: 'request_here' });
  });
}

function tinyPdf(title: string): Buffer {
  const text = `BT /F1 24 Tf 72 720 Td (${title}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

async function printing(): Promise<void> {
  section('Printing — rates, tiers, branch overrides, recipe, jobs in every state');
  const cfg = await S('GET', '/printing/config');
  const opt = (kind: string, code: string): number =>
    (cfg.options as Any[]).find((o) => o.kind === kind && o.code === code).id;
  const sizes: [string, number][] = [['a4', 1], ['a5', 0.7], ['a3', 2], ['letter', 1]];
  const page_rates: Any[] = [];
  for (const [size, mult] of sizes) {
    for (const [color, base] of [['bw', 250], ['color', 1000]] as const) {
      for (const [side, sm] of [['single', 1], ['double', 1.7]] as const) {
        page_rates.push({ paper_size_id: opt('paper_size', size), color_mode_id: opt('color_mode', color), sides_id: opt('sides', side), amount_syp: Math.round((base * mult * sm) / 50) * 50 });
      }
    }
  }
  const finishing_rates = [
    ['binding', 'none', 0], ['binding', 'staple', 200], ['binding', 'spiral', 3000], ['binding', 'perfect', 8000],
    ['cover', 'none', 0], ['cover', 'soft', 1500], ['cover', 'plastic', 1000],
  ].map(([k, c, a]) => ({ option_id: opt(k as string, c as string), amount_syp: a }));
  await step('central rates', () => S('PUT', '/printing/rates', { page_rates, finishing_rates }));
  await step('tiers', () => S('PUT', '/printing/tiers', { tiers: [{ min_pages: 100, discount_percent: 5 }, { min_pages: 500, discount_percent: 10 }, { min_pages: 2000, discount_percent: 15 }] }));
  await step('B2 overrides', async () => {
    await S('PUT', `/printing/branches/${B2}/rates`, { page_rates: [{ paper_size_id: opt('paper_size', 'a4'), color_mode_id: opt('color_mode', 'bw'), sides_id: opt('sides', 'single'), amount_syp: 220 }], finishing_rates: [] });
    await S('PUT', `/printing/branches/${B2}/options`, { options: [{ option_id: opt('paper_size', 'a3'), is_enabled: false }, { option_id: opt('binding', 'perfect'), is_enabled: false }] })
      .catch(() => S('PUT', `/printing/branches/${B2}/options`, { disabled_option_ids: [opt('paper_size', 'a3'), opt('binding', 'perfect')] }));
  });
  await step('inactive option (letter)', () => S('PATCH', `/printing/options/${opt('paper_size', 'letter')}`, { is_active: false }));
  await step('consumption recipe', () =>
    S('PUT', '/printing/consumption-rules', {
      rules: [
        { option_id: opt('paper_size', 'a4'), variant_id: V('prod_paper'), basis: 'per_sheet', qty: 1 },
        { option_id: opt('color_mode', 'bw'), variant_id: V('prod_ink_bw'), basis: 'per_printed_page', yield_pages: 3000 },
        { option_id: opt('color_mode', 'color'), variant_id: V('prod_ink_color'), basis: 'per_printed_page', yield_pages: 1500 },
        { option_id: opt('binding', 'spiral'), variant_id: V('prod_coil'), basis: 'per_copy', qty: 1 },
        { option_id: opt('cover', 'plastic'), variant_id: V('prod_cover'), basis: 'per_copy', qty: 2 },
      ],
    }),
  );
  for (const k of ['prod_ink_bw', 'prod_ink_color']) {
    await step(`install baseline ${k}`, () => S('POST', `/printing/consumables/${V(k)}/install`, { branch_id: B1 }));
  }

  const A = (method: string, path: string, body?: unknown) => call(method, path, body, shoppers['ahmad']!.token);
  const spec = (o: Partial<Record<'size' | 'color' | 'sides' | 'binding' | 'cover', string>> = {}) => ({
    paper_size_id: opt('paper_size', o.size ?? 'a4'),
    color_mode_id: opt('color_mode', o.color ?? 'bw'),
    sides_id: opt('sides', o.sides ?? 'single'),
    binding_id: opt('binding', o.binding ?? 'none'),
    cover_id: opt('cover', o.cover ?? 'none'),
  });
  const withFile = async (id: number, name: string, bytes = tinyPdf(name)) => {
    const f = await A('POST', `/print-jobs/${id}/files`, { filename: name, bytes: bytes.length });
    const r = await fetch(ORIGIN + f.upload.url, { method: 'PUT', headers: f.upload.headers, body: bytes });
    await r.arrayBuffer();
    return A('POST', `/print-jobs/${id}/files/${f.file.id}/complete`);
  };
  const newJob = async (note: string, o: Parameters<typeof spec>[0], copies: number, file: string | null, link?: string) => {
    const j = await A('POST', '/print-jobs', { branch_id: B1, copies, note, ...spec(o) });
    if (file) await withFile(j.id, file);
    if (link) await A('POST', `/print-jobs/${j.id}/links`, { url: link, note: 'الملف على درايف' });
    return j;
  };
  const submitted = async (...args: Parameters<typeof newJob>) => {
    const j = await newJob(...args);
    return A('POST', `/print-jobs/${j.id}/submit`);
  };
  const quoted = async (pages: number, ...args: Parameters<typeof newJob>) => {
    const j = await submitted(...args);
    return S('POST', `/printing/jobs/${j.id}/quote`, { pages });
  };
  const paidJob = async (pages: number, ...args: Parameters<typeof newJob>) => {
    const j = await quoted(pages, ...args);
    const s = await S('POST', '/sales', { branch_id: B1, customer_id: shoppers['ahmad']!.id });
    await S('POST', `/sales/${s.id}/services`, { kind: 'print_job', reference: j.number });
    const cur = await S('GET', `/sales/${s.id}`);
    await S('POST', `/sales/${s.id}/pay`, { payments: [{ method: 'cash', amount_syp: cur.total_syp, tendered_syp: cur.total_syp }] });
    return j;
  };

  await step('job: draft', () => newJob('مسودة — لم أرسلها بعد', { color: 'color' }, 1, 'صور الرحلة.pdf'));
  await step('job: draft with rejected file', async () => {
    const j = await newJob('ملف غير صالح', {}, 1, null);
    const fake = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(2000, 1)]);
    await withFile(j.id, 'invoice.pdf', fake);
  });
  await step('job: awaiting quote', () => submitted('أحتاجها غداً صباحاً', { binding: 'spiral', cover: 'plastic' }, 2, 'مشروع التخرج.pdf'));
  await step('job: awaiting quote (link)', () => submitted('الرابط فيه ٣ ملفات', {}, 1, null, 'https://drive.google.com/file/d/showcase-demo/view'));
  await step('job: awaiting payment', () => quoted(40, 'ملخص مادة الفيزياء', { sides: 'double', binding: 'staple' }, 3, 'ملخص الفيزياء.pdf'));
  await step('job: at the till', async () => {
    const j = await quoted(12, 'سيرة ذاتية ملوّنة', { color: 'color' }, 5, 'CV.pdf');
    const s = await S('POST', '/sales', { branch_id: B1, customer_id: shoppers['ahmad']!.id });
    await S('POST', `/sales/${s.id}/services`, { kind: 'print_job', reference: j.number });
  });
  await step('job: queued (paid)', () => paidJob(25, 'تقرير المختبر', {}, 2, 'تقرير.pdf'));
  await step('job: deferred', async () => {
    const j = await quoted(120, 'مذكرة جامعية كبيرة', { sides: 'double', binding: 'spiral' }, 1, 'مذكرة.pdf');
    await S('POST', `/printing/jobs/${j.id}/defer`, { reason: 'زبون دائم — يدفع عند الاستلام' });
  });
  await step('job: in production', async () => {
    const j = await paidJob(60, 'كتيّب الشركة', { binding: 'spiral', cover: 'plastic' }, 4, 'كتيب.pdf');
    await S('POST', `/printing/jobs/${j.id}/status`, { status: 'in_production' });
  });
  await step('job: ready', async () => {
    const j = await paidJob(8, 'دعوات حفلة', { color: 'color', size: 'a5' }, 20, 'دعوة.pdf');
    await S('POST', `/printing/jobs/${j.id}/status`, { status: 'in_production' });
    await S('POST', `/printing/jobs/${j.id}/status`, { status: 'ready' });
  });
  await step('job: picked up', async () => {
    const j = await paidJob(30, 'أوراق عمل الصف', {}, 25, 'أوراق عمل.pdf');
    for (const st of ['in_production', 'ready', 'picked_up']) await S('POST', `/printing/jobs/${j.id}/status`, { status: st });
  });
  await step('job: cancelled by customer', async () => {
    const j = await submitted('طلبت بالخطأ', {}, 1, 'خطأ.pdf');
    await A('POST', `/print-jobs/${j.id}/cancel`, { reason: 'أرسلت الملف الخطأ' });
  });
  await step('job: cancelled by branch', async () => {
    const j = await submitted('ملف محمي', {}, 1, 'محمي.pdf');
    await S('POST', `/printing/jobs/${j.id}/cancel`, { reason: 'الملف محمي بكلمة سر — أرسله بدونها' });
  });
  await step('job: expired', async () => {
    const j = await quoted(15, 'لم يأتِ أحد', {}, 1, 'قديم.pdf');
    await db.execute(sql`update print_jobs set payment_due_at = now() - interval '1 hour', quoted_at = now() - interval '4 days' where id = ${j.id}`);
    await A('GET', '/print-jobs');
  });
}

async function documents(): Promise<void> {
  section('Documents — business profile with logo');
  await step('profile', async () => {
    const logo = await uploadImage(await logoTile('QIRTAS', '#1e56c8'), '/documents/logo');
    await S('PUT', '/documents/profile', {
      name_ar: 'قرطاس للقرطاسية والطباعة',
      name_en: 'Qirtas Stationery & Printing',
      logo_media_id: logo,
      tax_number: '300-456-789',
      commercial_register: 'دمشق ١٢٣٤٥',
    });
  });
}

async function backdate(): Promise<void> {
  section('Back-dating — sales spread over a month, drafts aged, demand aged');
  await step('sales history', () =>
    db.execute(sql`
      update sales s set created_at = t.at, paid_at = t.at
      from (select id, now() - ((row_number() over (order by id)) * interval '2 days' + interval '3 hours') as at
            from sales where status = 'paid' and paid_at > now() - interval '1 day' and id in (select id from sales order by id limit 12)) t
      where s.id = t.id`),
  );
  await step('drafts aged', () =>
    db.execute(sql`update catalog_products set created_at = now() - (id % 9 + 2) * interval '1 day' where is_branch_draft`),
  );
  await step('demand aged', () =>
    db.execute(sql`update storefront_demand set created_at = now() - (id % 6 + 1) * interval '1 day'`),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Every branch, every account
// ─────────────────────────────────────────────────────────────────────────────
//
// The scenarios above live in three branches and act as the Super Admin. A
// cashier in Homs or a customer who never took part would still open empty
// screens. This pass gives every live branch its own stock, documents, sales,
// orders and print jobs — each written **by that branch's own staff** where
// the role allows it — and gives every active customer a cart, orders, a print
// job and a request of their own.
//
// Tokens are minted with the session service instead of signing in: the demo
// staff share one known password but the e2e and real accounts do not, and a
// login per account would also trip the login rate limit. The minted sessions
// are deleted at the end so they never show up under «my devices».

const SEED_DEVICE = 'showcase-seed';

async function mint(realm: typeof staffAuthRealm, userId: number): Promise<string> {
  return (await createSession(realm, { userId, provider: 'local', deviceInfo: SEED_DEVICE })).token;
}

/** Many small steps: failures are grouped by kind instead of printed one by one. */
const quietFailures = new Map<string, { n: number; example: string }>();
async function quiet<T>(kind: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    const entry = quietFailures.get(kind) ?? { n: 0, example: e instanceof Error ? e.message : String(e) };
    entry.n++;
    quietFailures.set(kind, entry);
    return null;
  }
}

/** Calls as a staff account, falling back to the Super Admin when the role cannot. */
function actor(token: string | undefined) {
  return async (method: string, path: string, body?: unknown): Promise<Any> => {
    if (!token) return S(method, path, body);
    try {
      return await call(method, path, body, token);
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) return S(method, path, body);
      throw e;
    }
  };
}

/** Always stocked in quantity, so orders and sales at any branch find them. */
const CORE_STOCK = ['bic', 'school_nb', 'noris', 'eraser', 'colored_pencils', 'sticky', 'ruler', 'folder', 'copy_paper', 'stabilo'];
/** Stocked thinly or not at all, depending on the branch — gives every branch low and out-of-stock rows. */
const THIN_STOCK = ['g2', 'mech', 'spiral', 'journal', 'geo_set', 'scissors', 'backpack', 'pencil_case', 'crayons', 'watercolor', 'calculator', 'stapler', 'glue_stick', 'sketch', 'planner', 'frame'];
const PRINT_STOCK = ['prod_paper', 'prod_ink_bw', 'prod_ink_color', 'prod_coil'];

interface BranchCrew {
  id: number;
  name: string;
  shoppable: boolean;
  cashier?: string;
  manager?: string;
  inventory?: string;
  printer?: string;
  service?: string;
}

async function crews(): Promise<BranchCrew[]> {
  const branches = (
    await db.execute<{ id: number; name: string; status: string }>(
      sql`select id, name, status from branches where archived_at is null and status <> 'closed' order by id`,
    )
  ).rows;
  const staff = (
    await db.execute<{ user_id: number; branch_id: number; role: string }>(
      sql`select distinct on (a.branch_id, r.name) a.user_id, a.branch_id, r.name as role
          from user_role_assignments a
          join roles r on r.id = a.role_id
          join users u on u.id = a.user_id
          where a.valid_to is null and a.branch_id is not null
            and u.status = 'active' and u.archived_at is null
          order by a.branch_id, r.name, a.user_id`,
    )
  ).rows;
  const roleSlot: Record<string, keyof BranchCrew> = {
    'أمين صندوق / مبيعات': 'cashier',
    'مدير الفرع': 'manager',
    'موظف مخزون': 'inventory',
    'موظف إنتاج طباعة': 'printer',
    'خدمة العملاء': 'service',
  };
  const out: BranchCrew[] = [];
  for (const b of branches) {
    const crew: BranchCrew = { id: b.id, name: b.name, shoppable: b.status === 'active' };
    for (const s of staff.filter((x) => x.branch_id === b.id)) {
      const slot = roleSlot[s.role];
      if (slot && !crew[slot]) (crew as Any)[slot] = await mint(staffAuthRealm, s.user_id);
    }
    out.push(crew);
  }
  return out;
}

/** Deterministic spread so re-runs produce the same shelves. */
const spreadQty = (branch: number, key: string, min: number, span: number) =>
  min + (parseInt(hash(`${branch}:${key}`).slice(0, 6), 16) % span);

async function spreadBranch(c: BranchCrew, sups: string[]): Promise<void> {
  const inv = actor(c.inventory ?? c.manager);
  const mgr = actor(c.manager);
  const till = actor(c.cashier ?? c.manager);
  const main = c.id === B1;

  // Stock — the main branch already has the curated shelves.
  if (!main) {
    const lines: Any[] = [];
    for (const k of CORE_STOCK) lines.push({ k, qty: spreadQty(c.id, k, 25, 40) });
    for (const k of THIN_STOCK) {
      const q = spreadQty(c.id, k, 0, 14) - 4; // ≈ a third of them stay out of stock
      if (q > 0) lines.push({ k, qty: q });
    }
    for (const k of PRINT_STOCK) lines.push({ k, qty: k === 'prod_paper' ? 2000 : 3 });
    await quiet('branch receipt', () =>
      inv('POST', '/inventory/receipts', {
        branch_id: c.id,
        supplier_id: supplier[sups[c.id % sups.length]!],
        supplier_invoice_no: `BR${c.id}-${1000 + c.id}`,
        invoice_date: iso(days(-18)),
        currency: 'SYP',
        lines: lines.map(({ k, qty }) => {
          const b = built.get(k)!;
          return { variant_id: b.variants[0]!.id, unit_id: b.variants[0]!.baseUnitId, qty, unit_cost: Math.round((priceOf(b, 0) || 1000) * 0.6) };
        }),
      }),
    );
    await quiet('branch threshold', () =>
      inv('PUT', `/inventory/variants/${V('colored_pencils')}/threshold`, { branch_id: c.id, threshold: 80 }),
    );
    await quiet('branch damage', () =>
      inv('POST', '/inventory/adjustments', { branch_id: c.id, reason: 'damage', note: 'تلف أثناء الترتيب', lines: [{ variant_id: V('eraser'), qty_base: 2 }] }),
    );
    await quiet('branch pending loss', () =>
      inv('POST', '/inventory/adjustments', { branch_id: c.id, reason: 'loss', note: 'نقص عند الجرد', lines: [{ variant_id: V('copy_paper'), qty_base: 4 }] }),
    );
    // Goods from the main branch: one delivered, one on the road, one asked for by this branch.
    await quiet('branch transfer received', async () => {
      const t = await S('POST', '/inventory/transfers', { from_branch_id: B1, to_branch_id: c.id, note: 'تزويد دوري من الفرع الرئيسي', lines: [{ variant_id: V('school_nb', 1), qty_requested: 10 }] });
      await S('POST', `/inventory/transfers/${t.id}/ship`, { lines: [] });
      await inv('POST', `/inventory/transfers/${t.id}/receive`, { lines: [] });
    });
    await quiet('branch transfer in transit', async () => {
      const t = await S('POST', '/inventory/transfers', { from_branch_id: B1, to_branch_id: c.id, note: 'بالطريق', lines: [{ variant_id: V('noris', 1), qty_requested: 12 }] });
      await S('POST', `/inventory/transfers/${t.id}/ship`, { lines: [] });
    });
    await quiet('branch transfer requested', async () => {
      const t = await mgr('POST', '/inventory/transfers', { from_branch_id: B1, to_branch_id: c.id, note: 'نحتاج أقلاماً فوسفورية', lines: [{ variant_id: V('stabilo', 1), qty_requested: 8 }] });
      if (t.status !== 'requested') {
        await db.execute(sql`update stock_transfers set status = 'requested', approved_by_user_id = null where id = ${t.id}`);
      }
    });
    await quiet('branch count', async () => {
      const k = await inv('POST', '/inventory/counts', { branch_id: c.id, scope: 'list', note: 'جرد دوري' });
      await inv('POST', `/inventory/counts/${k.id}/lines`, { variant_id: V('bic'), counted_qty: spreadQty(c.id, 'bic', 25, 40) });
    });
  }

  // The till — sales by this branch's own cashier.
  const sell = async (lines: [string, number][], pay: 'cash' | 'card' | null, name?: string) => {
    const s = await till('POST', '/sales', { branch_id: c.id, customer_name: name ?? null });
    for (const [k, q] of lines) await till('POST', `/sales/${s.id}/lines`, { variant_id: V(k), qty: q });
    if (!pay) return s;
    const cur = await till('GET', `/sales/${s.id}`);
    return till('POST', `/sales/${s.id}/pay`, {
      payments: [pay === 'cash' ? { method: 'cash', amount_syp: cur.total_syp, tendered_syp: Math.ceil(cur.total_syp / 1000) * 1000 } : { method: 'card', amount_syp: cur.total_syp, reference: `POS-${c.id}-${s.id}` }],
    });
  };
  const baskets: [string, number][][] = [
    [['bic', 2], ['school_nb', 1]],
    [['noris', 6], ['eraser', 2]],
    [['colored_pencils', 1]],
    [['sticky', 2], ['folder', 3]],
    [['copy_paper', 1], ['ruler', 1]],
  ];
  let first: Any = null;
  for (const [i, lines] of baskets.entries()) {
    const paid = await quiet('branch sale', () => sell(lines, i % 2 ? 'card' : 'cash', i === 0 ? 'زبون عابر' : undefined));
    first ??= paid;
  }
  await quiet('branch held basket', async () => {
    const s = await sell([['stabilo', 2]], null, 'ينتظر زميله');
    await till('POST', `/sales/${s.id}/hold`, { held: true });
  });
  await quiet('branch open basket', () => sell([['bic', 1]], null));
  if (first) {
    await quiet('branch return', () =>
      mgr('POST', '/returns', { branch_id: c.id, sale_id: first.id, lines: [{ sale_line_id: first.lines[0].id, qty: 1, condition: 'sellable' }], refund_method: 'cash', reason: 'غيّر رأيه' }),
    );
  }
}

async function spreadCustomers(branchCrews: BranchCrew[], printOpts: Any): Promise<number> {
  const rows = (
    await db.execute<{ id: number; verified: boolean }>(
      sql`select id, email_verified_at is not null as verified from customers
          where status = 'active' and archived_at is null and email not like 'showcase.%'
          order by id`,
    )
  ).rows;
  const shops = branchCrews.filter((c) => c.shoppable);
  const opt = (kind: string, code: string): number =>
    (printOpts.options as Any[]).find((o) => o.kind === kind && o.code === code).id;
  const spec = {
    paper_size_id: opt('paper_size', 'a4'),
    color_mode_id: opt('color_mode', 'bw'),
    sides_id: opt('sides', 'single'),
    binding_id: opt('binding', 'none'),
    cover_id: opt('cover', 'none'),
  };

  for (const [i, row] of rows.entries()) {
    const shop = shops[i % shops.length]!;
    const token = await mint(customerAuthRealm, row.id);
    const me = (method: string, path: string, body?: unknown) => call(method, path, body, token);
    const till = actor(shop.cashier ?? shop.manager);
    const printer = actor(shop.printer ?? shop.manager);

    await quiet('customer address', async () => {
      const list = (await me('GET', '/customers/me/addresses')) as Any[];
      if (list.length === 0) await me('POST', '/customers/me/addresses', { kind: 'home', label: 'البيت', area: shop.name.replace(/^فرع /, ''), details: `شارع ${10 + (row.id % 40)}، بناء ${1 + (row.id % 20)}` });
    });
    await quiet('customer demand', () => me('POST', '/storefront/interest', { variant_id: V('wb_marker', i % 3), branch_id: shop.id, kind: 'notify' }));

    if (row.verified) {
      const order = async (k: string, q: number) => {
        await me('POST', `/cart/items?branch_id=${shop.id}`, { variant_id: V(k), qty: q });
        return me('POST', '/cart/checkout', { branch_id: shop.id });
      };
      await quiet('customer order pending', () => order(CORE_STOCK[i % CORE_STOCK.length]!, 1 + (i % 3)));
      if (i % 2 === 0) {
        await quiet('customer order picked up', async () => {
          const o = await order(CORE_STOCK[(i + 3) % CORE_STOCK.length]!, 2);
          const p = await till('POST', `/orders/${o.id}/pickup`);
          const s = await till('GET', `/sales/${p.sale_id}`);
          await till('POST', `/sales/${p.sale_id}/pay`, { payments: [{ method: 'cash', amount_syp: s.total_syp, tendered_syp: s.total_syp }] });
        });
      }
      if (i % 3 === 0) {
        await quiet('customer order cancelled', async () => {
          const o = await order(CORE_STOCK[(i + 5) % CORE_STOCK.length]!, 1);
          await me('POST', `/my-orders/${o.id}/cancel`, { reason: 'غيّرت رأيي' });
        });
      }
      // A print job, at a different stage for each customer.
      await quiet('customer print job', async () => {
        const j = await me('POST', '/print-jobs', { branch_id: shop.id, copies: 1 + (i % 4), note: 'مطلوب بأسرع وقت', ...spec });
        await me('POST', `/print-jobs/${j.id}/links`, { url: `https://drive.google.com/file/d/showcase-${row.id}/view` });
        const sub = await me('POST', `/print-jobs/${j.id}/submit`);
        const stage = i % 4;
        if (stage === 0) return;
        const q = await printer('POST', `/printing/jobs/${sub.id}/quote`, { pages: 10 + (i % 30) });
        if (stage === 1) return;
        const s = await till('POST', '/sales', { branch_id: shop.id, customer_id: row.id });
        await till('POST', `/sales/${s.id}/services`, { kind: 'print_job', reference: q.number });
        const cur = await till('GET', `/sales/${s.id}`);
        await till('POST', `/sales/${s.id}/pay`, { payments: [{ method: 'cash', amount_syp: cur.total_syp, tendered_syp: cur.total_syp }] });
        await printer('POST', `/printing/jobs/${sub.id}/status`, { status: 'in_production' });
        if (stage === 3) await printer('POST', `/printing/jobs/${sub.id}/status`, { status: 'ready' });
      });
    }
    // Something left in the cart — unverified customers can fill one too.
    await quiet('customer cart', async () => {
      await me('POST', `/cart/items?branch_id=${shop.id}`, { variant_id: V(CORE_STOCK[(i + 7) % CORE_STOCK.length]!), qty: 1 });
      await me('POST', `/cart/items?branch_id=${shop.id}`, { variant_id: V('colored_pencils', i % 3), qty: 1 });
    });
  }
  return rows.length;
}

async function everyBranchEveryAccount(): Promise<void> {
  const branchCrews = await crews();
  section(`Every branch (${branchCrews.length}) and every account`);
  const printOpts = await S('GET', '/printing/config');
  const sups = ['amal', 'warraq', 'funoon', 'sham'];
  for (const c of branchCrews) {
    await spreadBranch(c, sups);
    process.stdout.write('.');
  }
  console.log();
  const n = await spreadCustomers(branchCrews, printOpts);
  log(`${branchCrews.length} branches, ${n} existing customers`);
  await quiet('spread back-dating', () =>
    db.execute(sql`update sales set created_at = now() - ((id % 24) + 1) * interval '1 day' - (id % 9) * interval '1 hour',
                                    paid_at   = now() - ((id % 24) + 1) * interval '1 day' - (id % 9) * interval '1 hour'
                   where status = 'paid' and branch_id <> ${B1} and paid_at > now() - interval '1 hour'`),
  );
  for (const [kind, { n: count, example }] of quietFailures) {
    console.log(`  ⚠ ${kind}: ${count}× — ${example.slice(0, 160)}`);
  }
}

async function dropSeedSessions(): Promise<void> {
  await db.execute(sql`delete from sessions where device_info = ${SEED_DEVICE}`);
  await db.execute(sql`delete from customer_sessions where device_info = ${SEED_DEVICE}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Run
// ─────────────────────────────────────────────────────────────────────────────

export async function seedShowcase(options: { emailSender: EmailSender }): Promise<void> {
  if (env.NODE_ENV === 'production') throw new Error('seed-showcase refuses to run with NODE_ENV=production');
  const t0 = Date.now();
  // One log line per HTTP request would bury the progress report.
  const level = logger.level;
  logger.level = 'warn';
  const app = buildApp();
  // buildApp() wires the real mail transport; the showcase customers live on
  // @qirtas.test, which no real mailbox should be asked to receive.
  setEmailSender(options.emailSender);
  server = app.listen(0);
  ORIGIN = `http://localhost:${(server.address() as { port: number }).port}`;
  API = `${ORIGIN}/api/v1`;
  try {
    await runShowcase();
  } finally {
    await dropSeedSessions();
    await new Promise((resolve) => server!.close(resolve));
    logger.level = level;
  }
  console.log(`
✔ showcase ready in ${Math.round((Date.now() - t0) / 1000)} s — ${built.size} products, ${failures} failed steps`);
  console.log(`  customers: showcase.{ahmad,sara,khaled,layla,omar}@qirtas.test / ${CUSTOMER_PASSWORD}`);
  console.log(`  branches: ${B1} (main), ${B2}, ${B3}`);
}

async function runShowcase(): Promise<void> {
  await resolveBranches();
  const login = await call('POST', '/users/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  ST = login.token ?? login.access_token;
  await loadReference();

  await settings();
  await brandsAndCategories();
  await suppliers();

  section(`Catalog — ${P.length} products with photos`);
  for (const spec of P) {
    await step(`product ${spec.key}`, () => buildProduct(spec));
    process.stdout.write('.');
  }
  console.log();
  await stock();
  await pricingScenarios();
  await productStates();
  await inventoryScenarios();
  await promotions();
  await collections();
  await customers();
  await pos();
  await online();
  await printing();
  await documents();
  await everyBranchEveryAccount();
  await backdate();
}
