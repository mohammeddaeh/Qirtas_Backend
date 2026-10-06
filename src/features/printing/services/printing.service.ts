import { recordAudit } from '../../../core/audit/audit-recorder.js';
import { BusinessError, NotFoundError } from '../../../core/http/api-error.js';
import type { RequestActorContext } from '../../../core/http/require-actor.js';
import { holdsPermissionAt } from '../../../core/http/require-permission.js';
import { PRINTING_AUDIT, printingTarget } from '../audit-actions.js';
import * as repo from '../repositories/printing.repository.js';
import type { PrintOptionKind, PrintOptionRow } from '../schemas/printing.schema.js';
import {
  bandOf,
  pageRateKey,
  quote,
  specProblem,
  tiersProblem,
  withinBand,
  type PrintConfig,
  type PrintQuote,
  type QuoteInput,
  type QuoteRefusal,
} from './print-rules.js';

export const SETTINGS_KEY = 'printing.settings';
export const BRANCH_SETTINGS_KEY = 'printing.branch_settings';

const PAGE_KINDS: PrintOptionKind[] = ['paper_size', 'color_mode', 'sides'];
const FINISHING_KINDS: PrintOptionKind[] = ['binding', 'cover'];

const num = (v: string): number => Number(v);
const money = (v: number): string => v.toFixed(2);

// ── تحميل الإعداد لفرع ───────────────────────────────────────────────────────

async function loadConfig(
  branchId: number | null,
): Promise<{ config: PrintConfig; options: PrintOptionRow[] }> {
  const [options, central, finishing, tiers, disabled, branchPages, branchFinishing] =
    await Promise.all([
      repo.findOptions(),
      repo.findPageRates(),
      repo.findFinishingRates(),
      repo.findTiers(),
      branchId === null ? Promise.resolve([]) : repo.findDisabledOptionIds(branchId),
      branchId === null ? Promise.resolve([]) : repo.findBranchPageRates(branchId),
      branchId === null ? Promise.resolve([]) : repo.findBranchFinishingRates(branchId),
    ]);
  return {
    options,
    config: {
      options: new Map(
        options.map((o) => [o.id, { id: o.id, kind: o.kind, code: o.code, isActive: o.is_active }]),
      ),
      disabledAtBranch: new Set(disabled),
      centralPageRates: new Map(
        central.map((c) => [
          pageRateKey(c.paper_size_id, c.color_mode_id, c.sides_id),
          num(c.amount_syp),
        ]),
      ),
      branchPageRates: new Map(
        branchPages.map((c) => [
          pageRateKey(c.paper_size_id, c.color_mode_id, c.sides_id),
          num(c.amount_syp),
        ]),
      ),
      centralFinishing: new Map(finishing.map((f) => [f.option_id, num(f.amount_syp)])),
      branchFinishing: new Map(branchFinishing.map((f) => [f.option_id, num(f.amount_syp)])),
      tiers: tiers.map((t) => ({
        minPages: t.min_pages,
        discountPercent: num(t.discount_percent),
      })),
    },
  };
}

async function requireLiveBranch(branchId: number): Promise<{ id: number; name: string }> {
  const branch = await repo.findLiveBranch(branchId);
  if (!branch) throw new NotFoundError('Branch not found');
  return branch;
}

// ── العرض العام: ما يستطيع هذا الفرع طباعته ─────────────────────────────────

export interface WireOfferOption {
  id: number;
  code: string;
  name_ar: string;
  name_en: string | null;
}

export interface WireOffer {
  branch_id: number;
  options: Record<PrintOptionKind, WireOfferOption[]>;
  tiers: { min_pages: number; discount_percent: number }[];
  max_file_mb: number;
  max_pages: number;
}

/**
 * **ما يُعرض للزبون: الفعّال وغير المعطَّل بفرعه وحده.** خيارٌ يظهر ثم يرفضه
 * السعر («لا يُطبع هنا») أسوأ من غيابه — الزبون اختاره وملأ الباقي حوله.
 */
export async function offer(branchId: number): Promise<WireOffer> {
  await requireLiveBranch(branchId);
  const [{ options, config }, settings] = await Promise.all([
    loadConfig(branchId),
    repo.getSettings(),
  ]);
  const grouped = { paper_size: [], color_mode: [], sides: [], binding: [], cover: [] } as Record<
    PrintOptionKind,
    WireOfferOption[]
  >;
  for (const o of options) {
    if (!o.is_active || config.disabledAtBranch.has(o.id)) continue;
    grouped[o.kind].push({ id: o.id, code: o.code, name_ar: o.name_ar, name_en: o.name_en });
  }
  return {
    branch_id: branchId,
    options: grouped,
    tiers: config.tiers.map((t) => ({
      min_pages: t.minPages,
      discount_percent: t.discountPercent,
    })),
    max_file_mb: settings.max_file_mb,
    max_pages: settings.max_pages,
  };
}

// ── التسعير ─────────────────────────────────────────────────────────────────

export interface WireQuote {
  branch_id: number;
  pages: number;
  copies: number;
  printed_pages: number;
  sheets: number;
  page_rate_syp: number;
  page_rate_source: 'central' | 'branch';
  pages_subtotal_syp: number;
  tier: { min_pages: number; discount_percent: number } | null;
  tier_discount_syp: number;
  finishing: {
    option_id: number;
    kind: 'binding' | 'cover';
    per_copy_syp: number;
    source: 'central' | 'branch';
    subtotal_syp: number;
  }[];
  finishing_subtotal_syp: number;
  total_syp: number;
}

function toWireQuote(branchId: number, q: PrintQuote): WireQuote {
  return {
    branch_id: branchId,
    pages: q.pages,
    copies: q.copies,
    printed_pages: q.printedPages,
    sheets: q.sheets,
    page_rate_syp: q.pageRateSyp,
    page_rate_source: q.pageRateSource,
    pages_subtotal_syp: q.pagesSubtotalSyp,
    tier:
      q.tier === null
        ? null
        : { min_pages: q.tier.minPages, discount_percent: q.tier.discountPercent },
    tier_discount_syp: q.tierDiscountSyp,
    finishing: q.finishing.map((f) => ({
      option_id: f.optionId,
      kind: f.kind,
      per_copy_syp: f.perCopySyp,
      source: f.source,
      subtotal_syp: f.subtotalSyp,
    })),
    finishing_subtotal_syp: q.finishingSubtotalSyp,
    total_syp: q.totalSyp,
  };
}

/**
 * الرفض يحمل **أيّ خيارٍ** سبّبه: «غير مسعَّر» بلا اسمٍ يجعل الزبون يغيّر
 * الخيارات عشوائياً حتى يقبل أحدها.
 */
function refusalError(r: QuoteRefusal): BusinessError {
  const data = { option_id: 'optionId' in r ? r.optionId : null };
  switch (r.reason) {
    case 'option_unknown':
      return new BusinessError(422, 'Unknown print option', 'print_option_unknown', data);
    case 'option_wrong_kind':
      return new BusinessError(
        422,
        `Option ${r.optionId} is not a ${r.expected}`,
        'print_option_wrong_kind',
        {
          ...data,
          expected_kind: r.expected,
        },
      );
    case 'option_inactive':
      return new BusinessError(
        409,
        'This print option is no longer offered',
        'print_option_inactive',
        data,
      );
    case 'option_disabled_at_branch':
      return new BusinessError(
        409,
        'This branch does not offer that option',
        'print_option_disabled_at_branch',
        data,
      );
    case 'spec_unpriced':
      return new BusinessError(
        409,
        'This combination has no price yet',
        'print_spec_unpriced',
        data,
      );
  }
}

/**
 * يرفض مواصفةً لا يطبعها هذا الفرع — **بلا سعر**، فالصفحات لم تُعدّ بعد.
 * يستعمله طلب الطباعة عند إنشائه وتعديله، بنفس رفوض `/quote` ومفاتيحها.
 */
export async function assertPrintableSpec(
  branchId: number,
  spec: Omit<QuoteInput, 'pages' | 'copies'>,
): Promise<void> {
  const { config } = await loadConfig(branchId);
  const problem = specProblem(spec, config);
  if (problem !== null) throw refusalError(problem);
}

export async function priceJob(branchId: number, input: QuoteInput): Promise<WireQuote> {
  await requireLiveBranch(branchId);
  const [{ config }, settings] = await Promise.all([loadConfig(branchId), repo.getSettings()]);
  if (input.pages > settings.max_pages) {
    throw new BusinessError(
      422,
      `At most ${settings.max_pages} pages per job`,
      'print_too_many_pages',
      {
        max_pages: settings.max_pages,
      },
    );
  }
  const result = quote(input, config);
  if (!result.ok) throw refusalError(result.refusal);
  return toWireQuote(branchId, result.quote);
}

// ── الإعداد كما تراه الإدارة ─────────────────────────────────────────────────

export interface WirePrintConfig {
  branch: { id: number; name: string } | null;
  /**
   * الفروع الحيّة للمنتقي — تصل هنا لأن شاشة الإعداد لا تقرأ موديول الفروع
   * (نفس حلّ التسعير والمخزون).
   */
  branches: { id: number; name: string }[];
  options: {
    id: number;
    kind: PrintOptionKind;
    code: string;
    name_ar: string;
    name_en: string | null;
    sort_order: number;
    is_active: boolean;
    /** بالفرع المختار وحده — `null` حين لا فرع. */
    is_enabled: boolean | null;
  }[];
  page_rates: {
    paper_size_id: number;
    color_mode_id: number;
    sides_id: number;
    central_syp: number | null;
    branch_syp: number | null;
    /** ما يُقبل للفرع — `null` حين لا مركزي يُقاس عليه. */
    band: { min_syp: number; max_syp: number } | null;
  }[];
  finishing_rates: {
    option_id: number;
    central_syp: number | null;
    branch_syp: number | null;
    band: { min_syp: number; max_syp: number } | null;
  }[];
  tiers: { min_pages: number; discount_percent: number }[];
  settings: {
    branch_band_percent: number;
    file_retention_days: number;
    max_file_mb: number;
    max_pages: number;
    unpaid_timeout_days: number;
    ready_stale_days: number;
  };
  /** الأزرار تتبع هذين لا تخميناً محلياً — نطاق الصلاحية قد يكون فرعاً واحداً. */
  can_edit_central: boolean;
  can_edit_branch: boolean;
}

export async function getConfig(
  actor: RequestActorContext,
  branchId: number | null,
): Promise<WirePrintConfig> {
  const branch = branchId === null ? null : await requireLiveBranch(branchId);
  const [{ options, config }, settings, canCentral, canBranch, branches] = await Promise.all([
    loadConfig(branchId),
    repo.getSettings(),
    holdsPermissionAt(actor.userId, SETTINGS_KEY, null),
    branchId === null
      ? Promise.resolve(false)
      : holdsPermissionAt(actor.userId, BRANCH_SETTINGS_KEY, branchId),
    repo.findLiveBranches(),
  ]);
  // أسعار فرعٍ آخر ليست لمن يدير فرعاً واحداً — القراءة بنطاق الكتابة نفسه.
  if (branchId !== null && !canCentral && !canBranch) {
    throw new BusinessError(
      403,
      'No printing settings permission at this branch',
      'print_scope_denied',
      {
        branch_id: branchId,
      },
    );
  }
  const band = num(settings.branch_band_percent);

  // كل خلية لها سعرٌ بأيّ مستوى — والعميل يبني المصفوفة كاملةً من الخيارات.
  const pageKeys = new Set([...config.centralPageRates.keys(), ...config.branchPageRates.keys()]);
  const pageRates = [...pageKeys].map((key) => {
    const [p, c, s] = key.split(':').map(Number) as [number, number, number];
    const central = config.centralPageRates.get(key) ?? null;
    return {
      paper_size_id: p,
      color_mode_id: c,
      sides_id: s,
      central_syp: central,
      branch_syp: config.branchPageRates.get(key) ?? null,
      band: central === null ? null : wireBand(central, band),
    };
  });
  const finishingIds = new Set([
    ...config.centralFinishing.keys(),
    ...config.branchFinishing.keys(),
  ]);
  const finishingRates = [...finishingIds].map((id) => {
    const central = config.centralFinishing.get(id) ?? null;
    return {
      option_id: id,
      central_syp: central,
      branch_syp: config.branchFinishing.get(id) ?? null,
      band: central === null ? null : wireBand(central, band),
    };
  });

  return {
    branch,
    branches,
    options: options.map((o) => ({
      id: o.id,
      kind: o.kind,
      code: o.code,
      name_ar: o.name_ar,
      name_en: o.name_en,
      sort_order: o.sort_order,
      is_active: o.is_active,
      is_enabled: branchId === null ? null : !config.disabledAtBranch.has(o.id),
    })),
    page_rates: pageRates,
    finishing_rates: finishingRates,
    tiers: config.tiers.map((t) => ({
      min_pages: t.minPages,
      discount_percent: t.discountPercent,
    })),
    settings: {
      branch_band_percent: band,
      file_retention_days: settings.file_retention_days,
      max_file_mb: settings.max_file_mb,
      max_pages: settings.max_pages,
      unpaid_timeout_days: settings.unpaid_timeout_days,
      ready_stale_days: settings.ready_stale_days,
    },
    can_edit_central: canCentral,
    can_edit_branch: branchId !== null && canBranch,
  };
}

function wireBand(central: number, bandPercent: number): { min_syp: number; max_syp: number } {
  const b = bandOf(central, bandPercent);
  return { min_syp: b.minSyp, max_syp: b.maxSyp };
}

// ── الخيارات ────────────────────────────────────────────────────────────────

export async function createOption(
  actor: RequestActorContext,
  input: {
    kind: PrintOptionKind;
    code: string;
    name_ar: string;
    name_en?: string | null;
    sort_order?: number;
  },
): Promise<WirePrintConfig> {
  if (await repo.findOptionByCode(input.kind, input.code)) {
    throw new BusinessError(
      409,
      'An option with this code already exists',
      'print_option_code_taken',
      {
        kind: input.kind,
        code: input.code,
      },
    );
  }
  const row = await repo.insertOption({
    kind: input.kind,
    code: input.code,
    name_ar: input.name_ar,
    name_en: input.name_en ?? null,
    sort_order: input.sort_order ?? 0,
  });
  await recordAudit(actor, PRINTING_AUDIT.optionCreate, printingTarget.option(row.id), null, row);
  return getConfig(actor, null);
}

/**
 * **الرمز والنوع لا يُعدَّلان**: الرمز معرّفٌ يقرؤه الكود (`double` يطبع
 * صفحتين على الورقة)، ونقل خيارٍ من «تجليد» إلى «مقاس» يجعل كل سعرٍ كُتب له
 * يقف في عمود لا يعنيه.
 */
export async function updateOption(
  actor: RequestActorContext,
  id: number,
  input: { name_ar?: string; name_en?: string | null; sort_order?: number; is_active?: boolean },
): Promise<WirePrintConfig> {
  const before = await repo.findOption(id);
  if (!before) throw new NotFoundError('Print option not found');
  const after = await repo.updateOption(id, input);
  await recordAudit(actor, PRINTING_AUDIT.optionUpdate, printingTarget.option(id), before, after);
  return getConfig(actor, null);
}

// ── الأسعار ─────────────────────────────────────────────────────────────────

type PageCellInput = {
  paper_size_id: number;
  color_mode_id: number;
  sides_id: number;
  amount_syp: number | null;
};
type FinishingInput = { option_id: number; amount_syp: number | null };

/** كل معرّف بخلية يجب أن يكون من نوع عموده — معرّف تجليد بعمود المقاس يُسعِّر خلية لا يطلبها أحد. */
async function assertKinds(pageCells: PageCellInput[], finishing: FinishingInput[]): Promise<void> {
  const options = new Map((await repo.findOptions()).map((o) => [o.id, o]));
  const check = (id: number, allowed: PrintOptionKind[]) => {
    const o = options.get(id);
    if (!o)
      throw new BusinessError(422, 'Unknown print option', 'print_option_unknown', {
        option_id: id,
      });
    if (!allowed.includes(o.kind)) {
      throw new BusinessError(
        422,
        `Option ${id} cannot be priced here`,
        'print_option_wrong_kind',
        {
          option_id: id,
          expected_kind: allowed.join('|'),
        },
      );
    }
  };
  for (const c of pageCells) {
    check(c.paper_size_id, [PAGE_KINDS[0]!]);
    check(c.color_mode_id, [PAGE_KINDS[1]!]);
    check(c.sides_id, [PAGE_KINDS[2]!]);
  }
  for (const f of finishing) check(f.option_id, FINISHING_KINDS);
}

export async function setCentralRates(
  actor: RequestActorContext,
  pageCells: PageCellInput[],
  finishing: FinishingInput[],
): Promise<WirePrintConfig> {
  await assertKinds(pageCells, finishing);
  const [beforePages, beforeFinishing] = await Promise.all([
    repo.findPageRates(),
    repo.findFinishingRates(),
  ]);
  await repo.writePageRates(
    pageCells.map((c) => ({
      ...c,
      amount_syp: c.amount_syp === null ? null : money(c.amount_syp),
    })),
    actor.userId,
  );
  await repo.writeFinishingRates(
    finishing.map((f) => ({
      option_id: f.option_id,
      amount_syp: f.amount_syp === null ? null : money(f.amount_syp),
    })),
    actor.userId,
  );
  await recordAudit(
    actor,
    PRINTING_AUDIT.ratesSet,
    printingTarget.config(),
    { page_rates: beforePages, finishing_rates: beforeFinishing },
    { page_rates: pageCells, finishing_rates: finishing },
  );
  return getConfig(actor, null);
}

export async function setTiers(
  actor: RequestActorContext,
  tiers: { min_pages: number; discount_percent: number }[],
): Promise<WirePrintConfig> {
  const problem = tiersProblem(
    tiers.map((t) => ({ minPages: t.min_pages, discountPercent: t.discount_percent })),
  );
  if (problem === 'print_tier_duplicate') {
    throw new BusinessError(422, 'Two tiers start at the same page count', 'print_tier_duplicate');
  }
  if (problem !== null)
    throw new BusinessError(422, 'Invalid quantity tiers', 'print_tier_invalid');
  const before = await repo.findTiers();
  await repo.replaceTiers(
    tiers.map((t) => ({ min_pages: t.min_pages, discount_percent: String(t.discount_percent) })),
  );
  await recordAudit(actor, PRINTING_AUDIT.tiersSet, printingTarget.config(), before, tiers);
  return getConfig(actor, null);
}

export async function setSettings(
  actor: RequestActorContext,
  input: {
    branch_band_percent?: number;
    file_retention_days?: number;
    max_file_mb?: number;
    max_pages?: number;
    unpaid_timeout_days?: number;
    ready_stale_days?: number;
  },
): Promise<WirePrintConfig> {
  const before = await repo.getSettings();
  await repo.updateSettings(
    {
      ...(input.branch_band_percent === undefined
        ? {}
        : { branch_band_percent: String(input.branch_band_percent) }),
      ...(input.file_retention_days === undefined
        ? {}
        : { file_retention_days: input.file_retention_days }),
      ...(input.max_file_mb === undefined ? {} : { max_file_mb: input.max_file_mb }),
      ...(input.max_pages === undefined ? {} : { max_pages: input.max_pages }),
      ...(input.unpaid_timeout_days === undefined
        ? {}
        : { unpaid_timeout_days: input.unpaid_timeout_days }),
      ...(input.ready_stale_days === undefined ? {} : { ready_stale_days: input.ready_stale_days }),
    },
    actor.userId,
  );
  await recordAudit(actor, PRINTING_AUDIT.settingsSet, printingTarget.config(), before, input);
  return getConfig(actor, null);
}

// ── الفرع ───────────────────────────────────────────────────────────────────

/**
 * الحارس بالمسار يعرف أن المفتاح محمولٌ **بمكانٍ ما**، ولا يعرف أيّ فرع يُكتب
 * عليه — فالنطاق يُفحص هنا بالفرع نفسه. مدير فرع المزة لا يُعطّل خيارات فرع
 * حلب.
 */
async function requireBranchScope(actor: RequestActorContext, branchId: number): Promise<void> {
  await requireLiveBranch(branchId);
  if (!(await holdsPermissionAt(actor.userId, BRANCH_SETTINGS_KEY, branchId))) {
    throw new BusinessError(
      403,
      'No printing settings permission at this branch',
      'print_scope_denied',
      { branch_id: branchId },
    );
  }
}

export async function setBranchOptions(
  actor: RequestActorContext,
  branchId: number,
  rows: { option_id: number; is_enabled: boolean }[],
): Promise<WirePrintConfig> {
  await requireBranchScope(actor, branchId);
  const known = new Set((await repo.findOptions()).map((o) => o.id));
  const unknown = rows.find((r) => !known.has(r.option_id));
  if (unknown)
    throw new BusinessError(422, 'Unknown print option', 'print_option_unknown', {
      option_id: unknown.option_id,
    });
  const before = await repo.findDisabledOptionIds(branchId);
  await repo.writeBranchOptions(branchId, rows, actor.userId);
  await recordAudit(
    actor,
    PRINTING_AUDIT.branchOptionsSet,
    printingTarget.branch(branchId),
    { disabled: before },
    rows,
  );
  return getConfig(actor, branchId);
}

/**
 * **سعر الفرع ضمن النطاق حول المركزي** — والرفض يحمل الحدّين، لأن «خارج
 * النطاق» بلا رقمٍ يجعل المحاولة التالية تخميناً. وخليةٌ بلا مركزي لا تقبل
 * سعر فرع: النطاق يُقاس على شيء، وسعرٌ لا مرجع له يصير السعر الوحيد بصمت.
 */
export async function setBranchRates(
  actor: RequestActorContext,
  branchId: number,
  pageCells: PageCellInput[],
  finishing: FinishingInput[],
): Promise<WirePrintConfig> {
  await requireBranchScope(actor, branchId);
  await assertKinds(pageCells, finishing);
  const [{ config }, settings] = await Promise.all([loadConfig(null), repo.getSettings()]);
  const band = num(settings.branch_band_percent);

  const guard = (central: number | undefined, amount: number, where: Record<string, unknown>) => {
    if (central === undefined) {
      throw new BusinessError(409, 'Set a central price first', 'print_rate_no_central', {
        ...where,
      });
    }
    if (!withinBand(central, amount, band)) {
      const b = bandOf(central, band);
      throw new BusinessError(409, 'Outside the allowed branch range', 'print_rate_outside_band', {
        ...where,
        min_syp: b.minSyp,
        max_syp: b.maxSyp,
      });
    }
  };
  for (const c of pageCells) {
    if (c.amount_syp === null) continue;
    guard(
      config.centralPageRates.get(pageRateKey(c.paper_size_id, c.color_mode_id, c.sides_id)),
      c.amount_syp,
      {
        paper_size_id: c.paper_size_id,
        color_mode_id: c.color_mode_id,
        sides_id: c.sides_id,
      },
    );
  }
  for (const f of finishing) {
    if (f.amount_syp === null) continue;
    guard(config.centralFinishing.get(f.option_id), f.amount_syp, { option_id: f.option_id });
  }

  const [beforePages, beforeFinishing] = await Promise.all([
    repo.findBranchPageRates(branchId),
    repo.findBranchFinishingRates(branchId),
  ]);
  await repo.writeBranchRates(
    branchId,
    pageCells.map((c) => ({
      ...c,
      amount_syp: c.amount_syp === null ? null : money(c.amount_syp),
    })),
    finishing.map((f) => ({
      option_id: f.option_id,
      amount_syp: f.amount_syp === null ? null : money(f.amount_syp),
    })),
    actor.userId,
  );
  await recordAudit(
    actor,
    PRINTING_AUDIT.branchRatesSet,
    printingTarget.branch(branchId),
    { page_rates: beforePages, finishing_rates: beforeFinishing },
    { page_rates: pageCells, finishing_rates: finishing },
  );
  return getConfig(actor, branchId);
}
