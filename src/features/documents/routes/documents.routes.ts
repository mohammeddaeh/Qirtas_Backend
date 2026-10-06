import { Router } from 'express';
import { asyncHandler } from '../../../core/http/async-handler.js';
import { requireAnyPermission, requirePermission } from '../../../core/http/require-permission.js';
import { uploadImageFile } from '../../../core/media/middleware/upload-image.js';
import { validate } from '../../../core/validation/validate.js';
import { idParamsSchema } from '../../catalog/dtos/common.dto.js';
import {
  contextQuerySchema,
  createTemplateBodySchema,
  labelsBodySchema,
  profileBodySchema,
  templatesQuerySchema,
  updateTemplateBodySchema,
} from '../dtos/documents.dto.js';
import * as controller from '../controllers/documents.controller.js';
import { TEMPLATES_KEY } from '../services/documents.service.js';

/**
 * `/api/v1/documents/*` — الفواتير والملصقات (`docs/reference/receipts_labels.md`).
 *
 * **التصميم بمفتاح، والقراءة بمفتاح من يطبع**: الكاشير يقرأ القالب ليطبع
 * فاتورته (`sales.sell` · `sales.refund`)، وموظف المخزون ليطبع ملصقاً
 * (`barcodes.print`) — ولا يملك أيٌّ منهما تغيير شكل ما يُطبع باسم المحل.
 * مفتاحٌ واحد للقراءة والكتابة كان سيعطي كل كاشير محرّر القوالب.
 */
export const documentsRouter: Router = Router();

const canDesign = () =>
  requirePermission(TEMPLATES_KEY, {
    display: { ar: 'تصميم الفواتير والملصقات', en: 'Design Receipts & Labels' },
  });

// الأسماء تُعلَن حيث أُعلنت أولاً (موديولاتها) — إعلانها هنا باسم آخر يجعل
// الصلاحية الواحدة تُقرأ صلاحيتين بشاشة الأدوار.
const canRead = () =>
  requireAnyPermission([TEMPLATES_KEY, 'sales.sell', 'sales.refund', 'barcodes.print']);

documentsRouter.get(
  '/context',
  canRead(),
  validate(contextQuerySchema, 'query'),
  asyncHandler(controller.context),
);

documentsRouter.get(
  '/templates',
  canRead(),
  validate(templatesQuerySchema, 'query'),
  asyncHandler(controller.listTemplates),
);

documentsRouter.get(
  '/templates/:id',
  canRead(),
  validate(idParamsSchema, 'params'),
  asyncHandler(controller.getTemplate),
);

documentsRouter.post(
  '/templates',
  canDesign(),
  validate(createTemplateBodySchema, 'body'),
  asyncHandler(controller.createTemplate),
);

documentsRouter.patch(
  '/templates/:id',
  canDesign(),
  validate(idParamsSchema, 'params'),
  validate(updateTemplateBodySchema, 'body'),
  asyncHandler(controller.updateTemplate),
);

documentsRouter.post(
  '/templates/:id/default',
  canDesign(),
  validate(idParamsSchema, 'params'),
  asyncHandler(controller.setDefault),
);

documentsRouter.delete(
  '/templates/:id',
  canDesign(),
  validate(idParamsSchema, 'params'),
  asyncHandler(controller.deleteTemplate),
);

documentsRouter.get('/profile', canRead(), asyncHandler(controller.getProfile));

documentsRouter.put(
  '/profile',
  canDesign(),
  validate(profileBodySchema, 'body'),
  asyncHandler(controller.updateProfile),
);

// الشعار يُرفع هنا لا بمسار الكتالوج: مصمّم الفاتورة لا يملك `catalog.edit`.
documentsRouter.post('/logo', canDesign(), uploadImageFile, asyncHandler(controller.uploadLogo));

documentsRouter.get('/label-branches', requirePermission('barcodes.print'), asyncHandler(controller.labelBranches));

documentsRouter.post(
  '/labels',
  requirePermission('barcodes.print'),
  validate(labelsBodySchema, 'body'),
  asyncHandler(controller.labels),
);
