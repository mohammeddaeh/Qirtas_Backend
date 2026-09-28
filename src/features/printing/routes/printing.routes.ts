import { Router } from 'express';
import { asyncHandler } from '../../../core/http/async-handler.js';
import { requireAnyPermission, requirePermission } from '../../../core/http/require-permission.js';
import { publicRoute } from '../../../core/http/route-marker.js';
import { validate } from '../../../core/validation/validate.js';
import { idParamsSchema } from '../../catalog/dtos/common.dto.js';
import {
  branchOptionsBodySchema,
  branchParamsSchema,
  branchQuerySchema,
  configQuerySchema,
  createOptionBodySchema,
  quoteBodySchema,
  ratesBodySchema,
  settingsBodySchema,
  tiersBodySchema,
  updateOptionBodySchema,
} from '../dtos/printing.dto.js';
import * as controller from '../controllers/printing.controller.js';
import * as consumption from '../controllers/consumption.controller.js';
import {
  consumableParamsSchema,
  consumablesQuerySchema,
  installBodySchema,
  materialsQuerySchema,
  rulesBodySchema,
} from '../dtos/consumption.dto.js';
import { BRANCH_SETTINGS_KEY, SETTINGS_KEY } from '../services/printing.service.js';

/**
 * `/api/v1/printing/*` — إعداد الطباعة وتسعيرها (الشريحة 9-أ).
 *
 * **مساران عامّان**: ما يطبعه الفرع وكم يكلّف. الزبون يرى السعر **قبل** أن
 * يدخل أو يرسل ملفاً — كالمتجر تماماً (§25): السعر معلومة، والبوابة حيث يتحرّك
 * المال والملف.
 *
 * **ومفتاحان للإعداد لا واحد**: الجدول المركزي ونطاقه قرارٌ يحرّك كل فرع
 * (`printing.settings`)، وما يطبعه فرعٌ بعينه وسعره ضمن النطاق قرار مديره
 * (`printing.branch_settings`، والنطاق يُفحص بالفرع نفسه داخل الخدمة).
 */
export const printingRouter: Router = Router();

const canSetCentral = () =>
  requirePermission(SETTINGS_KEY, {
    display: { ar: 'إعداد الطباعة وأسعارها المركزية', en: 'Printing Setup & Central Prices' },
    sensitive: true,
  });

const canSetBranch = () =>
  requirePermission(BRANCH_SETTINGS_KEY, {
    display: { ar: 'خيارات الطباعة وأسعارها بالفرع', en: 'Branch Printing Options & Prices' },
  });

printingRouter.get(
  '/offer',
  publicRoute,
  validate(branchQuerySchema, 'query'),
  asyncHandler(controller.offer),
);

printingRouter.post(
  '/quote',
  publicRoute,
  validate(quoteBodySchema, 'body'),
  asyncHandler(controller.quote),
);

printingRouter.get(
  '/config',
  requireAnyPermission([SETTINGS_KEY, BRANCH_SETTINGS_KEY]),
  validate(configQuerySchema, 'query'),
  asyncHandler(controller.getConfig),
);

printingRouter.post(
  '/options',
  canSetCentral(),
  validate(createOptionBodySchema, 'body'),
  asyncHandler(controller.createOption),
);

printingRouter.patch(
  '/options/:id',
  canSetCentral(),
  validate(idParamsSchema, 'params'),
  validate(updateOptionBodySchema, 'body'),
  asyncHandler(controller.updateOption),
);

printingRouter.put(
  '/rates',
  canSetCentral(),
  validate(ratesBodySchema, 'body'),
  asyncHandler(controller.setRates),
);

printingRouter.put(
  '/tiers',
  canSetCentral(),
  validate(tiersBodySchema, 'body'),
  asyncHandler(controller.setTiers),
);

printingRouter.patch(
  '/settings',
  canSetCentral(),
  validate(settingsBodySchema, 'body'),
  asyncHandler(controller.setSettings),
);

printingRouter.put(
  '/branches/:branchId/options',
  canSetBranch(),
  validate(branchParamsSchema, 'params'),
  validate(branchOptionsBodySchema, 'body'),
  asyncHandler(controller.setBranchOptions),
);

printingRouter.put(
  '/branches/:branchId/rates',
  canSetBranch(),
  validate(branchParamsSchema, 'params'),
  validate(ratesBodySchema, 'body'),
  asyncHandler(controller.setBranchRates),
);

// ── وصفة الاستهلاك (9-هـ، §31) ─────────────────────────────────────────────

/** قراءة الوصفة بأيّ مفتاحَي الإعداد — مدير الفرع يرى ما يُخصم من رفوفه. */
printingRouter.get(
  '/consumption-rules',
  requireAnyPermission([SETTINGS_KEY, BRANCH_SETTINGS_KEY]),
  asyncHandler(consumption.getRules),
);

/** الوصفة **مركزية** (المادة واحدة بكل الفروع) — كتابتها بمفتاح الإعداد المركزي. */
printingRouter.put(
  '/consumption-rules',
  canSetCentral(),
  validate(rulesBodySchema, 'body'),
  asyncHandler(consumption.setRules),
);

/**
 * المواد بالمردود (الحبر) بفرعٍ وعدّاداتها — ومعها ما سيُسوّى لو رُكِّبت علبة
 * الآن. **بمفتاح تحريك مراحل الطباعة** (من يركّب العلبة هو من يطبع)، والنطاق
 * بالفرع يُفحص بالخدمة.
 */
const canRunPrinters = () =>
  requirePermission('printing.status.update', {
    display: { ar: 'تحديث حالة الطباعة', en: 'Update Printing Status' },
  });

printingRouter.get(
  '/consumables',
  canRunPrinters(),
  validate(consumablesQuerySchema, 'query'),
  asyncHandler(consumption.listConsumables),
);

/** «ركّبت علبة جديدة» — المقدَّر يُقارَن بالواقع، والفرق يُرحَّل تسويةً. */
printingRouter.post(
  '/consumables/:variantId/install',
  canRunPrinters(),
  validate(consumableParamsSchema, 'params'),
  validate(installBodySchema, 'body'),
  asyncHandler(consumption.install),
);

/** منتقي مادة الوصفة — لمن يكتبها (الإعداد المركزي). */
printingRouter.get(
  '/materials',
  canSetCentral(),
  validate(materialsQuerySchema, 'query'),
  asyncHandler(consumption.searchMaterials),
);
