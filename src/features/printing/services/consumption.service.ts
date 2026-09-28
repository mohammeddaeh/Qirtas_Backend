import { recordAudit } from '../../../core/audit/audit-recorder.js';
import { resolveAvgCostAt } from '../../../core/costing/cost-port.js';
import { db } from '../../../core/db/client.js';
import { BusinessError } from '../../../core/http/api-error.js';
import type { RequestActorContext } from '../../../core/http/require-actor.js';
import { holdsPermissionAt } from '../../../core/http/require-permission.js';
import { postConsumption } from '../../../core/stock/consumption-port.js';
import { PRINTING_AUDIT, printingTarget } from '../audit-actions.js';
import * as repo from '../repositories/consumption.repository.js';
import * as printingRepo from '../repositories/printing.repository.js';
import type { ConsumptionBasis } from '../schemas/print-consumption.schema.js';
import type { PrintJobRow } from '../schemas/print-jobs.schema.js';
import {
  consumptionFor,
  reconcile,
  round9,
  rulesProblem,
  splitPostable,
  type ConsumptionRule,
} from './consumption-rules.js';

/**
 * وصفة الاستهلاك — الشريحة 9-هـ (`printing_system.md` §خطة 9-هـ).
 *
 * الطباعة **بيعٌ واحد يستهلك عدة أصناف**: الورق من عدد الأوراق الذي حسبه
 * الخادم من صفحات الموظف، والحبر تقديرٌ من مردود العلبة **يُصحَّح بالواقع**
 * عند تركيب علبة جديدة، والتجليد لكل نسخة. الخصم عند بدء الطباعة، بمعاملتها.
 */

const SETTINGS_KEY = 'printing.settings';
const STATUS_UPDATE_KEY = 'printing.status.update';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const num = (v: string | null): number | null => (v === null ? null : Number(v));
const money = (v: number): string => v.toFixed(2);

function toRule(r: repo.RuleWithMaterial): ConsumptionRule {
  return {
    optionId: r.option_id,
    variantId: r.variant_id,
    basis: r.basis,
    qty: num(r.qty),
    yieldPages: r.yield_pages,
  };
}

// ── الخصم عند بدء الطباعة ───────────────────────────────────────────────────

/**
 * يخصم مواد الطلب **بمعاملة بدء الطباعة نفسها** ويُرجع تكلفتها. طلبٌ بدأ
 * بلا حركة لورقه يترك الرفّ أعلى من الواقع، وحركةٌ بلا طلب دفترٌ لا يُعاد بناؤه.
 *
 * - **الكسور تتجمّع بعدّاد المادة** ويُرحَّل ما بلغ خطوة المخزون وحده.
 * - **التكلفة من الكمية الدقيقة** لا المرحَّلة: ربح الطلب الحقيقي.
 * - **النقص مسموح** (قرار 2026-09-28): الورق على الرفّ والرقم خاطئ، والرصيد
 *   السالب يظهر بالمخزون تناقضاً يحتاج جرداً.
 */
export async function consumeForJob(tx: Tx, job: PrintJobRow, userId: number): Promise<number> {
  const quote = job.quote as { sheets?: number; printed_pages?: number; copies?: number } | null;
  if (quote === null) return 0;
  const rules = (await repo.findRules(tx)).map(toRule);
  const materials = consumptionFor(
    [job.paper_size_id, job.color_mode_id, job.sides_id, job.binding_id, job.cover_id],
    rules,
    {
      sheets: quote.sheets ?? 0,
      printedPages: quote.printed_pages ?? 0,
      copies: quote.copies ?? job.copies,
    },
  );
  if (materials.length === 0) return 0;

  const costs = await resolveAvgCostAt(
    job.branch_id,
    materials.map((m) => m.variantId),
  );
  const posts: { variantId: number; qtyBase: number }[] = [];
  const lines = [];
  let total = 0;
  for (const m of materials) {
    const meter = await repo.lockMeter(tx, job.branch_id, m.variantId);
    const pending = round9(Number(meter.pending) + m.qty);
    const { post, remaining } = splitPostable(pending);
    await repo.updateMeter(tx, job.branch_id, m.variantId, {
      pending: String(remaining),
      since_install: String(round9(Number(meter.since_install) + m.qty)),
      pages_since_install: meter.pages_since_install + m.yieldPages,
    });
    if (post > 0) posts.push({ variantId: m.variantId, qtyBase: post });
    const unit = costs.get(m.variantId) ?? 0;
    const cost = Math.round(m.qty * unit * 100) / 100;
    total += cost;
    lines.push({
      job_id: job.id,
      variant_id: m.variantId,
      qty: String(m.qty),
      unit_cost_syp: money(unit),
      cost_syp: money(cost),
    });
  }
  await postConsumption({
    exec: tx,
    branchId: job.branch_id,
    lines: posts,
    printJobId: job.id,
    userId,
  });
  await repo.insertJobConsumption(tx, lines);
  return Math.round(total * 100) / 100;
}

export interface WireJobMaterials {
  consumed_at: string;
  cost_syp: number;
  /** سعر الطباعة − تكلفة المواد. `null` لطلبٍ بلا سعر. */
  profit_syp: number | null;
  lines: { variant_id: number; name_ar: string; sku: string; qty: number; cost_syp: number }[];
}

/** ما استهلكه الطلب وربحه — لمن يرى التكلفة وحده (الشاشة تقرّر بـ`canSeeCost`). */
export async function jobMaterials(job: PrintJobRow): Promise<WireJobMaterials | null> {
  if (job.consumed_at === null || job.materials_cost_syp === null) return null;
  const rows = await repo.findJobConsumption(job.id);
  const cost = Number(job.materials_cost_syp);
  const price = num(job.quoted_total_syp);
  return {
    consumed_at: job.consumed_at.toISOString(),
    cost_syp: cost,
    profit_syp: price === null ? null : Math.round((price - cost) * 100) / 100,
    lines: rows.map((r) => ({
      variant_id: r.variant_id,
      name_ar: r.name_ar,
      sku: r.sku,
      qty: Number(r.qty),
      cost_syp: Number(r.cost_syp),
    })),
  };
}

/**
 * التكلفة والربح **لمن يقرّر الأسعار** (افتراض 2026-09-28): الإعداد المركزي،
 * أو إعداد الطباعة بفرع الطلب. موظف الإنتاج يطبع ولا يحتاج هامش المحل.
 */
export async function canSeeCost(userId: number, branchId: number): Promise<boolean> {
  if (await holdsPermissionAt(userId, SETTINGS_KEY, null)) return true;
  return holdsPermissionAt(userId, 'printing.branch_settings', branchId);
}

// ── الوصفة ──────────────────────────────────────────────────────────────────

export interface WireConsumptionRule {
  option_id: number;
  variant_id: number;
  name_ar: string;
  sku: string;
  basis: ConsumptionBasis;
  qty: number | null;
  yield_pages: number | null;
}

export async function getRules(): Promise<WireConsumptionRule[]> {
  return (await repo.findRules()).map((r) => ({
    option_id: r.option_id,
    variant_id: r.variant_id,
    name_ar: r.name_ar,
    sku: r.sku,
    basis: r.basis,
    qty: num(r.qty),
    yield_pages: r.yield_pages,
  }));
}

/**
 * يستبدل الوصفة كاملةً (المركزي) — **ولا يمسّ ما خُصم**: الطلبات السابقة
 * خُصمت بوصفتها يومها، وتكلفتها مجمَّدة عليها.
 */
export async function setRules(
  actor: RequestActorContext,
  rules: {
    option_id: number;
    variant_id: number;
    basis: ConsumptionBasis;
    qty: number | null;
    yield_pages: number | null;
  }[],
): Promise<WireConsumptionRule[]> {
  const problem = rulesProblem(
    rules.map((r) => ({
      optionId: r.option_id,
      variantId: r.variant_id,
      basis: r.basis,
      qty: r.qty,
      yieldPages: r.yield_pages,
    })),
  );
  if (problem !== null) {
    throw new BusinessError(422, 'Invalid consumption rules', 'print_consumption_rule_invalid', {
      problem,
    });
  }
  const options = new Set((await printingRepo.findOptions()).map((o) => o.id));
  const unknownOption = rules.find((r) => !options.has(r.option_id));
  if (unknownOption) {
    throw new BusinessError(422, 'Unknown print option', 'print_option_unknown', {
      option_id: unknownOption.option_id,
    });
  }
  const known = new Set(
    await repo.findExistingVariantIds([...new Set(rules.map((r) => r.variant_id))]),
  );
  const unknownVariant = rules.find((r) => !known.has(r.variant_id));
  if (unknownVariant) {
    throw new BusinessError(422, 'Unknown material', 'print_consumption_material_unknown', {
      variant_id: unknownVariant.variant_id,
    });
  }
  const before = await getRules();
  await repo.replaceRules(
    rules.map((r) => ({
      option_id: r.option_id,
      variant_id: r.variant_id,
      basis: r.basis,
      qty: r.qty === null ? null : String(r.qty),
      yield_pages: r.yield_pages,
    })),
    actor.userId,
  );
  await recordAudit(
    actor,
    PRINTING_AUDIT.consumptionRulesSet,
    printingTarget.config(),
    before,
    rules,
  );
  return getRules();
}

// ── المواد بالمردود: «ركّبت علبة جديدة» ─────────────────────────────────────

export interface WireConsumable {
  variant_id: number;
  name_ar: string;
  sku: string;
  /** `null` = لم يُسجَّل تركيبٌ بعد؛ أول «علبة جديدة» خطُّ بداية. */
  installed_at: string | null;
  pages_since_install: number;
  estimated_since_install: number;
  /** ما سيُرحَّل لو رُكِّبت علبةٌ الآن (علبة واحدة) — **يُقال قبل التأكيد**. */
  correction_if_installed_now: number | null;
}

async function requireBranchScope(actor: RequestActorContext, branchId: number): Promise<void> {
  if (!(await holdsPermissionAt(actor.userId, STATUS_UPDATE_KEY, branchId))) {
    throw new BusinessError(403, 'No printing permission at this branch', 'print_scope_denied', {
      branch_id: branchId,
    });
  }
}

export async function listConsumables(
  actor: RequestActorContext,
  branchId: number,
): Promise<WireConsumable[]> {
  await requireBranchScope(actor, branchId);
  const rows = await repo.findYieldMeters(branchId);
  return rows.map((r) => {
    const meter = r.meter;
    const since = meter ? Number(meter.since_install) : 0;
    const pending = meter ? Number(meter.pending) : 0;
    const pages = meter?.pages_since_install ?? 0;
    return {
      variant_id: r.variant_id,
      name_ar: r.name_ar,
      sku: r.sku,
      installed_at: meter?.installed_at?.toISOString() ?? null,
      pages_since_install: pages,
      estimated_since_install: since,
      correction_if_installed_now: meter?.installed_at
        ? reconcile({ sinceInstall: since, pending, pagesSinceInstall: pages, actual: 1 })
            .correction
        : null,
    };
  });
}

export interface WireReconciliation {
  baseline: boolean;
  estimated: number;
  actual: number;
  correction: number;
  pages: number;
  suggested_yield_pages: number | null;
}

/**
 * «ركّبت علبة جديدة» — ما رُحِّل منذ آخر تركيب يُقارَن بما استُهلك فعلاً
 * (`actual`، علبة واحدة افتراضاً) والفرق يُرحَّل تسويةً، ويُصفَّر العدّاد.
 * **أول تركيبٍ يُسجَّل خطُّ بداية** لا تسوية: ما قبله لا يُعرف متى بدأ.
 */
export async function installConsumable(
  actor: RequestActorContext,
  variantId: number,
  input: { branch_id: number; actual?: number },
): Promise<WireReconciliation> {
  await requireBranchScope(actor, input.branch_id);
  if (!(await repo.isYieldMaterial(variantId))) {
    throw new BusinessError(
      422,
      'This material is not tracked by yield',
      'print_consumable_not_tracked',
      {
        variant_id: variantId,
      },
    );
  }
  const actual = input.actual ?? 1;
  const result = await db.transaction(async (tx) => {
    const meter = await repo.lockMeter(tx, input.branch_id, variantId);
    const since = Number(meter.since_install);
    const pending = Number(meter.pending);
    const pages = meter.pages_since_install;
    const baseline = meter.installed_at === null;
    const r = baseline
      ? { correction: 0, suggestedYieldPages: null }
      : reconcile({ sinceInstall: since, pending, pagesSinceInstall: pages, actual });
    if (!baseline) {
      await postConsumption({
        exec: tx,
        branchId: input.branch_id,
        lines: [{ variantId, qtyBase: r.correction, note: 'تسوية تركيب علبة جديدة' }],
        printJobId: null,
        userId: actor.userId,
      });
    }
    // خطّ البداية يُبقي المعلَّق معلَّقاً: لم يُرحَّل بعد، وسيُرحَّل مع ما يليه.
    await repo.updateMeter(tx, input.branch_id, variantId, {
      pending: baseline ? String(pending) : '0',
      since_install: baseline ? String(pending) : '0',
      pages_since_install: 0,
      installed_at: new Date(),
    });
    await repo.insertReconciliation(tx, {
      branch_id: input.branch_id,
      variant_id: variantId,
      baseline,
      estimated: String(since),
      actual: String(actual),
      correction: String(r.correction),
      pages,
      suggested_yield_pages: r.suggestedYieldPages,
      created_by: actor.userId,
    });
    return {
      baseline,
      estimated: since,
      actual,
      correction: r.correction,
      pages,
      suggested_yield_pages: r.suggestedYieldPages,
    };
  });
  await recordAudit(
    actor,
    PRINTING_AUDIT.consumableInstall,
    printingTarget.branch(input.branch_id),
    null,
    {
      variant_id: variantId,
      ...result,
    },
  );
  return result;
}

export interface WireMaterial {
  variant_id: number;
  name_ar: string;
  sku: string;
  /** وحدة الأساس — كمية الوصفة تُكتب بها. */
  unit_name_ar: string;
}

/** منتقي مادة الوصفة — بلا حاجة لمفتاح الكتالوج أو المخزون عند من يُعدّ الطباعة. */
export async function searchMaterials(search: string): Promise<WireMaterial[]> {
  return repo.searchMaterials(search, 25);
}
