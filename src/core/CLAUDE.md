# src/core/CLAUDE.md — Shared Infrastructure Rules

> جزء من [../../CLAUDE.md](../../CLAUDE.md). قواعد إلزامية لأي كود بـ`src/core/`.

---

## قواعد صارمة

- **`status` بالـresponse دايماً `boolean`** — أبداً string `"success"`/`"error"`. هذا مطابق حرفياً لكود `/login` الفعلي بالفرونت (`auth_remote_datasource.dart`) الذي يقرأ `status` كـbool صراحة. أي تغيير هنا يكسر الفرونت.
- **كل خطأ يمر عبر `middleware/error-handler.ts`** — الـcontrollers/services **لا تبني** جسم خطأ يدوياً (`res.status(x).json(...)`) إطلاقاً. ترمي `ApiError` (أو subclass من `http/api-error.ts`) وخلاص.
- **الـservices ترمي `ApiError` subclasses فقط** — لا `throw new Error(...)` عادي داخل service/controller (يوصل كـ500 عام بدل رسالة/status صحيحة).
- **كل جدول DB جديد يُصدَّر بـ`db/schema.ts` (barrel)** — drizzle-kit يقرأ هذا الملف فقط لاكتشاف الجداول.
- **`db` singleton واحد فقط** (`core/db/client.ts`) — لا `new Pool()`/`drizzle()` إضافية بأي مكان ثاني، ولا pool لكل طلب.
- **Config فقط عبر `core/config/env.ts`** — لا `process.env.X` مباشر بأي ملف آخر؛ إذا احتجت متغير بيئة جديد أضفه لـ`envSchema` هناك.

---

## §DB — Drizzle + PostgreSQL

- `drizzle.config.ts` (بالجذر) يقرأ `src/core/db/schema.ts` كـ`schema` و`./drizzle` كـ`out`.
- ⚠️ **شغّل drizzle-kit دائماً عبر الـscripts بـ`package.json`** (`npm run db:generate`/`db:migrate`/`db:push`/`db:studio`) — **لا** `npx drizzle-kit ...` مباشرة. السبب: drizzle-kit يستخدم CJS loader داخلي لا يحل امتدادات `.js` بالـimports النسبية (مطلوبة بكل مكان آخر بسبب `moduleResolution: Node16`)؛ تشغيله عبر `tsx` (كما بالـscripts) يحل هذا التعارض دون استثناءات بالكود نفسه.
- Workflow: عدّل/أضف `*.schema.ts` بمجلد الفيتشر → صدّره بـ`db/schema.ts` → `npm run db:generate` (يولّد SQL بـ`drizzle/`, يُلتزم بالـGit) → `npm run db:migrate` (يطبّق فعلياً على القاعدة).
- `npm run db:push` **للتطوير السريع المحلي فقط** — لا يُستخدم كمصدر حقيقة، الـmigrations هي المصدر الرسمي.

---

## §CRUD — قواعد موحّدة للعمليات الأساسية

> التفصيل الكامل (كيف يبدو كل route فعلياً طبقة بطبقة) بـ[../features/CLAUDE.md](../features/CLAUDE.md) §قواعد CRUD الموحّدة. هنا الأساس المشترك بالكود فقط.

- `db/crud-helpers.ts`: `findManyPaginated(table, params)` و`findOneById(table, table.id, id)` — **الاستخدام الإلزامي** لكل `list`/`getById` repository بكل feature. فُحص فعلياً إن التنفيذ القديم (Promise.all يدوي بكل ملف) والهيلبر بينتجوا نفس الاستعلام حرفياً — لا فرق سلوكي، فرق تكرار كود بس.
- **`options.orderBy` إلزامي لكل `findManyPaginated` جديد** — بدونه لا يصدر أي `ORDER BY` فيرجع الترتيب الفيزيائي غير المضمون من PostgreSQL (غير مستقر، قد يتغيّر بين طلبين). الافتراضي القياسي `desc(table.created_at)` (الأحدث أولاً) ما لم يطلب الموديول ترتيباً آخر صراحةً — هذا ما يسمح لـ`prependItem()` بالفرونت (`Features/CLAUDE.md` §CRUD-PATTERNS) بإدراج العنصر الجديد بأول القائمة محلياً بثقة أنه يطابق ما سيُرجعه الخادم عند أي `refresh()`/سحب-للتحديث لاحق. مثال: `roles.repository.ts`/`branches.repository.ts`/`users.repository.ts`.
- **الفلترة/الترتيب الاختياريان لكل list endpoint** — التفصيل الكامل بـ[../../docs/rest_api.md](../../docs/rest_api.md) §6.1. خلاصة: كل موديول list يعرّف `{module}FilterQuerySchema` خاص به بملف `dtos/{module}.dto.ts` (`.strict()` إلزامي — يرفض أي براميتر غير معرَّف بـ422)، يُدمَج مع `paginationQuerySchema` بـ`.merge()` عند الـroute، والـrepository يبني `where`/`orderBy` ديناميكياً من الفلتر بدل تمرير قيمة ثابتة. الأساس يبقى "جلب الكل بلا فلترة" — لا فرق بالسلوك لأي طلب لا يمرّر هذه البراميترات. مطبَّق حالياً على `branches`/`roles`/`users` — القاعدة تُعمَّم على أي list endpoint جديد من v1.
- **الباقي (findByName, countActive, replacePermissions, ...) يبقى يدوي بالكامل** — التوحيد يقتصر فقط على الجزء المتطابق حرفياً بين كل الموديولات (List وGetById)؛ أي استعلام خاص بمنطق موديول معيّن **لا** يُجبَر على قالب عام.
- **Delete = تعطيل دائماً، لا Hard Delete افتراضيًا** — `is_active=false` أو `status='disabled'` حسب الجدول، أبدًا `DELETE FROM`. الاستثناء الوحيد (كيان بدون أي نشاط تاريخي) قرار صريح بالـservice، مش نمط عام.
- **Route لتعطيل كيان دايمًا `POST /:id/deactivate`** (فعل صريح)، مش `DELETE /:id` — يعكس إنها عملية تغيير حالة، مش حذف فعلي.

---

## §HTTP

- `http/response.ts`: `ok()`/`created()`/`noContentOk()` — الاستخدام الوحيد المسموح لبناء نجاح.
- `http/api-error.ts`: `ApiError` + subclasses (`NotFoundError`, `UnauthorizedError`, `ForbiddenError`, `ValidationError`, `ConflictError`, `RateLimitError`, `BusinessError`) — الاستخدام الوحيد المسموح لبناء خطأ.
- **رسائل خطأ مترجمة (`ar`/`en`)**: `ApiError` تدعم `messageKey` اختياري (مدعوم حالياً على `UnauthorizedError`/`ForbiddenError`) — يُترجَم بـ`error-handler.ts` عبر `core/i18n/messages.ts` حسب `req.lang` (من `middleware/request-context.ts`). أضف key جديد فقط لخطأ يقرأه مستخدم حقيقي فعلاً (مو أخطاء داخلية/logs) — التفاصيل والقاعدة الكاملة بـ`docs/rest_api.md` §2.
- `http/async-handler.ts`: لف أي controller async بـ`asyncHandler(...)` بالـroutes — بدونها أي `throw` داخل async function ما توصل لـ`error-handler.ts`.

### 🔑 كل مسار يجب أن يُصنِّف نفسه — `npm run check:permissions`

`http/route-marker.ts`: كل مسار تحت `/api/v1` يُعلن أحد ثلاثة — `requirePermission('<key>')` أو `requireAuth` أو **`publicRoute`** (لا تفعل شيئاً سوى `next()`؛ وظيفتها الوحيدة أن تكون **تصريحاً موجباً** مكان غيابٍ صامت). مسار بلا تصنيف يُفشل الفحص.

**لماذا؟** حارسٌ منسيّ يبدو تماماً كـendpoint عام مقصود، ولا مراجعٌ ولا `tsc` ولا eslint يفرّق بينهما — وقرطاس تجاوز ٧٠ مساراً على عشرة routers.

والفحص يقارن ثلاثة أشياء لم يكن شيء يقارنها:

| الفحص | عند الكسر |
|---|---|
| كل مسار مصنَّف | ❌ فشل |
| كل مفتاح **يفرضه** مسار موجودٌ بكتالوج البذرة | ❌ فشل — وإلا فالـendpoint مغلق لكل مستخدم **بمن فيهم السوبر أدمن**، بصمت |
| كل مفتاح **مبذور** يفرضه مسار | ⚠️ تحذير بالأسماء |

> أول تشغيل (2026-08-13) كشف **١٧ مفتاحاً مبذوراً لا يفرضه أي مسار** — تظهر بشاشة الأدوار، تُمنَح، ولا تحكم شيئاً. مقبولة ما دامت وحداتها قيد البناء (`orders.*` · `printing.*` · `inventory.*` · `reports.*`)، ومرفوضة كوضع دائم.

`core/authz/registry.ts` يجمع المفاتيح من `requirePermission` نفسها لحظة الإقلاع — لا قائمة تُكتب يدوياً فلا قائمة تتقادم. **وهو لا يستبدل جدول `permissions`**: الجدول يحمل `module` و`is_sensitive` وأسماء العرض التي ترسمها شاشة الأدوار، والـregistry يجيب سؤالاً أضيق لا يستطيعه الجدول — *أي المفاتيح يفرضها الكود الآن؟*

`core/authz/key-grammar.ts`: `module.action` بمقطعين فأكثر — المتداخل مقبول لأن قرطاس يستعمل تسعة منه (`orders.delivery.update` · `reports.financial.view`).

**عند إضافة مسار جديد**: صنّفه، وإن كان محروساً فأضف مفتاحه إلى `PERMISSIONS` بـ`core/db/seed-core.ts`، ثم `npm run check:permissions`.

## §Validation

- `validation/validate.ts` + **zod** فقط. `validate(schema, 'body'|'query'|'params')` كـmiddleware قبل الـcontroller — يرمي `ValidationError(422)` بشكل Laravel (`errors: {field: [msgs]}`) تلقائياً عند الفشل، ويستبدل `req[source]` بالقيمة المُحقّقة/المُحوَّلة (فيدة: query params تصير أرقام حقيقية بعد التحقق).
- **رقم الهاتف/التواصل — قاعدة صارمة إلزامية (لا استثناء)**: أي حقل يمثّل رقم هاتف أو رقم تواصل (`phone`, `contact_info`, أو أي اسم مشابه بأي DTO مستقبلي) **يجب** استخدام `syrianPhoneSchema`/`optionalSyrianPhoneSchema`/`nullableSyrianPhoneSchema` من `core/validation/common-schemas.ts` — **ممنوع مطلقاً** `z.string()` بحد أقصى طول فقط بلا تنسيق (`z.string().max(N)`). القاعدة: 10 أرقام بالضبط، تبدأ بـ`09` (سوريا). اكتُشفت هذه الثغرة فعلياً حين قبل `branches.contact_info` القيمة `"تر"` كرقم تواصل صالح — لا تحقق تنسيق كان موجوداً بتاتاً. مطابق حرفياً لـ`CustomRegex.syrianPhoneRegex` بالفرونت (`qirtas_app/lib/core/foundation/utils/validators.dart`) — أي تعديل بالقاعدة يجب أن يطابَق بالطرفين بنفس التغيير.

- **منطقي بالاستعلام — قاعدة صارمة إلزامية**: أي `boolean` يصل عبر query string **يجب** أن يستخدم `queryBooleanSchema` من `core/validation/common-schemas.ts` — **ممنوع مطلقاً** `z.coerce.boolean()`. السبب أن الـcoercion يطبّق `Boolean()` من جافاسكربت و**كل نص غير فارغ صادق**، فـ`Boolean('false') === true`: الفلتر لا يفشل ولا يحذّر، بل يُرجع **العكس التام** بصمت. حدث فعلياً بخمسة فلاتر معاً (`roles.is_active`، `roles.assignable`، `users.is_admin`، `users.unassigned`، `branches.is_default`) واكتُشف بتحقّق حيّ لا بمراجعة كود — `GET /roles?is_active=false` أرجع كل الأدوار الفعّالة. لاحظ الفرق: `z.coerce.number()` **آمن** لأنه يفشل على نص غير رقمي؛ خطر المنطقيات أنه لا يفشل أبداً.

## §Pagination

- `pagination/pagination.ts`: `paginationQuerySchema` (للتحقق) + `toPaginationParams()` + `paginated()`.
- شكل الرد: `{items, page, limit, total, total_pages}` — راجع `docs/rest_api.md` لماذا هذا الاختيار تحديداً (لا يوجد عقد فعلي بالفرونت بعد، هذا هو العقد المرجعي الأول).

## §OpenAPI (توثيق تفاعلي مولّد تلقائياً)

- `openapi/registry.ts`: الـ`OpenAPIRegistry` المشترك + هيلبرز (`successEnvelope`, `errorEnvelope`, `paginatedSchema`, `commonErrorResponses`, `unauthorizedResponse`) بيستخدمهم كل ملف `*.openapi.ts`.
- `openapi/document.ts`: بيستورد كل ملفات `*.openapi.ts` (side-effect imports لتسجيل الـpaths) ويولّد المستند النهائي عبر `OpenApiGeneratorV3`.
- **كل feature بيحط ملف `<name>.openapi.ts` بجذر مجلده** (مش جوه أي subfolder) بيسجّل الـpaths بتاعته بـ`registry.registerPath(...)` — لازم يستورد نفس الـzod schemas الموجودة فعلاً بـ`dtos/*.dto.ts`، **ممنوع تكرار تعريف request schemas** (الـrequest schemas الموجودة أصلاً بـvalidate() تُستخدم كما هي).
- **الاستثناء الوحيد المسموح للتكرار**: shapes الـresponse (`Wire<X>`) هي TS interfaces عادية مش zod schemas — `zod-to-openapi` محتاج zod تحديداً، فبيتحط بجانبها (بنفس ملف الـdto) نسخة zod موازية باسم `<x>ResponseSchema` (مثال: `userResponseSchema` بجانب `WireUser`/`toWireUser` بـ`users.dto.ts`). **لازم يتحدّثوا مع بعض دايماً** لو أي حقل اتغيّر بالـWire type.
- **checklist عند إضافة feature جديدة**: (1) أضف `<x>ResponseSchema` بجانب كل `Wire<X>` بملفات الـdto، (2) أنشئ `<name>.openapi.ts` يسجّل كل route بنفس الـmethod/path الموجودين فعلياً بـ`routes/*.routes.ts`، (3) أضف سطر `import '../../features/<name>/<name>.openapi.js';` بـ`openapi/document.ts`.
- الوصول: `GET /docs` (Swagger UI تفاعلي) و`GET /openapi.json` (المستند الخام) — مُسجَّلان بـ`app.ts` قبل أي `/api/v1/*` router.
