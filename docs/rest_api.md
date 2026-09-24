# REST API Contract — المرجع الوحيد

> هذا الملف هو **المرجع الوحيد** لعقد الـREST بين هذا الباك وتطبيق Flutter (`../../qirtas_app`). أي تغيير على envelope/error/pagination/endpoint يُحدَّث هنا فوراً — راجع "Mandatory Documentation Sync" بـ[../CLAUDE.md](../CLAUDE.md).

> 📖 **توثيق تفاعلي مولّد تلقائياً**: شغّل السيرفر (`npm run dev`) وافتح `http://localhost:3000/docs` — Swagger UI يعرض كل endpoint مع الـ request/response الفعلي، مولّد من نفس zod schemas المستخدمة بـ`validate()` وقت التشغيل (`src/core/openapi/`). الملف الخام: `http://localhost:3000/openapi.json` (قابل للاستيراد بـPostman/Insomnia). هذا الملف (`rest_api.md`) يبقى المرجع النصي/المعماري الأشمل، والـSwagger UI هو المرجع التفاعلي السريع للتجربة اليدوية.

---

## 1. Success Envelope

كل رد ناجح بنفس الشكل — `status` **boolean** حتماً (مو string):

```json
{ "status": true, "message": "OK", "data": {} }
```

مصدر الالتزام: كود `/login` الفعلي بالفرونت (`auth_remote_datasource.dart`) يقرأ `status` كـbool صراحة، متجاوزاً الـfromJson العام. أي endpoint بهذا الباك يرسل `"status": "success"` (string) **يكسر الفرونت**.

## 2. Error Envelope

```json
{ "status": false, "message": "Invalid credentials", "code": 400 }
```

**حقل `data` اختياري** (2026-07-23) — حمولة إضافية قابلة للقراءة برمجياً، تُستخدم عندما لا يكفي نص `message` الحر لتمييز السبب الدقيق للخطأ (مثال: `POST /login` §Endpoints أدناه، حيث 4 أسباب رفض مختلفة تشترك بنفس كود 403). المصدر: `ApiError.data` (`src/core/http/api-error.ts`) — أي service يريد إرفاق حمولة يمررها لـ constructor الخطأ المناسب (حالياً مدعوم على `ForbiddenError` فقط، يُوسَّع لبقية الأنواع عند الحاجة الفعلية).

**`message` مُترجَم حسب `Accept-language`** (2026-07-26) — الفرونت يرسل `Accept-language: ar|en` بكل طلب (`request-context.ts` يقرأه إلى `req.lang`, افتراضي `ar`). بعض أخطاء `/login` (بيانات دخول خاطئة، `pending_approval`/`suspended`/`disabled`) تحمل الآن `messageKey` اختياري (`ApiError.messageKey`، `src/core/http/api-error.ts`) يُترجمه `error-handler.ts` عبر قاموس صغير `src/core/i18n/messages.ts` حسب `req.lang` قبل بناء الـenvelope. هذا **ليس** مكتبة i18n عامة — مجرد `Record<key, {ar, en}>` لأخطاء يقرأها مستخدم حقيقي فعلاً (بالأخص تدفق تسجيل الدخول)؛ أي خطأ بدون `messageKey` يبقى كما هو (نص إنجليزي ثابت من `message`). حالة `rejected` تبقى استثناءً متعمَّداً (`data.rejection_reason` نص حر كتبه الأدمن، لا يُترجَم).

## 3. Validation Errors (422)

الشكل المفضّل الذي يفحصه الفرونت **أولاً** (`server_message_extractor.dart`) — نمط Laravel:

```json
{
  "status": false,
  "message": "Validation failed",
  "code": 422,
  "errors": { "email": ["Invalid email"] }
}
```

ترتيب فحص الفرونت للرسالة عند الخطأ: `errors.field[]` → `message` → `error.message` → `error` (string). هذا الباك يلتزم بالشكل الأول دائماً عبر `ValidationError` (`src/core/http/api-error.ts`).

**ومخالفة `.strict()` تُسمّى بمفتاح المصدر** (`query` · `body` · `params`، منذ 2026-09-23):

```json
{ "status": false, "message": "Validation failed", "code": 422,
  "errors": { "query": ["Unrecognized key(s) in object: 'branch_id'"] } }
```

zod يضع مشاكل الكائن كلّه بـ`formErrors` لا `fieldErrors`، وكان `validate()` يرسل الثاني وحده — فأي مفتاح استعلام غير معرَّف يعود **`errors: {}`**: رفضٌ بلا سببه، على الشاشة وبالسجلّ معاً. كلّف جلسة تصحيح حيّة على `GET /inventory/receipts?branch_id=…`. مثبَّت بـ`src/core/validation/__tests__/validate.test.ts`.

## 4. HTTP Status Code Mapping

| Status    | المعنى                 | ملاحظة                                                                               |
| --------- | ---------------------- | ------------------------------------------------------------------------------------ |
| 200       | نجاح                   | `ok()`                                                                               |
| 201       | إنشاء ناجح             | `created()`                                                                          |
| 401 / 403 | Unauthorized/Forbidden | 401 = لا يوجد توكن صالح (`requireAuth`/`requireActorId`) أو بيانات دخول خاطئة بـ`/login`. 403 = توكن صالح لكن بدون الصلاحية المطلوبة (`requirePermission`) |
| 404       | غير موجود              | `NotFoundError`                                                                      |
| 408       | Timeout                | غير مستخدم بأي endpoint حالياً                                                       |
| 409       | Conflict               | **محجوز** لميزة sync مستقبلية — انظر §5                                              |
| 422       | Validation             | `ValidationError`، دائماً مع `errors`                                                |
| 429       | Rate limit             | `RateLimitError`، يضبط header `Retry-After` (ثواني) — **مفعّل حالياً فقط على `POST /login`** (`core/middleware/login-rate-limit.ts`، in-memory، **5 محاولات/15 دقيقة لكل إيميل** و**30/15 دقيقة لكل IP**) — الرقمان مختلفان عمداً: الـIP شبكةٌ لا شخص (فرع خلف راوتر واحد)، فتساويهما كان يجعل خمس محاولات فاشلة موزّعة على خمسة موظفين تُقفل الموقع كلّه |
| **503**   | غير متاح مؤقتاً        | `ServiceUnavailableError` — صيانة أو تفريغ حمل، مع `Retry-After` اختياري. **وسقوط أي تبعية يُترجَم هنا تلقائياً**: `error-handler.ts` يفحص رمز المقبس (`ECONNREFUSED` · `ETIMEDOUT` · `57P03`…) ويردّ 503 بدل 500 |
| ≥500 أخرى | خطأ سيرفر              | خللٌ فعلي داخل الخادم (يُسجَّل كاملاً باللوجر، الرسالة للعميل عامة)                  |
| 4xx أخرى  | Business error عام     | `BusinessError`                                                                      |

> **لماذا 503 لا 500 عند سقوط تبعية؟** لأن العميل يتصرّف على الفارق: `qirtas_app` يعامل 502/503/504 كحالة عابرة تستحق إعادة محاولة، و500 كطريق مسدود بلا زرّ إعادة — فزرٌّ لا ينجح أبداً أسوأ من غيابه. تسمية انقطاعٍ عابر «خطأً داخلياً» تُخبر كل مستخدم أن التطبيق معطوب، في اللحظة التي كان انتظار عشر ثوانٍ يكفي فيها.

## 5. Conflict (409) — محجوز، غير مستخدم بعد

عند بناء ميزة الـoffline-sync مستقبلاً (`readme/sync.md` بالفرونت)، الـbody المتوقع:

```json
{
  "status": false,
  "message": "...",
  "code": 409,
  "server_version": {},
  "client_version": {},
  "conflict_fields": []
}
```

`ConflictError` بـ`src/core/http/api-error.ts` موجود جاهز لهذا الغرض، لكن لا endpoint يستخدمه الآن.

## 6. Pagination

**Request** (query params — من `PaginationQuery.toJson()` الفعلي بالفرونت):

| Param   | نوع | افتراضي          |
| ------- | --- | ---------------- |
| `page`  | int | 1                |
| `limit` | int | 15 (حد أقصى 100) |

**Response** (`data` بداخل الـenvelope):

```json
{ "items": [], "page": 1, "limit": 15, "total": 42, "total_pages": 3 }
```

⚠️ **ملاحظة مهمة**: هذا الشكل (`items`/`total_pages`) **عقد جديد نبنيه الآن** — لا يوجد أي كود شغّال بالفرونت يستهلك pagination JSON حقيقي حتى تاريخ كتابة هذا الملف (كل ما كان موجود بـ`readme/pagination.md` وشاشة الاختبار كان مثال توضيحي/وهمي فقط). لذلك هذا الملف هو **المرجع الأساسي** — إذا بُنيت `users feature` حقيقية بالفرونت لاحقاً، يجب أن تُطابق هذا الشكل بالضبط (`items` + `total_pages`)، لا العكس.

## 6.1 Filtering & Sorting (اختياري دائماً، متوفر لكل قائمة)

**المبدأ**: كل list endpoint يدعم فلترة+ترتيب اختياريَّين من v1 — الأساس يبقى "جلب الكل" بدون أي فلتر (كسلوك اليوم بالضبط). الفرونت يستخدم هذه البراميترات فقط عند بناء شاشة تحتاجها فعلياً (زر فلتر مرئي) — بدونها، الطلب يتصرف تماماً كأن الفلتر غير موجود.

- كل موديول يعرّف `{module}FilterQuerySchema` خاص به (بجانب `create.../update...BodySchema` الحاليين) بملف `dtos/{module}.dto.ts`، ويُدمَج مع `paginationQuerySchema` عبر `.merge()` عند التسجيل بالـ route.
- **`.strict()` إلزامي** على كل filter schema — أي query param غير معرَّف بالموديول يُرفض بـ422 (Validation Error)، لا يُتجاهل بصمت. هذا يمنع طلبات فلترة صامتة الفشل (خطأ إملائي بالبراميتر يبدو وكأنه "لا فلترة" بدل خطأ واضح).
- حقول الفلترة تعتمد نوع العمود (enum بالباك إند → `z.enum([...]).optional()`، boolean → `z.coerce.boolean().optional()`، إلخ) — لا فلترة حرة (free-text `LIKE`) إلا إذا احتاجها الموديول صراحة.
- **الترتيب عام لكل موديول**: `sort_by` (enum بأسماء الأعمدة القابلة للترتيب فقط — عادة `created_at` + عمود اسمي كـ`name`) و`sort_dir` (`asc`/`desc`) — كلاهما اختياري بافتراض `created_at`/`desc` (نفس سلوك اليوم بعد إصلاح `orderBy` الإلزامي بـ`crud-helpers.ts`).
- الـ**repository**: `findMany` يبني `where`/`orderBy` ديناميكياً من الفلتر الممرَّر بدل تمرير `orderBy` ثابت فقط — انظر مثال حي بـ`branches.repository.ts` (أول موديول طُبِّق عليه هذا العقد).

**مثال طلب** (فرع، فلترة بالحالة + ترتيب بالاسم تصاعدياً):
```
GET /api/v1/branches?status=active&sort_by=name&sort_dir=asc
```

**مثال طلب بلا فلترة** (يبقى بلا تغيير):
```
GET /api/v1/branches?page=1&limit=15
```

**جانب الفرونت**: يُطابَق يدوياً بـclass `{Module}FilterParams` بـ`domain/params/` — نفس نمط الـDTOs/params الحالي بالمشروع (لا أداة توليد آلي؛ عُقد ذلك مُقارَن مقابل بناء pipeline OpenAPI→Dart كامل ورُفض لعدم التناسب مع الحجم الحالي للمشروع). أي حقل يُضاف/يُحذف من `{module}FilterQuerySchema` بالباك إند **يجب** إضافته/حذفه من `{Module}FilterParams` بنفس التغيير — القاعدة موثّقة بـ`qirtas_app/lib/Features/CLAUDE.md` §CRUD-PATTERNS. الاستخدام بالفرونت اختياري بالكامل عبر `AppFilterSheet` الموجود مسبقاً (`shared/widgets/dialogs/app_filter_sheet.dart`) — شاشة لا تستدعيه تبقى تعمل بلا أي تغيير.

## 7. Auth Headers

```
Authorization: Bearer <token>
Accept-language: ar | en
```

✅ **Auth حقيقي مفعّل** (`src/core/middleware/auth.ts`، حل محل `auth.stub.ts` القديم بتاريخ 2026-07-23). `token` هو نص عشوائي (opaque، 256-bit، hex) مُرجَع من `POST /login` ومخزّن بجدول `sessions.token` (unique). كل طلب يُرسِل `Authorization: Bearer <token>` صالح → `req.user = {id}` يُملأ من الـsession المطابقة (و`last_active_at` يُحدَّث best-effort). طلب بدون توكن أو بتوكن غير موجود بالجدول → `req.user = null`، ثم `requireActorId()`/`requireAuth()`/`requirePermission()` (`core/http/require-actor.ts` و`require-permission.ts`) يرمون `401`/`403` حسب الحالة. `Accept-language` يُقرأ فعلياً (`req.lang`، افتراضي `ar`).

### 7.1 انتهاء صلاحية الجلسة (Idle Timeout)

✅ **مفعّل** (2026-07-23) — جلسة بدون أي طلب لمدة `SESSION_IDLE_TIMEOUT_MINUTES` (env var، افتراضي 7 أيام — قيمة placeholder، `users_roles.md` لا يفرض رقماً محدداً) تُعتبر منتهية تلقائياً: أول طلب بتوكنها بعد تجاوز المهلة يُحذف صفّها من `sessions` فوراً ويُعامَل كـ"لا يوجد توكن" (`401`). كل طلب ناجح بتوكن صالح يُحدِّث `last_active_at` (best-effort، لا يوقف الطلب لو فشل التحديث). لا يوجد refresh token منفصل — نفس التوكن يبقى صالحاً طالما الاستخدام مستمر ضمن نافذة الخمول.

### 7.1a إبطال فوري عند تعطيل/تعليق المستخدم (`users.status`)

✅ **مفعّل** (2026-07-27) — كل طلب مُصادَق يتحقق أيضاً من `users.status` لصاحب الجلسة (`JOIN` مباشر بـ`core/middleware/auth.ts`)، ليس فقط من وجود التوكن. أي حالة غير `active` (`suspended`/`disabled`/`rejected`/`pending_approval`) تُعامَل مطابقة تماماً لتوكن غير موجود (`req.user = null` → `401` عبر `requireAuth`/`requirePermission`)، **مع حذف صفّ الجلسة من `sessions` بنفس اللحظة** (تنظيف استباقي، يمنع إعادة نفس الفحص الفاشل لاحقاً). هذا يسد فجوة كانت موجودة سابقاً: قبل هذا التاريخ، تعطيل مستخدم (`POST /:id/disable`) لم يكن يفعل شيئاً لجلسته النشطة الحالية — كان يبقى قادراً على العمل حتى انتهاء TTL (افتراضياً 7 أيام). الآن: أول طلب تالٍ من المستخدم المُعطَّل (أي endpoint) يُرفض فوراً.

**تحديث 2026-09-22 — الرفض يحمل سببه**: الحالة تُقرأ عبر `AccountStore.canSignIn` (للموظف والزبون)، و`pending_approval`/`rejected` **مسموح لها** بالجلسة (شاشة الانتظار داخل التطبيق). والطلب الأول بعد الرفض لم يعد يُكمل كمجهول: يردّ `401` بـ`message_key: account_suspended | account_disabled` **مرة واحدة** (الجلسة تُحذف معه)، **حتى على المسار العام**. كان يُكمل كمجهول فيصل العميلَ `authentication_required` عارياً، ويقرأ المعلَّق «انتهت جلستك» ولا يعرف السبب إلا بمحاولة دخول. العميل يُنهي الجلسة **بلا محاولة تجديد** ويعرض السبب. **والإنهاء المتعمَّد كذلك** (2026-09-22، `session_tombstones`): توكن جلسةٍ أُبطلت عمداً يُجاب `401 session_revoked` + `data.revoke_reason` ∈ `signed_out_elsewhere` (من جهاز آخر) · `password_changed` · `password_reset` · `email_changed` · `admin_reset` (إعادة ضبط MFA بيد أدمن) — بكل طلب وبـ`POST /auth/refresh` معاً، حتى الموعد النهائي الأصلي للجلسة. الانتهاء بالمهلة والخروج المختار يبقيان 401 عادياً. مصدر القرار الكامل: [docs/reference/session_permission_integrity.md](../../docs/reference/session_permission_integrity.md) §5/§10.

### 7.2 حماية كل Endpoint — ثلاث مستويات

| المستوى | الدالة | يعني |
|---|---|---|
| **عام (Public)** | لا شيء | لا يتطلب توكن إطلاقاً — فقط `POST /register`, `POST /login`, `POST /bootstrap-super-admin`, `POST /logout` |
| **مسجّل دخول فقط** | `requireAuth` | يتطلب توكن موظف صالح **بأي حالة يُسمح لها بالجلسة** (بما فيها `pending_*`/`rejected`) — لمسارات الحساب نفسه (`/users/me`، إعادة الإرسال) |
| **موظف معتمَد** (2026-09-22) | `requireApprovedStaff` | كالسابق **و** `status === 'active'`، وإلا `403 account_not_approved`. على `GET /branches` · `GET /branches/:id` · `GET /permissions` · `/data-transfer/*` — كانت `requireAuth` فكان المتقدّم (بل المرفوض) يقرأ فروع المنظمة وكتالوج صلاحياتها ويصدّر بياناتها |
| **صلاحية محدّدة (RBAC)** | `requirePermission('<key>')` | يتطلب توكن صالح **و** أن يملك اليوزر المفتاح المطلوب ضمن اتحاد (union) صلاحيات كل تعييناته الفعّالة (`findAllEffectivePermissionKeys`, `user-role-assignments.repository.ts`) — Allow-only، بدون تقييد فرع لعمليات identity نفسها (branch-agnostic) |

**مفاتيح صلاحيات identity الجديدة** (أُضيفت للكتالوج 2026-07-23 — `core/db/seed.ts`، Super Admin يملكها تلقائياً):

| المفتاح | يحمي |
|---|---|
| `users.view` · `users.create` · `users.edit` | قراءة وإنشاء وتعديل حسابات المستخدمين |
| `users.status` | `suspend` · `disable` · `reactivate` |
| `users.approve` | `decide-registration` |
| `users.access` | قراءة/كتابة أدوار المستخدم واستثناءاته، وإنشاء/نقل/إنهاء `UserRoleAssignment` |
| `users.delete` | حذف · أرشفة · استرجاع |
| **`users.manage`** | **مظلّة منحٍ لا يعلنها أي مسار** — تعني كل `users.*`، بما يُضاف لاحقاً. الأدوار التي كانت تحملها قبل التفصيل (2026-08-16) بقيت تعمل بلا هجرة |
| `branches.manage` | إنشاء/تعديل فرع |
| `ownerships.manage` | تسجيل نسبة ملكية |
| `permissions.manage` | إضافة صلاحية جديدة للكتالوج |
| `roles.view` / `roles.edit` (موجودة أصلاً) | قراءة/كتابة الأدوار وصلاحياتها |
| `audit_log.view` (موجود أصلاً) | قراءة سجل التدقيق |
| `localization.manage` (أُضيفت مع موديول Localization) | إضافة/تعديل لغة ديناميكية، تعطيلها، وتحديث (upsert) ترجماتها |
| `dashboard.view` (أُضيفت 2026-07-29) | الوصول لـ `GET /api/v1/dashboard` — كل بلوك داخل الاستجابة مشروط إضافياً بصلاحية الموديول المطابقة (`users.view`/`branches.manage`/`roles.view`) |

## 8. شكل `User`

```json
{
  "id": 1,
  "first_name": "...",
  "last_name": "...",
  "full_name": "...",
  "email": "...",
  "phone": "...",
  "image": null,
  "address": null,
  "is_admin": false,
  "is_root_protected": false,
  "mfa_enabled": false,
  "email_verified": true,
  "email_verified_at": "2026-01-01T00:00:00.000Z",
  "status": "pending_approval",
  "rejection_reason": null,
  "requested_role_id": 5,
  "requested_branch_id": null,
  "requested_ownership_percentage": null,
  "submitted_at": "2026-01-01T00:00:00.000Z",
  "decided_at": null,
  "decided_by_user_id": null,
  "archived_at": null,
  "created_at": "2026-01-01T00:00:00.000Z"
}
```

> **`archived_at` (2026-08-13)** — متى أُخرج هذا الحساب من التداول، أو `null` وهو على الدفاتر. يُرسل بكل رد **بما فيه القائمة** (عمود عادي، والعميل الذي بيده سجل مؤرشف لا طريق آخر له ليعرف). **ولا يُكتب وحده أبداً**: الأرشفة تكتب `status: "disabled"` بنفس العبارة، فتبقى بوابة الدخول بوابةً واحدة وليست هذه — صفٌّ مخفيّ يستطيع فتح جلسة هو أسوأ الاحتمالين معاً.
>
> **حقول `GET /users/:id` وحدها** (aggregate لكل واحد، فلا مكان لها بصفّ قائمة): `is_deletable` · `is_archivable` · `open_assignments_count` · `assignments_ever_count` · `audit_entries_count`. راجع **§16** للنموذج كاملاً. و`audit_entries_count` هو الذي يشرح الرفض الأكثر إرباكاً: حساب بلا أي تعيين يبدو قابلاً للحذف بداهةً، وليس كذلك إن سجّل دخوله مرة — و`audit_log_entries.user_id` بـ`RESTRICT`.

مصدر الالتزام: `AuthUserModel` الفعلي بالفرونت + [docs/reference/users_complete_reference.md](../../docs/reference/users_complete_reference.md) بالفرونت (المخطط الكامل لقواعد اليوزرات). `full_name` **مشتق** (`first_name + ' ' + last_name`)، غير مخزّن كعمود DB. `password_hash`/`password_reset_token` **لا تظهر أبداً** بالـwire — يُستبعدان صراحة بـ`toWireUser`.

`status`: `pending_verification` | `pending_approval` | `active` | `suspended` | `rejected` | `disabled`.

`pending_verification` **✅ جديد 2026-08-11** — الحساب سُجِّل ولم يُثبت بريده بعد. **يسبق `pending_approval` بدورة الحياة**، ولا يظهر بطابور مراجعة الأدمن إطلاقاً:

```
تسجيل → pending_verification → (رمز صحيح) → pending_approval → (قرار أدمن) → active | rejected
```

هذا الترتيب هو **الضمانة ضد إغراق الطابور**: طابور المراجعة أداةُ عمل أدمن، وبدون هذه البوابة يستطيع أي أحد ملأه بآلاف العناوين التي لا يملكها. إثبات العنوان يكلّف المهاجم صندوق بريد حقيقياً لكل طلب.

الحساب `pending_verification` **يُسجّل دخوله بنجاح** ويحصل على جلسة — لأن شاشة إدخال الرمز داخل التطبيق، والوصول إليها يحتاج جلسة. الجلسة لا تفتح شيئاً محمياً (صفر `UserRoleAssignment` فعّال ← `permission_keys: []`). راجع `POST /auth/verify-email`.

`email_verified` / `email_verified_at` **✅ جديد 2026-08-11** — الأول جواب نعم/لا يقرأه العميل ليقرر وجهة التنقّل، والثاني **متى** حدث. يُرسَل الاثنان معاً عمداً: اشتقاق `email_verified_at != null` بكل مستدعٍ تكرارٌ يُخطئه أحدهم. **كل الحسابات الموجودة قبل هذا التاريخ مُلئت كـ«متحقَّقة»** بترحيل `0006_auth_engine.sql` (بقيمة `created_at` لا `now()`) — أُنشئت تحت نظام لم يطلب إثباتاً قط، فاعتبارها غير متحقَّقة اختراعُ واقعة لا اكتشافها.

> `mfa_enabled` ما زال **محجوزاً بلا تطبيق** — `false` دائماً. راجع `production_readiness.md` §E2. `core/auth/ports/auth-provider.ts` هو المكان الذي يُضاف فيه عامل ثانٍ دون إعادة بناء أي شيء.

`is_root_protected`: **✅ 2026-07-27** — `true` حصراً للحساب الجذري الوحيد بالنظام (أول Super Admin، أُنشئ عبر `POST /bootstrap-super-admin`). لا يُقبل كمدخل بأي جسم طلب (غائب من `createUserByAdminBodySchema`/`updateUserBodySchema`) — المسار الوحيد لضبطه هو `bootstrapSuperAdmin()` نفسها. مُعروض هنا فقط ليقدر الفرونت يعطّل بصرياً أزرار التعديل/التعليق/التعطيل لهذا اليوزر تحديداً بأي قائمة. انظر [docs/reference/users_roles.md — Feature: Root Protected Account](../../docs/reference/users_roles.md#-feature-root-protected-account).

## 9. شكل `Role`

```json
{
  "id": 1,
  "name": "مدير الفرع",
  "category": "management",
  "level": 10,
  "is_system_default": true,
  "is_active": true,
  "archived_at": null,
  "created_at": "2026-01-01T00:00:00.000Z",
  "permissions": [
    { "key": "inventory.view", "module": "inventory", "is_sensitive": false, "created_at": "..." }
  ]
}
```

`permissions` موجود فقط بـ`GET /roles/:id` وبعد إنشاء/تعديل دور — غائب بقائمة `GET /roles` (لتفادي N+1 غير ضروري).

> **`archived_at` (2026-08-13)** — متى أُخرج الدور من الكتالوج، أو `null` وهو فيه. يُرسل بكل رد بما فيه القائمة. **ليس مرادف `is_active: false`**: الدور المعطَّل يُتصفَّح تحت فلتر «معطَّل» بالقائمة لأن إحياءه أمرٌ اعتيادي؛ المؤرشف يغيب عن القائمة أصلاً. والأرشفة **لا تلمس `is_active`**، فدورٌ عُطِّل قبل أرشفته يعود معطَّلاً — أي يعود كما كان.
>
> **`is_archivable` + `open_assignments_count` (2026-08-13، `GET /:id` وحدهما)** — الأول بنفس قاعدة `POST /:id/archive`. والثاني **ليس `active_holders_count`**: ذاك يعدّ أشخاصاً مميَّزين بحالة `active` لأنه يقيس مَن يطاله تغيير الصلاحيات؛ وهذا يعدّ **صفوف تعيين مفتوحة أياً كانت حالة صاحبها**، لأن الموظف الموقوف ما زال يشغل المنصب — والأرشفة تحته تترك تعييناً حيّاً يشير لدور لا تعرضه أي شاشة. إرسال الأول وحده كان سيجعل الشاشة تقول «لا أحد يحمله» بجانب رفضٍ يقول العكس.

> **`assignments_ever_count` (2026-08-06)** — صفوف التعيين التي أشارت لهذا الدور **يوماً**، الفعّالة والمنتهية معاً. سببها بلاغ حيّ: دور `active_holders_count = 0` ورفض الحذف. الرفض صحيح (`assignments_ever_count = 1`، تعيين منتهٍ) لكن الواجهة كانت تُخفي الزر بلا تفسير — **فثلاث حالات مختلفة تبدو متطابقة**: محمول الآن · له سجل بلا حامل · افتراضي بالنظام. الثانية أسوأها: قائمة الحاملين فوقها تقول «لا أحد يحمله»، فغياب الزر يُقرأ عطلاً لا قاعدة. `is_deletable` يبقى المرجع في **إتاحة** الفعل؛ هذا يختار **الجملة** وحدها.

> **`is_deletable` (2026-08-05)** — يُحسب بنفس القاعدة التي يفرضها `DELETE /:id`، فيعرض العميل الزر **حيث ينجح فقط** بدل عرضه للجميع ثم الرفض. `GET /:id` وحده.
>
> **لماذا الحذف مسموح أصلاً بمشروع قاعدته «لا حذف»**: القاعدة موجودة لأن سجلاً كان أحدٌ عليه يجب أن يبقى مقروءاً. ودورٌ **لم يُسنَد لأحد قط** لا يحمل ذلك السجل — لم يكنه أحد، فلا شيء يُحفَظ، وصفٌّ متقاعد أبداً مجرد فوضى بكل قائمة وفلتر إلى الأبد. و`user_role_assignments.role_id` بـ`ON DELETE RESTRICT` فالقاعدة نفسها ترفض؛ الفحص بالـservice موجود ليصل الرفض جملةً مترجَمة لا خطأ قيد خاماً.

> **`active_holders_count` (2026-08-05)** — نفس القاعدة ونفس السبب: aggregate واحد لكل صف بالقائمة. **أشخاص مميَّزون لا صفوف تعيين**: من يحمل الدور بثلاثة فروع شخصٌ واحد تتغيّر قدراته، وعدّه ثلاثاً يُضخّم الأثر. والموقوف/المعطَّل مستثنى — لا يستطيع التصرّف، فتوسيع الدور لا يوسّع له شيئاً اليوم. **ويُحذَف من الرد ولا يُرسَل صفراً** عند عدم حسابه: «لا أحد يحمله» و«لم يُسأل» جوابان مختلفان، والصفر يجعل صف قائمة يدّعي الأول.
>
> **لماذا أصلاً**: تعديل صلاحيات دور **رجعي فوري** على كل حامليه. كان المحرّر يطلب اتخاذ ذلك القرار بلا ذكر عدد من يطاله.

## 10. شكل `Permission`

```json
{ "key": "orders.create", "module": "orders", "is_sensitive": false, "created_at": "..." }
```

مفتاح الصلاحية يلتزم دائماً بصيغة `module.action` (module بصيغة الجمع) — انظر [users_roles.md §Naming Convention](../../docs/reference/users_roles.md).

## 11. شكل `Branch`

```json
{
  "id": 1,
  "name": "الفرع الرئيسي",
  "address": null,
  "contact_info": null,
  "status": "active",
  "is_default": true,
  "archived_at": null,
  "created_at": "..."
}
```

`status`: `active` | `temporarily_closed` | `closed`.

> **`archived_at` (2026-08-13)** — متى أُخرج الفرع من التداول، أو `null` وهو بالخدمة. يُرسل بكل رد بما فيه القائمة. الأرشفة تكتب `status: "closed"` بنفس العبارة: الشرط الذي تحقّقت منه للتوّ (لا تعيين مفتوح ولا ملكية مفتوحة) **هو** ما يوثّقه `closed` نفسه (users_roles.md §Flow.2)، وأي قيمة أخرى ادّعاءٌ متروك عن منظمة تجاوزته — وكان الفرع سيعود من الأرشيف وهو ما زال يسمّي نفسه نشطاً.
>
> **حقول `GET /branches/:id` وحدها**: `is_deletable` · `is_archivable` · `open_assignments_count` · `assignments_ever_count` · `open_ownerships_count` · `ownerships_ever_count`. الملكيات مفحوصة مع التعيينات لا بدلاً عنها — `ownerships.branch_scope` بـ`RESTRICT` تماماً كـ`branch_id`، ففرعٌ لم يعمل فيه أحد قد يكون غير قابل للحذف لأن أحداً ملك حصة منه. راجع **§16**.

## 12. شكل `UserRoleAssignment`

```json
{
  "id": 1,
  "user_id": 3,
  "role_id": 5,
  "branch_id": null,
  "valid_from": "...",
  "valid_to": null,
  "created_at": "..."
}
```

`branch_id: null` = غير مقيّد بفرع (كل الفروع). `valid_to: null` = بلا تاريخ انتهاء.

> **`role_name_then` بردّ `/ended` وحده (2026-08-06)** — اسم الدور **كما كان أثناء سريان التعيين**، ويُرسَل فقط إن اختلف عن `role_name` اليوم (`null` خلاف ذلك، فلا يحمل كل صف منتهٍ حاشية عن لا شيء). **السبب**: `role_name` يأتي من join حيّ، فإعادة تسمية «كاشير» إلى «موظف مبيعات» تُعيد وسم **كل** تعيين منتهٍ جرى تحت الاسم القديم — السجل يعيد كتابة ماضيه بصمت. **مُعاد بناؤه من Audit Log لا مخزَّناً باللقطة** (`audit.service.resolveNameAt`): اللقطة نسخة ثانية للاسم، والنسختان تختلفان أول مرة تُكتب إحداهما دون الأخرى.

## 13. شكل `Ownership`

```json
{
  "id": 1,
  "user_id": 3,
  "percentage": 15,
  "branch_scope": null,
  "valid_from": "...",
  "valid_to": null,
  "created_at": "..."
}
```

## 14. شكل `AuditLogEntry`

```json
{
  "id": 1,
  "user_id": 3,
  "action": "role.permissions.update",
  "target_entity": "role:5",
  "previous_value": ["inventory.view"],
  "new_value": ["inventory.view", "inventory.edit"],
  "ip_address": "127.0.0.1",
  "device_info": "Mozilla/5.0 ...",
  "performed_by_role": null,
  "branch_context": null,
  "created_at": "..."
}
```

---

> **`performed_by_name` (2026-08-06)** — الاسم الكامل للمنفّذ، بـleftJoin على `users`. `null` فقط لو حُذف ذلك الحساب فعلياً. أُضيف لأن «المستخدم ٣ أعاد التسمية» ليست جملة يستعملها قارئ، وجلب كتالوج المستخدمين لتسمية صفحة من الإدخالات أغلى من الـjoin.

> **هذا الجدول هو الأرشيف — ولا يوجد جدول ثانٍ (2026-08-06).** كل طفرة تُسجَّل هنا بطرفَيها ووقتها منذ 2026-08-04، ولم يكن أي شيء يقرأه. `EntityHistorySection` بالفرونت تعرضه على تفاصيل الدور والمستخدم والفرع (`?target_entity=role:5`)، وتشتقّ منه **خط أسماء السجل عبر الزمن**: كل إدخال `*.update` غيّر `name` يُغلق فترة ويفتح التالية. جدول `*_history` مواز كان سيصير مكاناً ثانياً يعيش فيه الماضي، والمكانان يختلفان أول مرة يُكتب أحدهما دون الآخر.

---

## 15. شكل `Language`

```json
{
  "code": "fr",
  "name": "Français",
  "is_rtl": false,
  "version": 2,
  "is_active": true,
  "created_at": "...",
  "updated_at": "..."
}
```

**لا يشمل ar/en أبداً** — هذان compile-time بالفرونت (`easy_localization`/`CodegenLoader`)، خارج نطاق هذا الجدول بالكامل. مصدر القرار: [docs/reference/dynamic_localization.md](../../docs/reference/dynamic_localization.md) §5/§6 (Model 2). `version` يرتفع فقط عبر `PUT /:code/translations` الناجح.

## 16. إزالة السجلات — مخرجان لا واحد (2026-08-13)

ينطبق بالشكل نفسه على **الفرع** و**الدور** و**المستخدم**. السؤال الذي يفصل بينهما ليس «هل هذا مهم؟» بل سؤال واقعي واحد:

| | الشرط | ماذا يحدث | الحماية |
|---|---|---|---|
| **حذف** `DELETE /:id` | **لم يُشِر إليه شيء قط** | الصفّ يُمحى | صلاحية الموديول وحدها |
| **أرشفة** `POST /:id/archive` | **لا يشير إليه شيء الآن** | الصفّ يبقى، ويختفي من كل قائمة ومنتقٍ وفلتر | صلاحية الموديول **+ `records.archive`** |

**لماذا لا يكفي الحذف وحده.** القاعدة العامة بالمشروع أن التاريخ يُحفظ، وهي ليست تفضيلاً: `user_role_assignments.role_id`/`branch_id` و`ownerships.branch_scope` كلها `ON DELETE RESTRICT`، وتلك الصفوف المغلقة هي المكان الذي كُتب فيه «أحمد كان كاشيراً بفرع المزة حتى آذار». حذف الفرع لتنظيف قائمة يمحو فترة من سجل عمل شخص. فكان الأثر العملي أن **كل** فرع ودور استُعمل فعلاً بقي بالقائمة إلى الأبد، بلا أي مخرج — والشكوى الأصلية («أضفت فرعاً وخربطت، أفضّل ألّا أضطر لتركه») لها نصفان: نصفٌ يحلّه الحذف (فرعٌ عمره خمس دقائق)، ونصفٌ لا يحلّه أبداً.

**والأرشفة تجيب النصف الثاني بلا دفع الثمن**: الصفّ يبقى، فكل ما يشير إليه ما زال يُحلّ إلى اسم حقيقي، والسجل يُقرأ كما كان — لكنه يغيب عن كل مكان يتصفّحه أحد. وهي **قابلة للعكس** (`POST /:id/unarchive`).

**قواعد ثابتة عبر الثلاثة:**

1. **`?archived=true` يعرض المؤرشف وحده** لا مضافاً إلى الحيّ. الأرشيف عرضٌ مستقل؛ خلطهما يترك القارئ بلا ما يميّز أحدهما من الآخر صفاً صفاً.
2. **كل كتابة على سجل مؤرشف تُرفض** `409 <entity>_archived`. أخطر صورة لذلك هي «إعادة التفعيل»: كانت ستُنتج سجلاً فعّالاً غير مرئي.
3. **لا يُفتح تعيين جديد على دور أو فرع مؤرشف** — `409 role_archived`/`branch_archived` بـ`POST /users/:id/role-assignments` و`POST /role-assignments/:id/transfer`. هذه هي القاعدة التي تمنع النموذج من الانهيار: الأرشفة آمنة لأن لا شيء يشير للصفّ، وتعيينٌ جديد بعدها يكسر النصفين معاً.
4. **الأرشفة تكتب حالةً متّسقة بنفس العبارة** — الفرع يصير `closed` والمستخدم يصير `disabled`. فلا يوجد صفٌّ مخفيّ يدّعي أنه يعمل، ولا حساب مخفيّ يفتح جلسة.
5. **الأرشفة idempotent** — طلبٌ ثانٍ يُرجع 200، لا 409. اتفاق أدمنَين على القرار نفسه ليس تعارضاً.
6. **`GET /:id` يحمل الحكم والسبب** — `is_deletable`/`is_archivable` محسوبان بنفس القاعدتين اللتين يفرضهما المساران، فيعرض العميل الفعل **حيث ينجح**؛ والأعداد بجانبهما موجودة ليكون الرفض جملةً: «٧ تعيينات بتاريخه» تفيد، و«تعذّر الحذف» لا تفيد.

**لماذا `records.archive` منفصلة عن `branches.manage`/`users.delete`/`roles.edit`**: ليست الأرشفة أخطر من التعديل — بل إن صلاحيات الإدارة اليومية تُعطى لمن يدير فرعاً ويوظّف الناس، وقرارُ أن سجلاً له ماضٍ يجب أن يتوقف عن الظهور ليس جزءاً من تلك الوظيفة. من يحملها يستطيع إخفاء فرعٍ عمل فيه أناس من كل شاشة بالتطبيق؛ الصفّ والتاريخ ينجوان، لكن لا أحد يبحث في أرشيف لم يُخبَر بوجوده. أما الحذف حين لا تاريخ فيكفيه مفتاح الموديول: لا شيء يُوزَن حين لا شيء يشير للصفّ.

## Endpoints الحالية

> المصدر المعماري الكامل لكل قاعدة عمل خلف هذه الـendpoints: [docs/reference/users_roles.md](../../docs/reference/users_roles.md) و[users_complete_reference.md](../../docs/reference/users_complete_reference.md).

### Users & Authentication — `/api/v1/users`

| Method | Path                       | الحماية | ملاحظة                                                                                                            |
| ------ | -------------------------- | --- | ----------------------------------------------------------------------------------------------------------------- |
| GET    | `/`                        | 🔑 `users.view` | قائمة مُصفّحة (`Paginated<User>`) — الفلاتر أدناه |
| GET    | `/me`                      | 🔒 مسجّل دخول | **بيانات المستخدم الحالي نفسه** — `{user, permission_keys}` (نفس شكل بيانات `login` بدون `token`/`session_id`). يعيد استخدام نفس `findAllEffectivePermissionKeys` المستخدم بـ`login`. مُسجَّل **قبل** `/:id` كي لا يُبتلَع بمسار الـparam. الاستخدام الأساسي: تحقق خلفي صامت بالفرونت بعد استعادة جلسة مخبّأة (**✅ 2026-07-27**، انظر [docs/reference/session_permission_integrity.md](../../docs/reference/session_permission_integrity.md) §6/§10) |
| GET    | `/:id`                     | 🔑 `users.view` | يوزر واحد أو 404 |
| POST   | `/`                        | 🔑 `users.create` | **إنشاء مباشر من الأدمن** — يختلف عن `/register` (تسجيل ذاتي + مراجعة لاحقة). هنا الأدمن يُنشئ الحساب مباشرة لصالح شخص آخر بخطوة واحدة: `status=active` فوراً مع `role_id` (إلزامي) و`branch_id`/`ownership_percentage` (اختياريان) مُعيَّنة في نفس الطلب — الأدمن نفسه هو الموافقة، لا حاجة لـ`decide-registration` بعدها. تعارض إيميل → `409`، دور غير موجود/غير فعّال → `404`/`422` |
| PATCH  | `/:id`                     | 🔑 `users.edit` | تعديل حقول الهوية/البروفايل فقط (`first_name`/`last_name`/`email`/`phone`) — **لا** `status`/`is_admin`/كلمة المرور (لكل منها endpoint مخصص: suspend/disable/reactivate/decide-registration للحالة، وتدفق منفصل خارج النطاق لكلمة المرور). تعارض إيميل مع يوزر آخر → `409`. الهدف `is_root_protected=true` → `403` دائماً، بلا استثناء لأي منفِّذ (**✅ 2026-07-27**) |
| POST   | `/register`                | 🌐 عام + Rate Limit | **التسجيل الذاتي** — نقطة الدخول الوحيدة لأي حساب موظف/شريك (self-service). **✅ محدَّث 2026-08-11**: ينشئ `status=pending_verification` (لا `pending_approval`) ويُرسل رمز تأكيد للبريد، فلا يظهر بطابور المراجعة قبل إثبات العنوان — راجع §8. عند `EMAIL_VERIFICATION_MODE=off` يهبط عند `pending_approval` كما كان تماماً. **مختلف عن `POST /` أعلاه** (إنشاء مباشر من الأدمن، فعّال ومتحقَّق فوراً — الأدمن هو الإثبات).<br>**✅ تغيّر شكل الرد 2026-08-12**: يُرجع الآن **نفس جسم `POST /login`** (`{ user, token, session_id, permission_keys, is_super_admin }`) لا كائن اليوزر وحده — كل ما كان بـ`data` صار بـ`data.user`. **السبب**: `POST /auth/verify-email` محمي بـ`requireAuth`، فبلا توكن هنا يستحيل على العميل تنفيذ الخطوة التي يطلبها الرد نفسه، وكان الحل السابق إرسال المستخدم لشاشة الدخول ليكتب بيانات سلّمها للتو. **ولا يمنح شيئاً جديداً**: نفس الحساب يستدعي `POST /login` بعد ثانية فيأخذ التوكن نفسه — الحساب بلا تعيين فعّال، فـ`permission_keys` فارغة والجلسة لا تفتح غير شاشة الرمز. صادرة عبر `login()` داخلياً فلا تنحرف عن رفضات `canSignIn` ولا عن حساب الصلاحيات |
| POST   | `/bootstrap-super-admin`   | 🌐 عام | Setup Wizard — ينجح **فقط** لو عدد اليوزرز بالنظام = صفر. ينشئ Super Admin + Ownership 100% + `is_root_protected=true` (المسار الوحيد الذي يضبط هذا الحقل — **✅ 2026-07-27**) |
| POST   | `/login`                   | 🌐 عام + Rate Limit | إيميل + كلمة مرور → `{user, token, session_id, permission_keys}`. `token` يُستخدم كـ`Authorization: Bearer <token>` بأي طلب لاحق. `permission_keys` هو اتحاد صلاحيات كل تعيينات اليوزر الفعّالة (نفس مصدر `findAllEffectivePermissionKeys` المستخدم بـ`requirePermission`، branch-agnostic) — **✅ 2026-07-27**، يُستهلك بالفرونت لتحديد أي UI مُصرَّح بها فوراً بعد الدخول دون طلب إضافي. **✅ محدَّث (2026-07-28)**: `pending_approval`/`rejected` الآن ينجحان (`200`) ويحصلان على جلسة حقيقية بدل `403` — الحساب يبقى قابل للوصول (شاشة "حالة الطلب"، تعديل وإعادة إرسال) حتى بعد حذف/إعادة تثبيت التطبيق؛ الجلسة لا تفتح أي endpoint محمي فعلياً لأن `permission_keys` تبقى `[]` دائماً (صفر `UserRoleAssignment` فعّال لهاتين الحالتين). فقط `suspended`/`disabled` يبقيان يرفضان بـ**403** مع `data.account_status` للتمييز البرمجي (انظر التفصيل تحت الجدول — لا تعتمد على مطابقة نص `message`). **محدود بـ5 محاولات/15 دقيقة لكل إيميل و30/15 دقيقة لكل IP معاً** (`core/middleware/login-rate-limit.ts` — الرقمان مختلفان عمداً، راجع §4) — تجاوز أي منهما → `429` مع `Retry-After` بالثواني. النجاح يصفّر عدّاد ذاك الإيميل/IP فوراً |
| POST   | `/logout`                  | 🌐 عام | ينهي الجلسة الحالية فقط (حسب التوكن بالـheader) — بقية جلسات نفس اليوزر تبقى شغّالة. Idempotent (200 حتى لو التوكن أصلاً غير صالح) |
| POST   | `/forgot-password`         | ⚠️ **مهجور** | نُقل إلى `POST /api/v1/auth/forgot-password` (2026-08-11). المسار القديم يبقى عاملاً كـalias — راجع الملاحظة تحت الجدول |
| POST   | `/reset-password`          | ⚠️ **مهجور** | نُقل إلى `POST /api/v1/auth/reset-password`. **تغيّر اسم حقل**: `code` بدل `token` (الاسم القديم ما زال مقبولاً) |
| POST   | `/change-password`         | ⚠️ **مهجور** | نُقل إلى `POST /api/v1/auth/change-password` |
| POST   | `/me/resubmit-registration` | 🔒 مسجّل دخول | **✅ جديد (2026-07-28)** — إعادة تسجيل حساب `rejected` (نفس اليوزر المسجَّل دخوله فقط، عبر الجلسة لا `:id`). يقبل `requested_role_id` (إلزامي)/`requested_branch_id`/`requested_ownership_percentage` (نفس شكل `/register`، بدون حقول الهوية/كلمة المرور). يرجّع `status: rejected → pending_approval` ويصفّر `rejection_reason`/`decided_at`/`decided_by_user_id`. `409` لو الحساب مو `rejected` حالياً |
| POST   | `/:id/decide-registration` | 🔑 `users.approve` | قرار الأدمن على طلب معلّق: `approve` (كما هو أو بتعديل الدور/الفرع/النسبة) أو `reject` (سبب إلزامي) |
| POST   | `/:id/suspend`             | 🔑 `users.status` | إيقاف مؤقت وقابل للرجوع (تحقيق/إجازة) — يختلف عن `disable`. الهدف `is_root_protected=true` → `403` دائماً (**✅ 2026-07-27**) |
| POST   | `/:id/disable`             | 🔑 `users.status` | تعطيل دائم (Offboarding) — لا حذف فعلي أبداً. الهدف `is_root_protected=true` → `403` دائماً (**✅ 2026-07-27**)   |
| POST   | `/:id/reactivate`          | 🔑 `users.status` | من `suspended` أو `disabled` إلى `active` — بدون إنشاء حساب جديد. نفس فحص `is_root_protected` مضاف للاتساق مع باقي عمليات الحالة (نظرياً غير قابل للحدوث لحساب جذري بما إنه لا يصل أصلاً لـ`suspended`/`disabled`) |
| DELETE | `/:id`                     | 🔑 `users.delete` | **حذف صلب (2026-08-13)** — لحساب لم يُسجَّل عليه شيء **قط**: صفر تعيين، صفر ملكية، **وصفر سطر Audit نفّذه بنفسه**. الأخير هو الشرط الحاكم عملياً: `audit_log_entries.user_id` بـ`RESTRICT`، فمن سجّل دخوله مرة واحدة صار غير قابل للحذف أبداً — والباقي فعلياً هو الحساب المكرَّر/المكتوب بخطأ. `409 user_has_audit_history` · `409 user_has_history` · `403 user_root_protected` · `403 user_cannot_remove_self` |
| POST   | `/:id/archive`             | 🔑 `users.delete` **+** `records.archive` | **أرشفة (2026-08-13)** — مخرج كل من لا ينطبق عليه الحذف، أي الجميع تقريباً: يختفي من القوائم ويُقفل، وكل ما فعله يبقى منسوباً لشخص حقيقي. الشرط: صفر تعيين مفتوح وصفر ملكية مفتوحة. **يكتب `status: "disabled"` بنفس العبارة** فتبقى بوابة الدخول واحدة. `409 user_has_active_assignments` · `409 user_has_active_ownerships` · `403 user_root_protected` · `403 user_cannot_remove_self`. متكرِّرة بلا أثر |
| POST   | `/:id/unarchive`           | 🔑 `users.delete` **+** `records.archive` | استرجاع — يمسح `archived_at` **وحده**، فيعود الحساب `disabled`. إعادة منح الوصول تبقى قراراً منفصلاً بمساره المسجَّل (`/:id/reactivate`) |

> **لماذا لا يحذف/يؤرشف أحدٌ نفسه** (`user_cannot_remove_self`): الأرشفة تكتب `disabled`، فتنهي وصول المنفِّذ أثناء تنفيذه — الرد يصل إلى شاشة لم يعد لها حق أن تكون مفتوحة، ولو كان آخر إداريّ فلا أحد يستطيع التراجع. `assertNotLastAdministrator` يحرس مسار التعيينات؛ وهذا يحرس الطريق الأقصر إلى المكان نفسه.
>
> **وأي كتابة على حساب مؤرشف تُرفض** `409 user_archived` (تعديل · تعليق · تعطيل · إعادة تفعيل). أخطرها إعادة التفعيل: كانت ستمسح `disabled` وتترك حساباً **نشطاً، يستطيع الدخول، ولا يظهر بأي قائمة يتصفّحها أدمن**.

> ### 🔒 `POST /forgot-password` — الجواب **الموحَّد** عقدٌ لا سهو
>
> يرجع `200` للبريد المسجَّل وغير المسجَّل، **ولا يجوز إضافة فرع «لا يوجد حساب»**.
>
> **لماذا**: ردٌّ مختلف للعنوان غير الموجود يحوّل الـendpoint إلى **عرَّاف عضوية** — أي شخص يجرّب العناوين واحداً واحداً فيعرف من يملك حساباً هنا. وهذا تسريب حقيقي بأي نظام تكون العضوية فيه نفسها معلومة خاصة، وتفاديه بلا كلفة.
>
> والقاعدة تمتدّ للحالات: الحساب `disabled`/`rejected` يسلك **المسار نفسه** ويرجع الشكل نفسه بلا إرسال رمز — لأن «هذا الحساب موجود ومعطَّل» هي بالضبط المعلومة التي يسعى إليها العرَّاف.
>
> **⚠️ وحالة التوصيل** (صُحِّح 2026-08-17): الرمز يُسلَّم عبر **`EmailSender`** — نفس منفذ البريد الذي يخدم رمز التحقق، بمحوّلاته الثلاثة (`log` · sandbox · sending). التفصيل بـ[`mail.md`](mail.md).
>
> كان هذا السطر يقول إن «المشروع بلا مرسل بريد (لا nodemailer ولا مزوّد)» وإن التنفيذ يمرّ بمنفذ `PasswordResetDelivery`. **الثلاثة صارت غير صحيحة**: `nodemailer` تبعية معلنة، و`requestPasswordReset` يستدعي `emailSender().send(buildPasswordResetEmail(...))` منذ توحيد المنافذ، و`PasswordResetDelivery` **حُذف 2026-08-17** بلا مستدعٍ واحد. وخطورة السطر أنه كان يوصي بعملٍ منتهٍ: «الإطلاق يتطلب محوّلاً حقيقياً — ملف واحد وسطر تبديل».
>
> **وقاعدة عدم الرمي تبقى**: فشل التسليم **لا يغيّر الرد** — لو صار استثناءً لعاد العرَّاف من باب الخطأ بدل باب النجاح. `EmailSender.send` يُرجع النتيجة قيمةً لا يرميها، لهذا السبب بالضبط.

**`POST /login`** — شكل رد الرفض (403) لحالتي `suspended`/`disabled` فقط، مع `data.account_status` للتمييز البرمجي:

```json
{ "status": false, "message": "Your account is temporarily suspended", "code": 403, "data": { "account_status": "suspended" } }
```

`account_status`: `suspended` | `disabled`. **`pending_approval`/`rejected` لا يرجعان 403 بعد الآن (✅ 2026-07-28)** — ينجح الدخول (`200`) بجلسة حقيقية، والفرونت يفرّق الحالتين عبر `data.user.status` بجسم النجاح نفسه (مو `error.data`)؛ حالة `rejected` تحمل أيضاً `data.user.rejection_reason` (نفس نص `User.rejectionReason`) ليعرضه الفرونت بشاشة "حالة الطلب". **الفرونت يجب أن يفرّق كل الحالات عبر حقل `status`/`account_status`، لا عبر مطابقة نص `message`** (النص قابل للتغيير، الحقل لا).

**`POST /`** body (إنشاء مباشر من الأدمن — مختلف عن `/register`):

```json
{
  "first_name": "...",
  "last_name": "...",
  "email": "...",
  "phone": "...",
  "password": "min 8 chars",
  "role_id": 5,
  "branch_id": 1,
  "ownership_percentage": 10
}
```

`role_id` إلزامي (بخلاف `requested_role_id` بـ`/register` اللي كان مجرد طلب) — كل حساب يُنشأ بهذا المسار لازم يكون له دور من البداية. `branch_id`/`ownership_percentage` اختياريان. الناتج `status=active` مباشرة، بدون أي حاجة لاحقة لـ`decide-registration`.

**`POST /register`** body:

```json
{
  "first_name": "...",
  "last_name": "...",
  "email": "...",
  "phone": "...",
  "password": "min 8 chars",
  "requested_role_id": 5,
  "requested_branch_id": 1,
  "requested_ownership_percentage": 10
}
```

`requested_branch_id`/`requested_ownership_percentage` اختياريان — الأخير يعني "أتقدّم كشريك أيضاً بنفس الطلب".

ورد `POST /register` (201) — **نفس شكل `POST /login` حرفياً**:

```json
{
  "status": true,
  "message": "Registration received — confirm your email address to continue",
  "code": 201,
  "data": {
    "user": { "id": 12, "status": "pending_verification", "email_verified": false, "...": "..." },
    "token": "...",
    "session_id": 34,
    "permission_keys": [],
    "is_super_admin": false
  }
}
```

> ⚠️ **كسر متوافق مع الإصدار السابق لا يوجد**: العميل الذي كان يقرأ `data.status` يجب أن يقرأ `data.user.status`. الفرونت (`RegisterModel`) محدَّث معه بنفس التغيير.

**`PATCH /:id`** body (كل الحقول اختيارية):

```json
{ "first_name": "...", "last_name": "...", "email": "...", "phone": "..." }
```

**`POST /bootstrap-super-admin`** body — نفس شكل `/register` بدون حقول الدور/الفرع/الملكية (تُبنى داخلياً: دور Super Admin المزروع مسبقاً بكل صلاحيات الكتالوج + Ownership 100%):

```json
{
  "first_name": "...",
  "last_name": "...",
  "email": "...",
  "phone": "...",
  "password": "min 8 chars"
}
```

ينجح **فقط** لو `usersRepository.countAll() === 0` (أي حساب واحد موجود يمنعه نهائياً بـ403) — هذه **الطريقة الوحيدة المعتمدة** لإنشاء أول Super Admin (لا يوجد ولن يُبنى أي شاشة Frontend لهذا الاستدعاء بقرار صريح؛ مالك المشروع يستدعيه مباشرة عبر API أو سكربت مرة واحدة عند إعداد بيئة جديدة). لا يوجد سكربت CLI بديل بهذا الباك (`create:admin` القديم أُزيل — كان نسخة أضعف مكرّرة بدون فحص `countAll`/`is_admin`/Ownership، استُبدل كلياً بهذا الـendpoint).

**`POST /:id/decide-registration`** body (discriminated union بـ`decision`):

```json
{ "decision": "approve", "role_id": 5, "branch_id": 1, "ownership_percentage": 10 }
```

```json
{ "decision": "reject", "reason": "..." }
```

عند الموافقة: `role_id`/`branch_id`/`ownership_percentage` اختيارية — تفتراضياً تُستخدم القيم المطلوبة أصلاً وقت التسجيل، والأدمن يقدر يغيّرها بالكامل قبل التفعيل.

**`PUT /:id/overrides`** (`users.access`) — body `{ "overrides": [{ "key", "effect": "allow"|"deny", "note"? }] }`، يستبدل المجموعة كاملة. **قيود الكاتب (2026-09-22)** — كان المفتاح وحده يكفي، فمن يملكه يمنح نفسه أي صلاحية، ويسحب صلاحيات السوبر أدمن، ويعطي صلاحيات لحساب `pending_approval` متجاوزاً الموافقة. كلها `403` بـ`message_key`:

| `message_key` | متى |
|---|---|
| `user_root_protected` | الهدف حساب جذري محمي والكاتب ليس صاحبه |
| `override_target_outranks_actor` | للهدف مستوى سلطة والكاتب لا يعلوه (أو بلا مستوى) — نفس قاعدة إسناد الدور. الكتابة على النفس مستثناة |
| `override_target_not_active` | `allow` **جديد** على حساب غير `active` (الـ`deny` مسموح دائماً) |
| `override_key_not_held` | `allow` **جديد** بمفتاح لا يملكه الكاتب؛ `data.keys` يسمّيها |
| `authz_self_lockout` | (قائم) حظر `users.access`/`roles.edit` عن النفس |

«جديد» = غير موجود كـ`allow` بالمجموعة الحالية: إعادة إرسال استثناء منحه غيرك لا تُرفض، وإلا صار الحساب غير قابل للتعديل ممن هو دون مانحه.

**قاعدة المستوى على كل مسار يمنح دوراً (2026-09-22)** — `canGrantRoleLevel` (`features/identity/authority-level.ts`): دورٌ بمستوى لا يمنحه إلا من يعلوه **بصرامة**، و**من لا مستوى له لا يمنح دوراً ذا مستوى** (كان يُعفى، فدور بلا سلطة يملك `users.access` يُسند «المدير العام»). تُطبَّق الآن على: إنشاء تعيين · النقل · **`POST /users`** (إنشاء حساب بدور) · **`decide-registration`** (الموافقة — حتى على الدور الذي طلبه المتقدّم) · إنشاء/تعديل/أرشفة دور. الأول والثاني كانا بلا فحص: `users.create` أو `users.approve` وحدهما صنعا مديراً عاماً بكلمة مرور يختارها المنفّذ. الرفض `403 role_above_actor_level` (و`role_edit_above_actor_level` لتعديل الدور). و`GET /roles?assignable=true` يعكس القاعدة نفسها حرفياً.

**`PUT /roles/:id/permissions` و`POST /roles`**: `403 role_key_not_held` لمفتاح **مضاف** لا يملكه المنفّذ (`data.keys`). كان `roles.edit` مفتاحاً شاملاً: أضف `users.manage` لدور أدنى منك ثم أسنده لنفسك. الاستنساخ يُحسب إضافة كاملة.

### Authentication & Sessions — `/api/v1/auth` ✅ جديد 2026-08-11

> **لماذا مسار جديد**: هذه الـendpoints لا تعرف شيئاً عن الأدوار ولا الفروع ولا الملكية — منطقها كامل في `core/auth/`، وهي **قابلة للنقل كما هي** لأي تطبيق آخر يبني على هذا القالب. `POST /users/login` و`/users/logout` بقيا مكانهما عمداً: ردّهما يحمل `permission_keys` و`is_super_admin`، وهما حقيقتا **تخويل** لا مصادقة، فلا يجوز أن يعرفهما محرّك قابل لإعادة الاستخدام. الاثنان يفوّضان المصادقة نفسها لنفس خدمة `core/auth` — **تنفيذ واحد بمدخلين، لا تنفيذان**.

| Method | Path | الحماية | ملاحظات |
| ------ | ---- | --- | --- |
| POST | `/refresh` | 🌐 عام (يقرأ التوكن من الـheader) | يمدّد الجلسة، ويُصدر توكناً بديلاً إن تجاوز عمره `SESSION_ROTATE_AFTER_HOURS`. الردّ `{token, rotated, expires_at}` — العميل يخزّن ما يصله في الحالتين. **`rotated=false`** يعني أن التوكن ما زال فتيّاً فعاد كما هو (تدوير عند كل إقلاق ضجيجٌ بلا مكسب). جلسة منتهية بالخمول أو بالسقف المطلق أو مُبطَلة → **`401` ولا تُحيا أبداً**. **بلا `requireAuth` عمداً**: الجلسة المنتهية هي بالضبط من يستدعي هذا |
| GET | `/sessions` | 🔒 مسجّل دخول | أجهزة المستخدم نفسه (`WireSession[]`). **التوكن لا يُرجَع إطلاقاً** — المخزَّن تجزئته فقط. `is_current` يميّز الجلسة صاحبة الطلب |
| DELETE | `/sessions/:id` | 🔒 مسجّل دخول | إنهاء جلسة بعينها. جلسة غير موجودة وجلسة شخص آخر ترجعان **نفس** `404` — فلا يكشف تعداد المعرّفات أيها حيّ |
| POST | `/sessions/revoke-others` | 🔒 مسجّل دخول | «سجّل خروج أجهزتي الأخرى» — **يستثني جلسة المنفِّذ**: أن تُخرج نفسك أثناء تأمين حسابك يُقرأ كعطل. الردّ `{sessions_revoked}` |
| POST | `/verify-email` | 🔒 مسجّل دخول + Rate Limit | `{code}` → `200`. عند النجاح ينتقل الحساب من `pending_verification` إلى `pending_approval` ويدخل طابور المراجعة. **موثَّق** لأن شاشة الرمز داخل التطبيق ولا يُوصل إليها بلا جلسة. رمز خاطئ · منتهٍ · مُستهلَك · نفدت محاولاته → **نفس** `422` بمفتاح `verification_code_invalid` |
| POST | `/resend-verification` | 🔒 مسجّل دخول + Rate Limit | يُصدر رمزاً جديداً **ويُبطل السابق** (وإلا ضاعف كل resend ميزانية التخمين ضد الحساب). فترة تهدئة → `429` (`verification_resend_cooldown`) — **يُصرَّح بها هنا** لأن الطلب موثَّق فلا يكشف شيئاً، بعكس `/forgot-password` تماماً. حساب متحقَّق أصلاً → `409` |
| POST | `/forgot-password` | 🌐 عام + Rate Limit | `{email}` → **`200` دائماً**، مسجَّلاً كان البريد أو لا. عقد أمني لا سهو — راجع الصندوق تحت جدول `/users`. حتى فترة التهدئة تُبتلع صامتةً: «انتظر ٤٠ ثانية» تؤكد أن رمزاً أُرسل للتوّ، أي تؤكد أن الحساب موجود |
| POST | `/reset-password` | 🌐 عام + Rate Limit | `{email, code, new_password}` → `200`. **`code` هو الاسم الجديد لـ`token`** (والقديم ما زال مقبولاً): لم يكن توكناً قط، بل **ستة أرقام** يقرؤها إنسان ويعيد كتابتها. **كل جلسات الحساب تُحذف** بعدها |
| POST | `/change-password` | 🔒 مسجّل دخول | `{current_password, new_password, revoke_other_sessions?}` → `{sessions_revoked}`. كلمة حالية خاطئة → **`422`** لا `401`. **جديد**: `revoke_other_sessions` (افتراضياً `false`) — الخيار للمستخدم لأنه وحده يعرف إن كان التغيير روتينياً أم رداً على شيء. جلسة المنفِّذ تنجو دائماً |

**حدود التخمين — طبقتان لا واحدة**:

| الطبقة | المكان | ما تحمي منه | ما لا تحميه |
|---|---|---|---|
| سقف محاولات **لكل رمز** | `auth_verification_tokens.attempts` | التخمين — **ويصمد أمام تدوير الـIP** | حجم الطلبات |
| حدّ **لكل IP** | `core/middleware/*-rate-limit.ts` | الإغراق وسيناريو «احرق رمزاً واطلب غيره» | مهاجم بمجموعة IPs |

الطبقة الأولى **لم تكن موجودة قبل 2026-08-11**: كان رمز الاستعادة محميّاً بحدّ الـIP وحده، وهو حدٌّ لا يمتلئ أصلاً لمن يدوّر عناوينه. بلوغ السقف **يحرق الرمز لا يقفل الحساب** — القفل يجعل التخمين السيّئ سلاحَ حرمانِ خدمة ضد الضحية.

**الجلسة — ثلاث نهايات مستقلة**: خمول (`SESSION_IDLE_TIMEOUT_MINUTES`، ينزلق مع الاستخدام) · سقف مطلق (`SESSION_ABSOLUTE_TIMEOUT_DAYS`، لا ينزلق — وهو ما يحدّ توكناً مسروقاً من جهاز يستقصي بالخلفية فيجدّد نافذة الخمول للأبد) · إبطال صريح. ورابعة يفرضها الـmiddleware بكل طلب: `AccountStore.canSignIn` صار `false` (تعليق/تعطيل) ← الجلسة تُحذف فوراً.

**`sessions.token` صار `sessions.token_hash`** (SHA-256): تسريب نسخة احتياطية كان يسلّم القارئ جلسةً عاملة لكل مستخدم مسجَّل دخوله، بلا كلمة مرور — نفس الانكشاف الذي يوجد `password_hash` لمنعه، وبجوار رمزِ استعادةٍ كان مُجزَّأً أصلاً. **الجلسات القائمة لا تُرحَّل** (تجزئتها تتطلب قراءة النص الصريح، وهو ما توقّفنا عن الاحتفاظ به): الجميع يسجّل دخوله مرة واحدة بعد النشر.

### Role Assignments — `/api/v1/users/:userId/role-assignments` و`/api/v1/role-assignments`

| Method | Path                                       | الحماية | ملاحظة                                                                                                              |
| ------ | ------------------------------------------ | --- | ------------------------------------------------------------------------------------------------------------------- |
| GET    | `/users/:userId/role-assignments`          | 🔒 مسجّل دخول | التعيينات الفعّالة حالياً لهذا اليوزر                                                                               |
| GET    | `/users/:userId/role-assignments/ended`    | 🔑 `users.access` | **التعيينات المنتهية** — النصف المُغلق من نفس السجل. كل صف يحمل `role_name_then` |
| POST   | `/users/:userId/role-assignments`          | 🔑 `users.access` | تعيين دور جديد (يخضع لفحص منع تصعيد الصلاحيات نسبة لمستوى المنفّذ)                                                  |
| POST   | `/role-assignments/:assignmentId/transfer` | 🔑 `users.access` | نقل فرع/دور — يقفل التعيين الحالي ويفتح واحد جديد (لا يعدّل `branch_id` مباشرة). تحذير "آخر موظف مؤهل" يُتخطّى بـ`force: true` |
| POST   | `/role-assignments/:assignmentId/end`      | 🔑 `users.access` | إنهاء تعيين (Offboarding). نفس التحذير ونفس `force`. الجسم `{ force?, effective_at? }` — كله اختياري |

> **`GET /users/:id/permissions`** (2026-08-05) — 🔑 `users.access`. مصفوفة مسطّحة بمفاتيح الصلاحيات: اتحاد ما تمنحه كل تعيينات الشخص الفعّالة. منفصل عن سجل المستخدم لا حقلاً فيه — مشتقّ من التعيينات، قد يطول، ومعظم قراءات المستخدم لا تحتاجه. صلاحيات المستخدم **عن نفسه** تأتي من `/users/me` بلا أي صلاحية مطلوبة.

> **`GET /users/:userId/role-assignments` يحمل `branch_status`** (2026-08-05) — حالة الفرع نفسه بجانب اسمه، و`null` للتعيين غير المقيّد (لا فرع له ليحمل حالة، و`active` هنا كانت ستخترع فرعاً غير موجود).
>
> **لماذا ليس اختيارياً**: التعيين غير قابل للقراءة بدونه. «يعمل في فرع طرطوس» يُقرأ كعمل قائم حتى بعد إغلاق الفرع، ولا وسيلة أخرى لدى العميل ليعرف. الصف مضموم أصلاً بـ`leftJoin` لجلب الاسم، فالكلفة صفر.
>
> **تحقق حيّ (2026-08-05)**: طاقم «فرع طرطوس» (مغلق مؤقتاً) → `branch_status: "temporarily_closed"` · السوبر أدمن (غير مقيّد) → `null`.

> **⚠️ «آخر موظف مؤهل» صار تحذيراً لا حاجزاً (2026-08-12)** — `409 last_qualified_staff` يُعاد كما كان، لكن **إعادة الإرسال بـ`force: true` تمرّ**. السبب: «أُقيل هذا الموظف من منصبه» لم يكن له جواب إطلاقاً غير اختراع بديل أولاً، و«هذا المنصب يجب أن يبقى مشغولاً» قرار توظيف يخصّ الأدمن لا قاعدة يخترعها النظام. الرفض المطلق كان يحبس الأدمن أمام موظف يريد إنهاء تعيينه فعلاً.
>
> الرد يحمل `data` تُغني عن تخمين العميل:
>
> ```json
> { "status": false, "code": 409,
>   "data": { "message_key": "last_qualified_staff", "overridable": true,
>             "role_id": 3, "role_name": "مدير الفرع",
>             "branch_id": 7, "branch_name": "فرع حلب" } }
> ```
>
> **`overridable` ليس زينة**: هو الفرق بين تحذير يعرض «أنهِ على أي حال» وبين رفض لا يعرضه — والاثنان 409، فمطابقة النص المترجم لتمييزهما تنكسر بأول تعديل صياغة.
>
> **والاستثناء الوحيد الذي لا يفتحه `force`: `409 last_system_role_holder`** (`overridable: false`) — يُرمى حين يكون هذا آخر شخص فعّال يحمل `users.access` (أو مظلّته `users.manage`) (بعد استبعاد تعييناته الأخرى التي قد تمنحها). ليست قاعدة توظيف بل قفل: بلا حامل واحد لهذه الصلاحية لا يبقى **من يعيدها**، والإصلاح الوحيد كتابة مباشرة بقاعدة البيانات.
>
> **ولماذا صلاحية لا فئة؟** لأن المحورين توقّفا عن التطابق: `مدقق` فئته `system` ولا يقفل شيئاً بمغادرته (صلاحياته قراءة فقط)، ودورٌ مخصَّص يحمل `users.access` لم يكن ضمن `GUARDED_ROLE_CATEGORIES` إطلاقاً ويقفل الجميع. الفئة تقرّر **بماذا يُحذَّر**، والصلاحية تقرّر **ما لا يُسمح به**.
>
> **يُسجَّل بالتدقيق**: `forced_last_holder: true` يُكتب بديف `assignment.end`/`assignment.transfer` **حين يحدث فقط** — وهو الحقل الذي يجيب لاحقاً عن «من قرّر أن الفرع يعمل بلا مدير».
>
> ---
>
> **التحذير نفسه (متى يُرمى أصلاً) يسري على الأدوار البنيوية بالفروع العاملة فقط** (محسوم 2026-08-04):
>
> | فئة الدور | يُحذَّر؟ | لماذا |
> |---|---|---|
> | `management` (مدير الفرع) | ✅ | المسؤول عن الفرع — فرع بلا مدير لا أحد يقرر فيه |
> | `system` (المدير العام/مدقق) | ✅ | سلطة على مستوى المنظمة |
> | `operational` · `financial` · `external` | ❌ **حرّة** | تُغيَّر وتُنقَل وتُنهى بلا تحذير — لا شيء يُفقد، التعيين يُغلق (`valid_to`) ولا يُحذف |
>
> **لماذا لم تعد موحَّدة**: قرار 2026-07-09 رفض تقسيماً **وظيفياً** («إنتاجي» مقابل «بيعي») وكلاهما `operational`. هذا تقسيم **بنيوي** (مسؤول مقابل طاقم) — محور مختلف. تطبيق الحاجز على كل الأدوار كان يجعل أي دور يُدخَل إلى فرع التزاماً دائماً: تُضيف «خدمة العملاء» لفرع فلا تستطيع إزالتها أبداً. يُحذَّر عند `transfer`/`end` إذا لم يوجد حامل آخر (`users.status = active`، تعيين فعّال) لنفس `(role_id, branch_id)` — وهذا مقصود: التنبيه إلى أن طابور الفرع قد يبقى بلا أحد مؤهل لإكماله (`users_roles.md` §Scenarios)، والقرار للأدمن عبر `force`. والتحذير **لا يُرمى أصلاً إذا كانت حالة الفرع ليست `active`** (`temporarily_closed` أو `closed`)، لأن الفرع المتوقف لا طابور له، ولأن تطبيقه هناك يقفل مسار الإغلاق الموثّق (§Flow.2): الإغلاق النهائي يشترط تصفية كل التعيينات، وآخر حامل لأي دور ما كان ليُصفّى أبداً. التعيينات غير المقيّدة (`branch_id IS NULL`) تبقى محكومة بالحاجز دائماً — لا فرع لها لتُعفى بحالته.
>
> **مسار إفراغ فرع:** حوِّل حالته إلى `temporarily_closed` أولاً → انقل/أنهِ تعييناته → ثم `closed`.

> **`POST /users/:userId/role-assignments` يفتح تعييناً إضافياً، ولا يمسّ القائم.** الشخص قد يحمل أكثر من دور، أو نفس الدور بأكثر من فرع — وهذا المسار الوحيد لإضافة موقع بلا التخلّي عن الآخر (النقل يُغلق الحالي). يُرفض بـ`409 assignment_duplicate` لو كان يحمل نفس `(role_id, branch_id)` فعلاً؛ الفحص بالـservice ليقرأ الرفض كقاعدة لا كانهيار، والضمان الحقيقي هو الفهرس الفريد الجزئي بالقاعدة (يغطي التسابق).
>
> **هذا أيضاً مخرج الرفض بـ`last_qualified_staff`**: الحارس يُرفَع بمجرد وجود حامل ثانٍ لنفس `(role_id, branch_id)`، وهذا الـendpoint هو ما يُنشئه.

> **`POST /users/:userId/role-assignments` هو أداة تشغيل الفرع الفارغ.** الفرع بلا طاقم مشكلة **تنسيب** لا **توظيف** — والمنظمة غالباً تملك أشخاصاً بلا انتماء (`?unassigned=true`). لذلك تعرض لوحة معالجة الفرع بالفرونت «إسناد موظف موجود» **قبل** «إنشاء موظف جديد»: إنشاء حساب يخترع شخصاً غير موجود. الجسم `{ role_id, branch_id }` و`branch_id: null` تعني وصولاً غير مقيّد لكل الفروع.

> **`search` متاح الآن على القوائم الثلاث** (2026-08-04): `GET /users` (الاسم الكامل + الإيميل + الهاتف) · `GET /branches` (الاسم + العنوان) · `GET /roles` (الاسم). كلها بنفس العقد: نص حرّ، `trim`، حد 150 حرفاً، والفراغ الصرف = غياب.
>
> **الهروب إلزامي وموحَّد** عبر `core/db/like-term.ts` — `%` و`_` مُهرَّبان بمكان واحد. بلا ذلك، من يكتب `%` يطابق كل الصفوف ويستنتج أن البحث معطَّل لا أن مدخله خاص.
>
> **تحقق حيّ (2026-08-04)**: فروع «حلب» → ٣ · «شارع» (بالعنوان فقط، غير موجود بأي اسم) → ٧ · أدوار «مدير» → ٢ · «موظف» → ٤ · `%` → ٠ بالثلاثة. والبحث داخل طابور التسجيل يُضيّقه (٤ → ١) **ولا يوسّعه** خارج `pending_approval` — الحالة مفروضة بالـcubit وتُعاد بكل نداء.

### Roles — `/api/v1/roles`

| Method | Path               | الحماية | ملاحظة                                                                                                    |
| ------ | ------------------ | --- | --------------------------------------------------------------------------------------------------------- |
| GET    | `/`                | 🔑 `roles.view` | قائمة مُصفّحة (بدون `permissions` بالعنصر)                                                                |
| GET    | `/self-registerable` | 🌐 **عام — بلا مصادقة** | **كتالوج التسجيل الذاتي** — أدوار فعّالة خارج فئة `system`، غير مُصفّحة، بلا `permissions`. المسار **مسجَّل قبل `/:id`** بالراوتر وإلا ابتلعه ورفضه كـid غير رقمي |
| GET    | `/:id`             | 🔑 `roles.view` | دور واحد مع `permissions` كاملة + **`active_holders_count`** (عدد الأشخاص الفعّالين المميَّزين الذين يحملونه) |
| POST   | `/`                | 🔑 `roles.edit` | إنشاء دور — اسم فريد إلزامي، تحذير-موقف لو نفس مجموعة الصلاحيات لدور فعّال موجود (تجاوز بـ`force: true`). **يقبل `level` اختيارياً** (2026-08-05) |
| PATCH  | `/:id`             | 🔑 `roles.edit` | **إعادة تسمية و/أو تغيير الفئة** — حقل واحد على الأقل إلزامي. يُرفض تسمية دور Super Admin (`super_admin_role_immutable`)، والاسم المكرر 409 `role_name_taken`. `level` **ليس** هنا — له مسار خاص أدناه |
| PUT    | `/:id/permissions` | 🔑 `roles.edit` | استبدال كامل لصلاحيات الدور — رجعي فوري على كل المعيّنين، يُسجَّل بـAudit Log لو لمس صلاحية `isSensitive`. **يرفع نفس تحذير تطابق مجموعة الصلاحيات** الذي يرفعه الإنشاء (تجاوز بـ`force: true`) |
| PUT    | `/:id/level`       | 🔑 `roles.edit` + Super Admin | **Super Admin حصراً** (فحص إضافي بالـservice نفسه فوق `requirePermission`) — تعديل `level` خارج فحص المستوى النسبي المعتاد (سد ثغرة تصعيد الصلاحيات) |
| POST   | `/:id/deactivate`  | 🔑 `roles.edit` | تعطيل (لا حذف) — يُرفض لو فيه تعيينات فعّالة، أو لو الدور Super Admin                                     |
| GET    | `/:id/holders`     | 🔑 `users.view` | من يحمل الدور الآن — صف لكل تعيين فعّال، مُصفَّح. **`users.view` لا `roles.view`**: الحمولة قائمة أشخاص، وقراءة الدور غير قراءة من يحمله — نفس الحد الذي يرسمه `GET /branches/:id/staff` |
| DELETE | `/:id`             | 🔑 `roles.edit` | حذف صلب — مسموح فقط إن لم يُشِر إليه أي تعيين **قط**. «لا أحد يحمله الآن» ليس الشرط (ذاك هو التعطيل أو الأرشفة). `409 role_has_history` أو `403 role_system_default_undeletable` |
| POST   | `/:id/archive`     | 🔑 `roles.edit` **+** `records.archive` | **أرشفة (2026-08-13)** — المخرج الذي لا يستطيع الحذف تقديمه: يُخفي دوراً **حُمِل فعلاً** ولا يُتلف شيئاً. الشرط: صفر تعيين **مفتوح** أياً كانت حالة الحامل. لا يلمس `is_active`. `409 role_has_active_holders` · `403 role_system_default_unarchivable`. **متكرِّرة بلا أثر** (idempotent) |
| POST   | `/:id/unarchive`   | 🔑 `roles.edit` **+** `records.archive` | استرجاع — يمسح `archived_at` ولا شيء غيره |
| POST   | `/:id/reactivate`  | 🔑 `roles.edit` | **إعادة تفعيل** — نظير التعطيل. يخضع لنفس فحص المستوى النسبي كإنشاء دور (إحياء دور عالي السلطة = نفس المنح). `409 role_already_active` لو فعّال أصلاً |

> **الأرشفة ليست التعطيل، والفرق ليس تفضيلاً**: الدور المعطَّل يبقى **بالقائمة** تحت فلتر «معطَّل» لأن إحياءه اعتيادي؛ والمؤرشف يغيب عن القائمة كلها. وأي كتابة على دور مؤرشف تُرفض `409 role_archived` (تسمية · فئة · صلاحيات · مستوى · تعطيل · إعادة تفعيل): تعديل دور لا تعرضه أي شاشة نتيجةٌ لا يستطيع أحد مراجعتها، وأخطر صوره — إعادة تفعيل دور مؤرشف — كانت ستُعيد دوراً غير مرئي إلى الخدمة. و`GET /roles?archived=true` يعرض **المؤرشف وحده** لا المؤرشف مضافاً للحيّ.

> **لماذا `GET /roles/self-registerable` عام (2026-08-11)**: `POST /users/register` **يشترط** `requested_role_id`، ومن يملأ نموذج التسجيل لا يملك جلسة يقرأ بها `GET /roles` (`roles.view`). فكان منتقي الدور بشاشة إنشاء الحساب **فارغاً ومعطَّلاً دائماً** — والنموذج لا يكتمل إطلاقاً، بلا أي رسالة تفسّر السبب: الطلب يرجع 401، و`AuthInterceptor` يتجاهله لغياب توكن أصلاً، فتبقى القائمة فارغة صامتة.
>
> **ولماذا `system` مستثناة**: تلك فئة التزويد الداخلي (المدير العام · مدقق) — تُمنَح من الأدمن ولا يُتقدَّم لها. و**نفس الشرط مفروض بالكتابة** (`assertSelfRegisterable` بـ`users.service.ts`، على التسجيل وإعادة الإرسال معاً) بـ`422 role_not_self_registerable`: كتالوج لا يفرضه مسار الكتابة زينة، وجسمُ طلب مُلفَّق كان يضع بطابور المراجعة سطراً لا وجود له إلا ليُرفض.
>
> **الشكل المُرسَل هو `WireRole` نفسه** لا شكل مقتضب — عقد واحد، موديل واحد بالعميل، منتقٍ واحد. وما تستطيعه الأدوار يبقى محجوباً كما هو: `permissions` غائبة هنا تماماً كغيابها بـ`GET /roles`، و`GET /permissions` يبقى محروساً.
>
> **ونفس القصة للفرع (2026-08-16)** — `GET /branches/self-registerable` عام لنفس السبب حرفياً، و`requested_branch_id` صار يُتحقَّق منه بالكتابة (`assertRequestableBranch`، على التسجيل وإعادة الإرسال معاً) بـ`404` للمعدوم و`422 branch_not_self_registerable` للمؤرشف/المغلق نهائياً. **لم يكن يُتحقَّق منه إطلاقاً**: كان يُخزَّن من الجسم بلا أي بحث، فيمرّ المعرّف عبر التحقق وعبر طابور المراجعة، ثم ينفجر عند `decideRegistration` حيث يصير الفرع تعييناً — خطأ مفتاح أجنبي أو `branch_archived`. الأدمن يقرأ رفضاً عن حقل لم يملأه، بطلب لا يستطيع تصحيحه، لمتقدّم انتظر أياماً. **والغياب يبقى مشروعاً**: منصب بلا فرع منصب حقيقي لا قيمة ناقصة.

> **لماذا لا يُعاد تسمية دور Super Admin**: `SUPER_ADMIN_ROLE_NAME` يُقارَن كنص خام بـ`roles.name` في الحراس التي تقرر من يعدّل مستوى دور ومن يُعدّ الحساب الجذري المحمي (`users.service.ts`). إعادة التسمية لا تُفشِل شيئاً — تجعل تلك البحوث ترجع فارغاً، أي **تُعطّل** الفحوص بدل أن تُسقطها. لا شيء آخر يُعنوَن بالاسم، فبقية الأدوار المزروعة تُعاد تسميتها بحرية.
>
> **لماذا الفئة قابلة للتعديل**: هي التي تقرر انطباق حارس «آخر موظف مؤهل» (`management`/`system` محروستان). إخراج دور منهما **يُرخي** تلك الحماية فعلاً — لذلك يُسجَّل بالقيمتين القديمة والجديدة بـAudit Log، ويتطلب `roles.edit` + تفوّق المستوى على الدور المُعدَّل.

**`POST /`** body:

```json
{
  "name": "Custom Role",
  "category": "operational",
  "permission_keys": ["inventory.view"],
  "level": 20,
  "clone_from_role_id": 5,
  "force": false
}
```

> **`level` بالإنشاء مقابل `PUT /:id/level` للتعديل — لماذا بوابتان مختلفتان**: `assertActorOutranks` يرفض أصلاً مستوىً مساوياً لمستوى المنفّذ أو أعلى، فإنشاء دور **تابع** محدود ذاتياً ويكفيه `roles.edit`. أما تعديل مستوى دور **قائم** فليس محدوداً ذاتياً: الدور المُعدَّل قد يكون دور المنفّذ نفسه، فيمرّ الفحص قبل الترقية التي يُجيزها — ولذلك يبقى ذاك حكراً على المدير العام. قبل هذه الإضافة كان `level` بالغاً **فقط** باستنساخ دور يحمل واحداً، أي أن بناء أول تسلسل هرمي كان مستحيلاً.
>
> **`clone_from_role_id` يستنسخ الصلاحيات فقط إن كانت `permission_keys` فارغة.** العميل يملأها محلياً (ليرى المستخدم ما سيُنشئه ويعدّله قبل الإرسال) ويرسلها، ويبقى `clone_from_role_id` مرسَلاً لتسجيل المصدر بـAudit Log. **تحذير مثبت بالتجربة**: `GET /roles` **لا يُرجع `permissions`** (تفادي N+1)، فقراءتها من صف قائمة تُعطي `null` دائماً — وهي بالضبط الطريقة التي شُحن بها الاستنساخ معطَّلاً: نسخ صفر صلاحية بلا أي خطأ. المصدر يُجلب بـ`GET /roles/:id`، لا من صف القائمة.

> **`is_super_admin` بردَّي `POST /users/login` و`GET /users/me` (2026-08-05)**: بوليان يقول إن صاحب الجلسة يحمل دور المدير العام فعلاً. **لا يعبّر عنه أي مفتاح صلاحية** — وعمليتان محكومتان به (`PUT /roles/:id/level` والحساب الجذري المحميّ). بدونه يضطر العميل إما لإخفاء زر يحتاجه المدير العام وحده، أو لعرضه على الجميع ثم رفضهم بعد الضغط — نمط «دعه يختار ثم أخبره أنه ممنوع» الذي وُجد `?assignable=true` لتفاديه. يُحسب بنفس الدالة التي يستدعيها الحارس، فلا يعيد العميل صياغة أي قاعدة. ويُرسَل بردّ `login` أيضاً لا بـ`/users/me` وحده: العميل يبني جلسته من ردّ الدخول، وزرٌّ يظهر بعد إعادة تشغيل واحدة يُقرأ كعطل لا كتأخير.

### Branches — `/api/v1/branches`

| Method | Path   | الحماية | ملاحظة                  |
| ------ | ------ | --- | ----------------------- |
| GET    | `/`    | 🔒 مسجّل دخول | قائمة مُصفّحة. `?archived=true` يعرض **المؤرشف وحده** |
| GET    | `/self-registerable` | 🌐 **عام — بلا مصادقة** | **كتالوج التسجيل الذاتي** (2026-08-16) — كل فرع غير مؤرشف وغير `closed`، غير مُصفّح، بلا أعداد §16. `temporarily_closed` **مشمول عمداً**: الفرع متوقَّع عودته، والمنتقي يعرض حالته بجانب اسمه. المسار **مسجَّل قبل `/:id`** وإلا ابتلعه ورفضه كـid غير رقمي |
| GET    | `/:id` | 🔒 مسجّل دخول | فرع واحد أو 404 — ومعه حقول §16 (`is_deletable`/`is_archivable` + الأعداد) |
| GET    | `/:id/staff` | 🔑 `users.view` | طاقم الفرع مُصفّحاً — صف لكل تعيين فعّال (أدناه) |
| POST   | `/`    | 🔑 `branches.manage` | إنشاء فرع. الاسم فريد: `409 branch_name_taken`، و**`409 branch_name_taken_by_archived`** حين يحمل الاسمَ فرعٌ مؤرشف — مفتاحان لا واحد، لأن خطوة القارئ التالية تختلف: الأول «اختر اسماً آخر»، والثاني «الفرع الذي تعيد إنشاءه موجود، استرجعه بتاريخه بدل بنائه فارغاً» |
| PATCH  | `/:id` | 🔑 `branches.manage` | تعديل بيانات/حالة. يُرفض على فرع مؤرشف `409 branch_archived` |
| DELETE | `/:id` | 🔑 `branches.manage` | **حذف صلب (2026-08-13)** — مسموح فقط إن لم يُشِر إليه أي تعيين ولا أي ملكية **قط**، وليس الفرع الافتراضي. `409 branch_has_history` · `403 branch_is_default`. هذا هو جواب «أضفت فرعاً وخربطت وبدي أحذفه» |
| POST   | `/:id/archive`   | 🔑 `branches.manage` **+** `records.archive` | **أرشفة (2026-08-13)** — للفرع الذي **له ماضٍ**: يختفي من كل قائمة ومنتقٍ وفلتر، وصفوف التاريخ تبقى تشير لفرع حقيقي باسم حقيقي. الشرط: صفر تعيين مفتوح وصفر ملكية مفتوحة. يكتب `status: "closed"` معه. `409 branch_has_active_assignments` · `409 branch_has_active_ownerships` · `403 branch_is_default`. متكرِّرة بلا أثر |
| POST   | `/:id/unarchive` | 🔑 `branches.manage` **+** `records.archive` | استرجاع — يعود `closed` لا `active`: إعادة الفتح قرار مستقل بعواقبه (يصير قابلاً للإسناد)، وضمّه لـ«أظهِره» كان سيجعل ضغطة واحدة تفعل شيئين أحدهما غير معلَن |

> **لماذا الفرع الافتراضي مستثنى من المخرجين معاً**: `is_default` هو ما يقع عليه النظام حين يلزم فرعٌ ولم يُسمَّ أحد، فإزالته — إتلافاً أو إخفاءً — تكسر ذلك الاحتياط بلا أي خطأ لحظة القرار، بل لاحقاً وفي مكان آخر.


> **فلاتر `GET /users`** — كلها اختيارية، والغياب = بلا فلترة:
>
> | Param | النوع | المعنى |
> |---|---|---|
> | `status` | enum | `pending_approval` · `active` · `suspended` · `rejected` · `disabled` |
> | `is_admin` | bool | الإداريون فقط |
> | `archived` | bool | **(2026-08-13)** `true` = **المؤرشف وحده**. الغياب = الحيّ وحده. **لا يغطيه `status`**: الأرشفة تفرض `disabled`، فبدون هذا الفلتر كان كل حساب متقاعد يعود للظهور لحظة فلترة «معطَّل» — وهو الفلتر الذي يستعمله الأدمن ليراجع من هو خارج الدفاتر |
> | `requested_role_id` | int | الدور المطلوب بطلب التسجيل — يخدم طابور المراجعة |
> | `unassigned` | bool | `true` = بلا أي تعيين فعّال · `false` = من يحمل تعييناً — استعلامان مختلفان، والغياب ثالث |
> | `excluding_role_id` | int | **(2026-08-12)** استبعاد من يشغل هذا الدور **بالفرع أدناه** — فلتر «من يصلح لهذا المنصب» |
> | `excluding_branch_id` | int | نصف الزوج. **غيابه = المنصب غير المقيّد** (`branch_id IS NULL`) لا «أي فرع». يُتجاهَل بلا `excluding_role_id` |
> | `search` | string | **(2026-08-04)** مطابقة حرة على الاسم الكامل والإيميل والهاتف |
>
> **الزوج معاً، ولا نصف منه وحده** — وهذا ليس تفصيلاً تنفيذياً بل هو القاعدة:
>
> | لو استُبعِد بـ… | لاختفى | ولماذا هذا خطأ |
> |---|---|---|
> | الدور وحده | مدير كل فرع آخر | هؤلاء **أفضل** المرشّحين لإدارة فرع ثانٍ، لا أسوأهم |
> | الفرع وحده | كل من يعمل بالفرع | الشخص قد يأخذ دوراً **ثانياً مختلفاً** بنفس الفرع |
> | الزوج ✅ | من كان الإسناد له تكراراً حرفياً | وهم بالضبط من يردّهم الخادم بـ`409 assignment_duplicate` |
>
> والمقارنة بـ`IS NOT DISTINCT FROM` لا `=`: المنصب غير المقيّد هو `branch_id IS NULL`، و`= NULL` لا يتحقق أبداً بـSQL — فكان سيستبعد صفر أشخاص ويظل المنتقي يعرض تكراراً يرفضه الخادم بعده.
>
> **يحلّ محل `unassigned=true` كفلتر للمنتقي**: ذاك يعرض من لا ينتمي لأي مكان — قائمة شبه فارغة بمنظمة عاملة — ويخفي كل نقل مشروع.
>
> **و`GET /users` يحمل `current_posts` بكل صف** (2026-08-12): `[{role_id, role_name, branch_id, branch_name}]` لكل تعيين فعّال، و`[]` تعني «لا ينتمي لمكان» وتُرسَل صراحةً لا تُحذف. استعلام **واحد إضافي للصفحة** لا لكل صف. السبب: الاسم وحده لا يجيب عن سؤال المنتقي — إسناد شخص بلا منصب لا يكلّف شيئاً، وسحب كاشير فرع آخر يكلّف ذاك الفرع كاشيراً، والاثنان يبدوان متطابقين بلا هذا الحقل.
>
> **`search` مطابَق على الاسم المُدمَج** (`first_name || ' ' || last_name`) لا على العمودين منفصلين — وإلا لما وجد «أحمد العبدالله» أبداً، لأن الاسم مخزَّن مجزّأً. و`%`/`_` مُهرَّبان: بلا ذلك، من يكتب `%` يطابق كل الصفوف ويظن أن البحث معطَّل. الفراغ الصرف يُعامَل كغياب.
>
> **تحقق حيّ (2026-08-04)**: «العبدالله» → ٣ نتائج · «إيمان» → ١ · `09357` → ١ · `%` → ٠ (لا يطابق الكل) · `unassigned=true` → ٦ · `is_admin=true` → ١.

> **⚠️ تغيير كاسر (2026-08-04)** — `GET /users` و`GET /users/:id` و`GET /users/:userId/role-assignments` انتقلت من 🔒 `requireAuth` إلى 🔑 `users.manage` — ثم إلى `users.view`/`users.access` مع تفصيل الكتالوج (2026-08-16). كانت الحمولة دليل المنظمة كاملاً متاحاً لأي حامل توكن صالح (`production_readiness.md` §A1). `GET /users/me` **لم يتغيّر** — بيانات المستخدم عن نفسه تبقى مفتوحة.
>
> **سجل التدقيق**: كل طفرة بموديول `identity` تُسجَّل الآن بـ`audit_log_entries` (١٥ إجراءً، الكتالوج بـ`services/audit-actions.ts`). أي endpoint جديد يُحدِث تغييراً يجب أن يستدعي `auditService.record` — الفاعل يصل عبر `buildActorContext(req, requireActorId(req))` من الـcontroller.
| POST   | `/`    | 🔑 `branches.manage` | إنشاء فرع               |
| PATCH  | `/:id` | 🔑 `branches.manage` | تعديل بيانات/حالة الفرع — الانتقال إلى `closed` مشروط (أدناه) |

> **`GET /:id/staff` — محمي بـ`users.view` لا `branches.manage`.** الحمولة قائمة أشخاص (اسم، إيميل، حالة حساب)، وقراءة سجل الفرع غير قراءة طاقمه — الصلاحية تتبع البيانات المكشوفة، نفس الحدّ الذي ترسمه كتلة `structure` باللوحة.
>
> الصف **مفتاحه التعيين لا المستخدم**: الشخص الواحد قد يحمل دورين بنفس الفرع، ودمجهما بصف واحد يُخفي الدور الثاني ويُفقد الواجهة `assignment_id` اللازم للنقل/الإنهاء. أصحاب الوصول غير المقيّد (`branch_id IS NULL`) **غير مشمولين** — ليسوا طاقم هذا الفرع، هم فقط غير محصورين بأي فرع.
>
> `user_status` مُرسَل عمداً: الحامل `disabled`/`suspended` يشغل الدور ولا يُنتِج شيئاً، فالفرع الذي يبدو مأهولاً قد يكون فارغاً فعلياً — والواجهة لا تستطيع إظهار هذا الفرق بلا هذا الحقل. (على البيانات الحيّة: «فرع اللاذقية - الزراعة» فيه 4 تعيينات، اثنان منها لحسابات معطَّلة.)
>
> ```json
> { "items": [ { "assignment_id": 62, "user_id": 67, "full_name": "…",
>     "email": "…", "user_status": "active", "role_id": 3,
>     "role_name": "مدير الفرع", "valid_from": "…" } ],
>   "page": 1, "limit": 15, "total": 1, "total_pages": 1 }
> ```
>
> 404 على فرع غير موجود بدل صفحة فارغة — «لا أحد في هذا الفرع» و«هذا الفرع غير موجود» جوابان مختلفان، والشاشة التي تعرض الأول مكان الثاني تدعو لتعيين موظف على فرع وهمي.

> **`status: 'closed'` هو الانتقال الوحيد ذو شرط مسبق.** يُرفض بـ409 `branch_has_active_assignments` ما دام للفرع أي تعيين فعّال (`users_roles.md` §Flow.2: الأدمن يحسم مصير كل موظف — نقلاً أو إنهاءً — قبل الإغلاق النهائي). `temporarily_closed` بلا شرط (§Flow.1: التوقف المؤقت لا يمس التعيينات وترجع تلقائياً عند إعادة التفعيل).

### Dashboard — `/api/v1/dashboard`

| Method | Path | الحماية | ملاحظة |
| ------ | ---- | --- | ------ |
| GET    | `/`  | 🔑 `dashboard.view` | إحصائيات مجمّعة لواجهة لوحة التحكم — كل بلوك أعلى-مستوى (`users`/`branches`/`roles`/`charts`/`structure`/`signals`) يظهر فقط لو المستخدم يملك أيضاً صلاحية الموديول المطابقة (`users.view`/`branches.manage`/`roles.view`) — نفس رؤية شاشة القائمة التي تفتحها كل بطاقة، وليس فحصاً منفصلاً. البلوك الغائب لا يظهر بالـJSON إطلاقاً (وليس صفراً) |

**بوابة الصلاحيات لكل بلوك:**

| البلوك | يتطلب |
| --- | --- |
| `users` | `users.view` |
| `branches` | `branches.manage` |
| `roles` | `roles.view` |
| `charts.users_per_branch` | `users.view` + `branches.manage` |
| `charts.users_per_role` | `users.view` + `roles.view` |
| `structure` | `users.view` **و** `branches.manage` معاً — يغطي محورَي علاقة (فرع × دور) فلا يكفيه أحدهما |
| `signals` | `users.view` **أو** `branches.manage` — كل إشارة تُدرَج فقط إن توفّرت صلاحية مصدرها |

#### قواعد قراءة إلزامية

1. **`structure.people` ≠ `structure.assignments`** — الأول `countDistinct(user_id)` والثاني عدد صفوف التعيين. اختلافهما مشروع (شخص بدورين، أو يعمل بفرعين)، ويجب على أي عميل عرضهما **باسمين مختلفين** ولا يقدّم أحدهما مكان الآخر.
2. **الفرع بلا طاقم موجود لا محذوف** — `structure.branches[]` مبني بـ`leftJoin` من جدول الفروع، فالفرع بلا تعيينات نشطة يعود بـ`people: 0` و`roles: []`. (سلوك `charts.users_per_branch` صار مطابقاً — كان `innerJoin` يُسقطه سابقاً.)
3. **الخلية الغائبة فجوة، لا بيانات ناقصة** — `structure.branches[].roles[]` يحمل الأدوار المشغولة فعلاً فقط. المحور الكامل للأدوار بـ`structure.roles[]`، وأي زوج (فرع، دور) غير موجود = **صفر حقيقي**.
4. **أصحاب الوصول غير المقيّد (`branch_id IS NULL`) خارج كل فرع** — لا يظهرون في `branches[]` ولا في `charts.users_per_branch` بحكم التعريف، ويُبلَّغ عنهم عبر `structure.unrestricted_people` وحدها.
5. **`signals[]` تحمل `code` وأرقاماً فقط — لا نصوص معروضة.** التطبيق ثنائي اللغة ويترجم من `code`؛ أي نص من الخادم لن يتبع تبديل اللغة بالجهاز. مرتّبة تنازلياً بالخطورة.
6. **`entity_id` و`secondary_id` للتنقّل الموجَّه.** الكيان المركّب (`branch_role`) يحمل معرّفَين: `entity_id` للفرع و`secondary_id` للدور — ليفتح العميل **الكيان نفسه** لا قائمة كاملة.
   > **حُلَّت جزئياً:** أُضيف `unassigned` إلى `usersFilterQuerySchema` (`?unassigned=true` → المستخدمون بلا أي تعيين فعّال، عبر `NOT EXISTS` مرتبط لا `join` — الـjoin يكرّر صف المستخدم لكل تعيين ويُفسد حجم الصفحة والعدّ الكلي). لذلك `user_unassigned` صارت تفتح **القائمة المفلترة نفسها** التي تعدّها.
   >
   > **ما زال ناقصاً:** لا محدِّد لـ«وصول غير مقيّد» (`branch_id IS NULL`) ولا فلترة بالفرع أو بالدور المُسنَد. لذلك `unrestricted_access` **بلا وجهة تنقّل** عمداً — فتح القائمة كاملةً يوهم بفلترة لم تحدث.

#### كتالوج `signals[].code`

| code | severity | entity_type | معنى `metric` |
| --- | --- | --- | --- |
| `branch_unstaffed` | `critical` | `branch` | دائماً 0 — فرع نشط بلا أي تعيين فعّال |
| `user_unassigned` | `critical` | `user` | عدد الحسابات النشطة بلا أي تعيين فعّال |
| `branch_closed_but_staffed` | `serious` | `branch` | عدد الأشخاص الباقين بفرع مغلق/معلّق |
| `role_unheld` | `warning` | `role` | دائماً 0 — لا يحمل الدور أحد في أي فرع (مفصول عن `role_undercovered` لأنه اكتشاف مختلف: انعدام لا تفاوت) |
| `role_undercovered` | `warning` | `role` | عدد الفروع التي يغطيها الدور (بين 1 و نصف الفروع النشطة) |
| `role_single_holder` | `warning` | `branch_role` | دائماً 1 — `entity_id`/`entity_label` الفرع، و`secondary_id`/`secondary_label` الدور |
| `unrestricted_access` | `warning` | `org` | عدد الأشخاص بوصول لكل الفروع |
| `pending_stale` | `warning` | `user` | عمر أقدم طلب معلّق بالأيام (العتبة 7) |
| `branch_concentration` | `info` | `branch` | نسبة مئوية من أشخاص المنظمة (العتبة > 40%) |

> `branch_concentration` تقيس **حصّة الفرع من الأشخاص**، لا عبء عمله — لا يوجد أي مقياس عمل بالـschema الحالي. إشارة `branch_overloaded` حقيقية (عمل ÷ طاقم) تُضاف عند بناء موديول الطلبات/المهام.

**`GET /`** response (`data`) — مستخدم يملك كل الصلاحيات:

```json
{
  "users": { "total": 128, "pending_approval": 5, "unassigned": 3, "oldest_pending_days": 11 },
  "branches": { "total": 4, "unstaffed": 1 },
  "roles": { "total": 9 },
  "charts": {
    "users_per_branch": [{ "label": "فرع حلب", "value": 0 }],
    "users_per_role": [{ "label": "مدير الفرع", "value": 12 }]
  },
  "structure": {
    "people": 120,
    "assignments": 137,
    "unrestricted_people": 4,
    "branches": [
      {
        "id": 1, "name": "الفرع الرئيسي", "status": "active", "people": 48,
        "roles": [{ "id": 3, "name": "بائع", "people": 30 }]
      },
      { "id": 3, "name": "فرع حلب", "status": "active", "people": 0, "roles": [] }
    ],
    "roles": [{ "id": 3, "name": "بائع" }, { "id": 5, "name": "محاسب" }]
  },
  "signals": [
    {
      "code": "branch_unstaffed", "severity": "critical", "entity_type": "branch",
      "entity_id": 3, "entity_label": "فرع حلب",
      "secondary_id": null, "secondary_label": null, "metric": 0
    },
    {
      "code": "role_single_holder", "severity": "warning", "entity_type": "branch_role",
      "entity_id": 1, "entity_label": "الفرع الرئيسي",
      "secondary_id": 5, "secondary_label": "محاسب", "metric": 1
    }
  ]
}
```

**مثال ثانٍ** — مستخدم يملك `users.view` + `roles.view` فقط (بلا `branches.manage`): تختفي `branches` و`structure` و`charts.users_per_branch` بالكامل، وتبقى إشارات `users` فقط:

```json
{
  "users": { "total": 128, "pending_approval": 5, "unassigned": 3, "oldest_pending_days": 11 },
  "roles": { "total": 9 },
  "charts": { "users_per_role": [{ "label": "مدير الفرع", "value": 12 }] },
  "signals": [
    {
      "code": "user_unassigned", "severity": "critical", "entity_type": "user",
      "entity_id": null, "entity_label": null,
      "secondary_id": null, "secondary_label": null, "metric": 3
    }
  ]
}
```

### Ownerships — `/api/v1/ownerships`

| Method | Path | الحماية | ملاحظة                                                                                         |
| ------ | ---- | --- | ---------------------------------------------------------------------------------------------- |
| GET    | `/`  | 🔒 مسجّل دخول | السجلات الفعّالة، فلترة اختيارية بـ`?branch_scope=`                                            |
| POST   | `/`  | 🔑 `ownerships.manage` | تسجيل نسبة ملكية — **منع صارم**: أي حفظ يجعل مجموع النسب الفعّالة للنطاق يتجاوز 100% يُرفض 422 |

### Audit Log — `/api/v1/audit-log`

| Method | Path | الحماية | ملاحظة                                                        |
| ------ | ---- | --- | ------------------------------------------------------------- |
| GET    | `/`  | 🔑 `audit_log.view` | قائمة مُصفّحة، فلترة اختيارية بـ`?user_id=`/`?target_entity=` |

### Localization — `/api/v1/languages`

> المصدر المعماري الكامل: [docs/reference/dynamic_localization.md](../../docs/reference/dynamic_localization.md) (Model 2 — نظامان متوازيان). **ar/en تبقيان compile-time بالفرونت ولا تُزرَعان أبداً بهذا الجدول** — هذا الموديول يخدم فقط أي لغة إضافية (مثال تنفيذي أول: `fr`).

| Method | Path                        | الحماية | ملاحظة                                                                                                     |
| ------ | --------------------------- | --- | ------------------------------------------------------------------------------------------------------------ |
| GET    | `/`                         | 🌐 عام (منذ 2026-09-21) | اللغات **الفعّالة فقط** — `code`/`name`/`is_rtl`/`version`. غير مُصفّحة عمداً (قائمة مرجعية صغيرة، نفس منطق `GET /permissions`). هذا ما يستطلعه التطبيق عند الإقلاع لمقارنة الإصدارات |
| GET    | `/:code`                    | 🔒 مسجّل دخول | لغة واحدة (شاشة إدارة فقط — يشمل اللغات المُعطَّلة أيضاً)، أو 404                                          |
| GET    | `/:code/translations`       | 🌐 عام (منذ 2026-09-21) | خريطة الترجمة الكاملة الحالية للغة: `{code, version, translations: {key: value}}` — **whole-file، بدون `since`/delta بهذا الإصدار الأول**. 404 لو الكود غير موجود **أو** اللغة معطّلة (نفس المعاملة، لا فرق للعميل) |
| POST   | `/`                         | 🔑 `localization.manage` | إضافة لغة ديناميكية جديدة — `code` فريد، يُرفض 409 لو مكرر                                                |
| PATCH  | `/:code`                    | 🔑 `localization.manage` | تعديل `name`/`is_rtl` فقط (لا يمس `version`/`is_active`)                                                  |
| PUT    | `/:code/translations`       | 🔑 `localization.manage` | **Upsert جزئي**: يضيف/يحدّث فقط المفاتيح المُرسَلة، لا يمس مفاتيح أخرى موجودة. أي استدعاء ناجح يرفع `version` رقماً واحداً دائماً — هذا هو إشارة إبطال الكاش التي يستطلعها `GET /` |
| POST   | `/:code/deactivate`         | 🔑 `localization.manage` | تعطيل (`is_active=false`) — لا حذف فعلي. اللغة تختفي فوراً من `GET /` وتُعامَل كـ404 بـ`GET /:code/translations` |

> **لماذا صار المساران عامَّين (2026-09-21)**: كانا `requireAuth` = **موظف فقط**. الضيف يطلبهما بكل إقلاع فيُرفض بصمت (لا ترجمات مخصّصة له أبداً)، والزبون يُرفض `401` فيقرؤه العميل جلسة منتهية ويُخرجه **بكل تشغيل**. نصوص واجهة التطبيق لكل زائر، وكلاهما يُرجع الفعّال وحده.

**`POST /`** body:

```json
{ "code": "fr", "name": "Français", "is_rtl": false }
```

**`PUT /:code/translations`** body:

```json
{ "translations": { "welcomeBack": "Bon retour", "login": "Connexion" } }
```

> **مستهلك حيّ منذ 2026-08-05**: `Features/admin/localization/` بالفرونت (شاشة «إدارة الترجمة»، محمية بـ`localization.manage`). كان هذا الـendpoint مبنياً **بلا أي مستدعٍ** منذ بناء موديول الترجمة، فكان الجدول يُصان يدوياً بملف البذرة وحده — ولذلك لم يكن لصلاحية تُنشأ عبر الـAPI أي طريق لتُسمّى.
>
> الشاشة ترسل **مفتاحاً واحداً** بكل حفظ. ولهذا الطابع الجزئي فحص دائم بـ`npm run smoke`: لو تحوّل هذا الـendpoint يوماً إلى استبدال كامل، لمحا كل حفظ بقيةَ اللغة **وأبلغ بالنجاح** — أسوأ أفراد عائلة «جواب معقول وخاطئ».

**`GET /:code/translations`** response (`data`):

```json
{ "code": "fr", "version": 2, "translations": { "welcomeBack": "Bon retour", "login": "Connexion" } }
```

> 🌐 عام = بدون توكن. 🔒 مسجّل دخول = `Authorization: Bearer <token>` صالح فقط، أي يوزر. 🔑 `<key>` = توكن صالح **و** المفتاح ضمن صلاحيات اليوزر الفعّالة (`requirePermission`, راجع §7.2).

### `GET /health`

فحص حياة بسيط، خارج نطاق `/api/v1` عمداً. رد: `{status:true, message:"OK", data:{uptime}}`.

> ✅ **Auth حقيقي مفعّل** (2026-07-23) — كل endpoint تتطلب "actor" (منشئ دور، مقرر تسجيل، ناقل تعيين...) تعمل الآن فعلياً: مرّر `Authorization: Bearer <token>` (من `POST /login`) وإلا `401 Unauthorized`. راجع §7 أعلاه لتفاصيل آلية التحقق (`core/middleware/auth.ts`).

---

## 17. حسابات الزبائن وطبقات الوصول (2026-09-20)

> التخطيط والقرارات: [`docs/reference/customer_accounts.md`](../../docs/reference/customer_accounts.md) §12–13.

### الدخول الموحَّد — `POST /users/login` يخدم كل الفئات

الشخص لا يعرف أنه «موظف» أو «زبون». الخادم يحلّ الفئة (realm) من البريد عبر جدول `account_emails` ويسلّم الطلب لدخول تلك الفئة. **الرد يحمل `account_type`** — هو ما يقرّر به العميل أين يهبط:

| `account_type` | جسم `data` |
|---|---|
| `staff` | نفس الشكل القديم تماماً (`user` · `token` · `session_id` · `permission_keys` · `is_super_admin`) + الحقل الجديد |
| `customer` | `{ account_type, customer: WireCustomer, token, session_id }` |

- توكن الزبون يبدأ بـ`c_` ويُحلّ بجدول جلسات الزبائن وحده. **توكن زبون على مسار موظفين = `401`** بلا أي شرط مكتوب — لأنه لا يوجد بجدول جلسات الموظفين.
- بريد مجهول وكلمة مرور خاطئة يعطيان نفس `401 invalid_credentials` بنفس الزمن.

### `WireCustomer`
`id · first_name · last_name · full_name · email · phone · image · status (active|suspended|disabled) · customer_type (retail|wholesale) · wholesale_status (pending|approved|rejected|null) · preferred_branch_id · email_verified · email_verified_at · created_at`

### Endpoints

| Method | Path | الحماية | ملاحظات |
|---|---|---|---|
| POST | `/customers/register` | عام + `registerRateLimit` | `201` بنفس شكل دخول الزبون (جلسة فوراً). الحساب `active` والبريد **غير موثَّق** إن كان التحقق مفعّلاً. لا حقل `customer_type`/`status` بالجسم عمداً |
| GET | `/customers/me` | `requireCustomer` | مسموح لغير الموثَّق |
| PATCH | `/customers/me` | `requireCustomer` | `first_name · last_name · phone · preferred_branch_id` (حقل واحد على الأقل). **`address` أُزيل 2026-09-21** — العناوين صارت قائمة بـ`/customers/me/addresses` |
| POST | `/auth/verify-email` · `/auth/resend-verification` · `/auth/change-password` · `GET/DELETE /auth/sessions…` · `POST /auth/refresh` · `POST /users/logout` | `requireSignedIn` | **تعمل على فئة التوكن** (موظف أو زبون) |
| POST | `/auth/forgot-password` · `/auth/reset-password` | عام | الفئة تُحلّ من البريد؛ بريد مجهول = no-op صامت كما كان |

### طبقات الوصول بالخادم

| الحارس | العلامة (`check:permissions`) | يمرّر |
|---|---|---|
| `publicRoute` | `public` | الضيف |
| `requireSignedIn` | `authenticated` | أي حساب |
| `requireCustomer` | `customer` | زبون (موثَّق أو لا) |
| `requireVerifiedCustomer` | `verified` | زبون ببريد موثَّق. غيره → `403` + `message_key: email_verification_required` (+`data.email_verified:false`) |
| `requirePermission(k)` | `permission` | موظف بصلاحية |

**`email_verification_required` مفتاح مخصّص لا 403 عام**: ردّ العميل الصحيح عليه فتح شاشة الرمز، لا عرض خطأ. **كل مسار شراء/طلب/طلب جملة يجب أن يحمل `requireVerifiedCustomer`** — ولا يمكن نسيان الحارس بالكامل لأن `check:permissions` يفشل على أي مسار بلا تصنيف.

### عناوين التوصيل — `/customers/me/addresses` (2026-09-21)

عدة عناوين للزبون، **واحد منها أساسي بالضبط** (فهرس فريد جزئي بالقاعدة). يستبدل عمود `customers.address` النصي: migration `0018` نسخت كل قيمة غير فارغة إلى عنوان أساسي (النص بـ`details`، و`area` فارغة) ثم حذفت العمود.

| Method | Path | الجسم | الرد |
|---|---|---|---|
| GET | `/customers/me/addresses` | — | `WireCustomerAddress[]` — الأساسي أولاً ثم الأحدث تعديلاً |
| POST | `/customers/me/addresses` | `area · details` (إلزاميان) + `kind? (home\|work\|other، افتراضي home) · label? · recipient_name? · recipient_phone? · landmark? · latitude? · longitude? · make_default?` | `201` + القائمة كاملة |
| PATCH | `/customers/me/addresses/:addressId` | أي حقل مما سبق عدا `make_default` (حقل واحد على الأقل) | القائمة كاملة |
| POST | `/customers/me/addresses/:addressId/make-default` | — | القائمة كاملة |
| DELETE | `/customers/me/addresses/:addressId` | — | القائمة كاملة |

كل المسارات `requireCustomer` (غير الموثَّق يُعِدّ عناوينه؛ الشراء هو ما ينتظر التوثيق).

- **كل كتابة تُرجع القائمة كاملة لا الصف**: علم الأساسي ينتقل بين الصفوف (أول عنوان · تعيين آخر · حذف الأساسي)، فرد بصفٍّ واحد يترك بالعميل `is_default` قديماً على صف لم يلمسه.
- **أول عنوان يصير أساسياً** مهما أرسل. **حذف الأساسي يُسلّم الصفة للأحدث تعديلاً** — عناوين بلا أساسي تعني دفع طلب بلا شيء مختار.
- `latitude`/`longitude` معاً أو لا شيء (`422`)، وبـPATCH يُستبدلان أو يُمسحان معاً. النص يبقى إلزامياً: عناوين كثيرة هنا تُعرف بمَعلَم لا بإحداثية.
- `recipient_*` لمن يطلب لشخص آخر؛ `null` = صاحب الحساب.
- الحد `10` ← `409 address_limit_reached` (+`data.limit`). عنوان لا يملكه الزبون = `404` كغير الموجود.
- **الطلب سينسخ العنوان لا يشير إليه** (لا FK من الطلبات) — فتعديل عنوان أو حذفه لا يغيّر مكان توصيل طلب سابق، ولهذا الحذف فعلي لا أرشفة.

`WireCustomerAddress`: `id · kind · label · recipient_name · recipient_phone · area · details · landmark · latitude · longitude (number|null) · is_default · created_at · updated_at`

### ما لا يزال مؤجَّلاً
الدخول بالجوال/OTP · طابور موافقة الجملة · حذف زبون (يجب أن يستدعي `accountEmails.release`).

### الفرع التلقائي بالموقع (2026-09-20)

`POST /branches/nearest` — **عام** (الضيف بلا جلسة). الجسم: `{ latitude?, longitude? }` (معاً أو لا شيء، وإلا `422`). الرد: `{ branch: WireBranch, resolved_by: "location" | "default", distance_km: number | null }`.

- بإحداثيات: أقرب فرع `active` غير مؤرشف **له إحداثيات**. بلا إحداثيات مرسَلة، أو بلا أي فرع موضوع على الخريطة: الفرع `is_default` مع `resolved_by: "default"`.
- لا فرع صالح أصلاً ← `404`.
- `WireBranch` صار يحمل `latitude` و`longitude` (`number | null`). ويقبلهما إنشاء الفرع وتعديله معاً؛ `null` على الاثنين يمسح الموضع.
- الإحداثيات لا تُخزَّن ولا تُسجَّل. (POST لهذا السبب: سجل الطلبات يكتب الـURL.)

### إدارة الزبائن — للموظف (2026-09-20)

| Method | Path | الصلاحية | ملاحظات |
|---|---|---|---|
| GET | `/customers` | `customers.view` | مُصفَّحة (`page`/`limit`) + `status` · `customer_type` · `email_verified` · `search` (اسم كامل أو بريد أو هاتف) · `sort_by` (`created_at`|`first_name`) · `sort_dir`. المؤرشفون مستبعَدون دائماً |
| GET | `/customers/:id` | `customers.view` | `WireCustomer` |
| POST | `/customers/:id/suspend` · `/disable` · `/reactivate` | `customers.manage` (حسّاس) | يردّ الحساب **بحالته الجديدة**. يسري **بأول طلب تالٍ للزبون** (الوسيط يعيد `canSignIn` بكل طلب ويُسقط جلسة المرفوض) فلا مسح جلسات هنا. إعادة تطبيق الحالة الحالية = `200` بلا كتابة ولا تدقيق |

كل فعل يُدقَّق بـ`customer.suspend|disable|reactivate` على الهدف `customer:<id>` — بسجل **الموظفين** (`audit_log_entries`) لأن الفاعل موظف؛ أما نشاط الزبون نفسه فبـ`customer_activity_log`.

**ترتيب المسارات**: `/me` قبل `/:id` بالراوتر وإلا ابتلع `/:id` كلمة `me` كمعرّف غير رقمي.

### الجملة والدعم والأرشفة (2026-09-20)

**`WireCustomer` أُضيف له**: `wholesale_requested_at` · `wholesale_decided_at` · `wholesale_rejection_reason` · `archived_at`.

| Method | Path | الحماية | ملاحظات |
|---|---|---|---|
| POST | `/customers/me/wholesale-request` | **`requireVerifiedCustomer`** | أول مسار بالنظام يحمل الحارس الموثَّق. غير الموثَّق ← `403 email_verification_required`. يحوّل `wholesale_status` إلى `pending` **ويبقى `customer_type = retail`** حتى القرار. مفتوح/معتمد ← `409 wholesale_request_not_allowed`. المرفوض يستطيع إعادة الطلب (يُمسح سبب الرفض) |
| POST | `/customers/:id/wholesale/decide` | `customers.wholesale` (حسّاس) | `{decision: approve|reject, reason}` — **الرفض بلا سبب `422`**. غير المعلَّق `409 wholesale_not_pending`. الموافقة تجعل النوع `wholesale` |
| GET | `/customers?wholesale_status=pending` | `customers.view` | طابور الجملة. و`?archived=true` يُرجع المؤرشفين **وحدهم** |
| POST | `/customers/:id/archive` · `/unarchive` | `records.archive` | الأرشفة **تفرض `disabled`**، والإخراج لا يعيد التفعيل (خطوة منفصلة). أي كتابة على مؤرشف `409 customer_archived` |
| DELETE | `/customers/:id` | `customers.manage` | **للمعطَّل فقط** (`409 customer_delete_requires_disabled`). يحرّر البريد بنفس المعاملة، ويبقى لقطة `{email, full_name}` بالتدقيق |
| POST | `/customers/:id/resend-verification` · `/password-reset` | `customers.manage` | **الرمز يصل بريد الزبون وحده** — الأدمن لا يراه ولا يضبط كلمة مرور. ردودها صادقة (تهدئة `429`، موثَّق `409`) لأن السائل موظف مسجَّل |
| GET | `/customers/:id/activity` | `customers.view` | من `customer_activity_log` (دخول · فشل · توثيق · طلب جملة) |

### حسابي وحماية بيانات التواصل (2026-09-20)

- `DELETE /customers/me` — `requireCustomer`، الجسم `{password}`. كلمة مرور خاطئة `422 current_password_wrong` **لا 401**. يمحو الحساب وجلساته ورموزه ويحرّر البريد؛ يبقى `customer.self_deleted` بسجل النشاط.
- **بيانات التواصل**: `email` و`phone` بـ`GET /customers` و`GET /customers/:id` **مقنَّعان** (`l***@domain` · `*******222`) ما لم يحمل الموظف `customers.contact`. والبحث (`search`) لا يصل للبريد/الهاتف عمّن لا يحملها. الأفعال (تعليق…) تردّ نفس الحساب بنفس السياسة.
- **متغيّرات بيئة جديدة**: `TRUST_PROXY_HOPS` (0 = بلا proxy) · `STAFF_REGISTER_RATE_LIMIT` (5) · `CUSTOMER_REGISTER_RATE_LIMIT` (30).

### الدفعة الثانية (2026-09-21)

- `POST /customers/:id/wholesale/revoke` — `customers.wholesale`، `{reason}` إلزامي. الرد الحساب بلا جملة.
- `POST /customers/me/email` — `requireCustomer`، `{email, password}`. الرد الحساب بالبريد الجديد **`email_verified:false`**. الأخطاء: `422 current_password_wrong` · `422 email_unchanged` · `409 email_taken` (أي فئة). ينهي كل جلسات الزبون عدا الطالبة.
- `PATCH /users/me` — `requireAuth`، أي من `first_name · last_name · phone · address` (`address:null` يمسحه)، جسم فارغ أو بريد `422`.

### المصادقة الثنائية للموظفين (2026-09-21) — المرجع: `docs/reference/mfa.md`

- `POST /users/login` — قد يردّ الآن `{account_type:'staff', mfa_required:true, mfa_token}` (بلا `token`) لمن سجّل مصادقة. ردّ الجلسة الكاملة وردّ `GET /users/me` يحملان **`mfa_setup_required: bool`**.
- `POST /users/login/mfa` — عام. `{mfa_token, code, device_info?}` ← نفس جسم الدخول الكامل. `401 mfa_challenge_invalid` (منتهٍ/مزوَّر) · `401 mfa_code_invalid` · `429 mfa_locked` (5 أخطاء ← 15 دقيقة).
- `GET /auth/mfa` — `{enrolled, required, recovery_codes_remaining}`.
- `POST /auth/mfa/setup` — `{secret, otpauth_uri}` (السرّ base32 للإدخال اليدوي، والـURI لرمز QR). `409 mfa_already_enrolled`. **`403 mfa_not_enabled`** (2026-09-22) ما لم يُضبط `MFA_ENABLED=true` أو `MFA_ENFORCE=true` — ونفسه على `/confirm`.
- `POST /auth/mfa/confirm {code}` — `{recovery_codes:[10]}` **تُعرض مرة واحدة**.
- `POST /auth/mfa/recovery-codes {code}` — رمز تطبيق أو استرداد ← عشرة جديدة، القديمة تُبطل.
- `POST /auth/mfa/disable {password, code}` — `422 current_password_wrong` · `409 mfa_required_by_role`.
- `POST /users/:id/mfa/reset` — `users.manage`. ينهي جلسات الهدف. `403 mfa_reset_self_forbidden`.
- **`403 mfa_setup_required`** على أي مسار آخر لحساب مُلزَم لم يسجّل (`data.mfa_setup_required: true`). كل `/auth/mfa*` للموظفين فقط (`403 mfa_staff_only` لغيرهم).

### الملكية (2026-09-21) — كل المسارات `ownerships.manage`

- `GET /ownerships[?branch_scope=]` — **كل الحصص الفعّالة بكل النطاقات** (أو فرع واحد)، كل صف يحمل **`user_name`** و**`branch_name`** (`null` = نطاق كل الفروع). كان `requireAuth` وبلا `branch_scope` يُرجع نطاق «كل الفروع» وحده؛ صار بصلاحية لأن الرد يسمّي أشخاصاً ونسبهم.
- `POST /ownerships` `{user_id, percentage, branch_scope?}` — `422 ownership_sum_exceeded` إن تجاوز مجموع النطاق ١٠٠٪ (يذكر المجموع الحالي). مُدقَّق `ownership.create`.
- `POST /ownerships/:id/revise` `{percentage}` — يُغلق السجل ويفتح **جديداً** (معرّف جديد بالرد؛ التاريخ يبقى). الحدّ يستثني السجل المستبدَل. `404` لمغلق. مُدقَّق `ownership.revise`.
- `POST /ownerships/:id/end` — يُغلق الحصة (بيع/انسحاب). `404` لمغلقة. مُدقَّق `ownership.end`.

### أجهزة الإشعارات (2026-09-21) — المرجع: `docs/reference/notifications.md`

- `POST /auth/push-token` `{token, platform: 'android'|'ios', language?}` — أي حساب مسجَّل (موظف أو زبون). الرمز فريد: تسجيله لحساب ثانٍ **ينقله** إليه. `422` لرمز قصير/منصة مجهولة، `401` للضيف.
- `POST /auth/push-token/remove` `{token}` — يحذف الرمز **إن كان لصاحب الطلب**؛ غير ذلك `200` بلا أثر. يُستدعى قبل مسح الجلسة عند الخروج.

- **تعديل 2026-09-21**: `POST /customers/me/email` لغير الموثَّق بريدُه فقط — لموثَّق `409 email_change_not_allowed`.

## 18. الملفات والصور (2026-09-22) — `core/media/` · المرجع: `docs/reference/store_system.md` §١٠

**منطقتان من البداية**: `public` (صور الكتالوج، للجميع بمن فيهم الضيف) و`private` (ملفات الزبائن، برابط موقَّع قصير العمر فقط). الكود يكتب لمنفذ `StorageDriver`، واليوم `LocalDiskDriver` (`STORAGE_LOCAL_ROOT`، خارج git). الصف في `media_assets` يخزّن **مفاتيح لا روابط**، فنقل التخزين لا يُفسد أي صف.

**شكل `Image`** (يُرجعه كل endpoint يقبل أو يعرض صورة):

```json
{ "id": 12, "width": 2400, "height": 1600,
  "urls": { "thumb": "/api/v1/files/public/img/2026/09/<uuid>_thumb.webp",
            "medium": "/api/v1/files/public/img/2026/09/<uuid>_medium.webp",
            "large": "/api/v1/files/public/img/2026/09/<uuid>_large.webp" } }
```

الروابط **نسبية** لأصل الـAPI، والعميل يضيف عنوان الخادم الذي يكلّمه أصلاً. `width`/`height` للأصل **بعد تطبيق الاتجاه**.

- `POST /catalog/media/images` — `catalog.edit`. multipart، حقل `file`. الحارس **قبل** محلّل الملف (من لا صلاحية له لا يرفع ١٠MB للذاكرة أولاً). يُحفظ WebP بثلاثة أحجام (٣٢٠ · ٨٠٠ · ١٦٠٠، بلا تكبير)، وEXIF محذوف (موقع GPS). ← `201 Image`. الأخطاء: `413 image_too_large` (> ١٠MB) · `422 image_unsupported_format` (غير JPEG/PNG/WebP — HEIC يحوّله التطبيق قبل الرفع) · `422 image_too_small` (أقصر ضلع < ٢٠٠) · `422 image_unreadable` (ليس صورة، أو يتجاوز ٤٠ ميغابكسل). الصورة **غير مرتبطة** (`attached_at: null`) حتى يُحفظ سجل كتالوج يشير لمعرّفها.
- `GET /files/public/<key>` — عام. `Cache-Control: public, max-age=31536000, immutable` (المفتاح لا يتكرر: صورة مستبدلة = مفتاح جديد). مفتاح مخالف للقواعد أو غير موجود ← `404` بنفس الشكل.
- `GET /files/private/<key>?expires=&signature=` — عام، **والتوقيع هو التفويض** (بلا Bearer: يقرؤه ودجت صورة أو مدير تنزيل). `403 file_link_invalid` لمنتهٍ أو معدَّل · `Cache-Control: private, no-store`. التوقيع HMAC-SHA256 على `zone:key:expires` بـ`STORAGE_SIGNING_KEY` (إلزامي بالإنتاج). **لا مُصدِر له بعد** — أول من يُصدره وحدة الطباعة، بعد فحص حقّ القارئ.

## 19. الكتالوج المركزي — البيانات المرجعية (2026-09-22) · المرجع: `docs/reference/store_system.md` §٩–١٠

**الصلاحيات**: قراءة `catalog.view` · إنشاء `catalog.create` · تعديل `catalog.edit` · حذف `catalog.delete` · أرشفة/استرجاع `catalog.delete` **+** `records.archive` (نفس نمط §16). `catalog.manage` مظلّة تجمعها. كل طفرة **مُدقَّقة** بنفس `audit_log_entries` (`target_entity`: `catalog_category:<id>` · `catalog_attribute_type:<id>` · `catalog_attribute_value:<id>` · `catalog_unit:<id>` · `catalog_brand:<id>`).

**مقارنة الأسماء بعد الطيّ** (`core/i18n/arabic-normalize.ts`): «أقلام»=«اقلام» · «مدرسية»=«مدرسيه» · «مقوّى»=«مقوى» — فالتكرار يُرفض حتى لو اختلفت الحروف قليلاً، والبحث يجد الكلمة كيفما كُتبت.

- `GET /catalog/units` — غير مُصفّحة. `{id, code, name_ar, name_en, allows_fraction, is_active, sort_order}`. `code` للمبذور فقط.
- `POST /catalog/units` `{name_ar, name_en?, allows_fraction?, sort_order?}` · `PATCH /catalog/units/:id` `{name_ar?, name_en?, sort_order?, is_active?}` — **`allows_fraction` لا يُعدَّل** (قاعدة كسر مختلفة = وحدة أخرى). `409 unit_name_taken`.
- `GET /catalog/attributes` — المكتبة كاملة مع قيمها، غير مُصفّحة. كل نوع يحمل `categories_count` (سبب تعذّر الحذف). `display`: `swatch` | `text`.
- `POST /catalog/attributes` `{name_ar, name_en?, display?, sort_order?}` · `PATCH /catalog/attributes/:id` · `DELETE /catalog/attributes/:id` (`409 attribute_type_in_use` + `data.categories_count`؛ القيم تُحذف معه) · `POST /catalog/attributes/:id/values` `{value_ar, value_en?, color_hex?, sort_order?}` (`409 attribute_value_taken`) · `PATCH|DELETE /catalog/attribute-values/:id`. **الحذف مؤقتاً بلا فحص متغيّرات** — لا متغيّرات بعد؛ يُضاف الفحص والأرشفة مع الشريحة التالية.
- `GET /catalog/categories[?archived=true]` — **قائمة مسطّحة غير مُصفّحة** (العميل يبني الشجرة): كل صف `{id, code, parent_id, level, name_ar, name_en, product_kind, price_policy, pricing_currency, effective:{product_kind, price_policy, pricing_currency}, image: Image|null, sort_order, is_active, archived_at, children_count}`. الحقول الثلاثة `null` = **يرث**، و`effective` هي القيمة المطبَّقة بعد الصعود في الشجرة — ما يعرضه العميل. `children_count` يعدّ الأبناء غير المؤرشفين.
- `GET /catalog/categories/:id` — ما سبق + `path` (من الجذر) + `attribute_types:{own, inherited[{…, from_category_id}]}` + `is_deletable` · `is_archivable` · `active_children_count`. **الأحكام من الخادم** ولا يشتقّها العميل.
- `POST /catalog/categories` `{parent_id?, name_ar, name_en?, product_kind?, price_policy?, pricing_currency?, image_id?, sort_order?, is_active?}` ← `201` التفاصيل. `422 category_too_deep` (أكثر من ٣ مستويات) · `409 category_name_taken` / `category_name_taken_by_archived` (بين الإخوة، `data.category_id`) · `409 category_parent_archived` · `422 image_id` لصورة غير موجودة/خاصة.
- `PATCH /catalog/categories/:id` — نفس الحقول جزئياً. **النقل** (`parent_id`) يعيد حساب مستوى الشجرة الفرعية كاملة بمعاملة واحدة، والعمق يُفحص **مع** الشجرة المنقولة. `422 category_parent_invalid` (تحت نفسه/حفيده) · `409 category_archived`.
- `PUT /catalog/categories/:id/attributes` `{attribute_type_ids:[]}` — يستبدل خصائص التصنيف **الخاصة**؛ الموروثة تُعدَّل على الجدّ المالك لها.
- `DELETE /catalog/categories/:id` — لمن لا ابن تحته قط (المؤرشف يُحسب). `409 category_has_children`.
- `POST /catalog/categories/:id/archive` (`409 category_has_active_children`) · `/unarchive` (`409 category_parent_archived` · `category_name_taken`). كلاهما idempotent.
- `GET /catalog/brands?page&limit&search` — مُصفّحة، بحث مطويّ. `{id, name, logo: Image|null, archived_at, created_at}`. `POST` `{name, logo_image_id?}` · `PATCH` · `DELETE` (بلا فحص منتجات بعد). `409 brand_name_taken`.

**بيانات البداية** (`src/core/db/seed-catalog.ts`، مع كل `npm run db:seed`): ١٠ وحدات · ١٥ خاصية بـ٩٠ قيمة · ١٤٦ تصنيفاً (١٢/٤٧/٨٧) · ١٢ ماركة — من `docs/reference/catalog_seed.md`. **إدخال عند الغياب فقط**: صفّ مبذور موجود لا يُلمس أبداً، فتعديل الأدمن ينجو من كل إعادة بذر.

## 20. المنتجات والمتغيّرات والباركود والمجموعات (2026-09-22) · المرجع: `docs/reference/store_system.md` §٧ و§٩

**النموذج**: المنتج (الاسم · الوصف · التصنيف · الماركة · الصور) ← متغيّرات (كل واحد تركيبة قيم فريدة، وSKU، ووحدة أساس يُعدّ بها المخزون) ← وحدات بيع بمعامل (القطعة ×1 دائماً، العلبة ×12…) ← باركودات. المنتج بلا خيارات = متغيّر واحد بلا قيم. كل ردّ كتابة على منتج أو متغيّر أو باركود **يُرجع تفاصيل المنتج كاملة**، فالشاشة تستبدل ولا ترقّع.

**قواعد المتغيّرات** (مُختبَرة بـ`__tests__/product-rules.test.ts`): تصنيف **ورقي** فقط (`422 category_not_leaf`) · كل المتغيّرات على نفس الخصائص (`422 variant_axes_mismatch`) · ٣ خصائص كحد أقصى (`422 variant_too_many_axes`) · قيمة واحدة لكل خاصية (`422 variant_attribute_repeated`) · الخاصية مسموحة بالتصنيف أو أحد أجداده (`422 variant_attribute_not_allowed`) · لا تركيبتان متطابقتان (`409 variant_combination_taken`). SKU بلا إدخال = `QRT-<id>`، وتكراره `409 variant_sku_taken`.

**الباركود**: **الكود ليس فريداً وحده داخل المنتج الواحد** — الفرادة على (الكود + المتغيّر + الوحدة)، فأخطاء المصانع (نفس الكود على القطعة والعلبة، أو لكل ألوان القلم) تُقبل وتُعلَّم `is_shared: true`. **لكن الكود لا يُقبل على منتج ثانٍ**: `409 barcode_on_other_product` مع `data: {code, product_id, product_name_ar, product_name_en}` — المسح حينها يعرض صنفين لا علاقة بينهما ولا يملك الكاشير ما يميّزهما، والمخرج فتح المنتج المالك أو طباعة ملصق داخلي. (المنتجات المؤرشفة لا تُحتسب — المسح لا يعرضها أصلاً.) EAN-8/UPC-A/EAN-13 برقم تحقق خاطئ `422 barcode_checksum_invalid`، والشكل غير الصالح `422 barcode_format_invalid`. **الداخلي** EAN-13 ببادئة `20` من تسلسل قاعدة البيانات — نطاق محجوز عالمياً للمتاجر، لا يصطدم بكود مصنّع.

- `GET /catalog/products?page&limit&search&category_id&brand_id&status&kind&archived` — `catalog.view`. `search` مطويّ على الأسماء والكلمات المرادفة، وإن بدا كوداً طابق الباركود/SKU **حرفياً**. `category_id` يشمل الفروع. العنصر: `{id, name_ar, name_en, category{id,name_ar,name_en}, brand{id,name}|null, kind, status, is_sellable, thumbnail: Image|null, variants_count, archived_at, created_at, updated_at}`.
- `GET /catalog/products/:id` — ما سبق + `description_*` · `search_keywords` · `price_policy`/`pricing_currency` (`null` = يرث) · `effective` · `category_path` · `allowed_attribute_type_ids` · `axes` · `images` · `variants[{id, sku, status, sort_order, base_unit_id, label_ar, label_en, values[{attribute_type_id, attribute_value_id, value_ar, value_en, color_hex}], units[{id, unit_id, name_ar, name_en, factor, is_base, allows_fraction, sellable_online, sellable_at_pos}], barcodes[{id, code, unit_id, source, is_shared}], images}]` · `is_deletable` · `is_archivable`.
- `POST /catalog/products` — `catalog.create`. `{category_id, brand_id?, kind?, is_sellable?, name_ar, name_en?, description_ar?, description_en?, search_keywords?, price_policy?, pricing_currency?, status?: draft|active, image_ids?, variants: [{sku?, attribute_value_ids, base_unit_id, units?[{unit_id, factor, sellable_online?, sellable_at_pos?}], barcodes?[{code, unit_id}], image_ids?, sort_order?}]}` — `kind` الافتراضي من التصنيف. كتابة واحدة بمعاملة واحدة.
- `PATCH /catalog/products/:id` — `catalog.edit`. نقل التصنيف يُرفض إن كانت المتغيّرات تستخدم خصائص لا يسمح بها الجديد (`409 product_attributes_not_allowed_in_category`). `active` يحتاج متغيّراً نشطاً (`422 product_needs_active_variant`). `409 product_archived`.
- `DELETE /catalog/products/:id` — `catalog.delete`. **حذف فعلي اليوم** (لا مخزون ولا أسعار ولا طلبات تشير لمنتج بعد)؛ المرحلتان ٢–٣ تضيفان عدّاداتها ويصير المنتج ذو الماضي للأرشفة. `POST /:id/archive` · `/unarchive` — `+ records.archive`، والاسترجاع لتصنيف مؤرشف `409 product_category_archived`.
- `POST /catalog/products/:id/variants` · `PATCH /catalog/variants/:id` (`sku · attribute_value_ids · status · sort_order · image_ids`؛ **`base_unit_id` لا يُعدَّل**) · `DELETE /catalog/variants/:id` (`409 product_needs_variant` للأخير) — `catalog.edit`.
- `PUT /catalog/variants/:id/units` `{units:[…]}` — الأساس يبقى بمعامل 1. `422 variant_unit_factor_invalid` (معامل ≤ 1) · `409 variant_unit_has_barcodes` (+ `data.codes`).
- `POST /catalog/variants/:id/barcodes` `{code, unit_id}` — `catalog.edit`. `409 barcode_already_on_unit` · `409 barcode_on_other_product`. · `POST /catalog/variants/:id/barcodes/internal` `{unit_id}` — **`barcodes.print`** (موظف المخزون يلصق ملصقات ولا يعدّل الكتالوج). · `DELETE /catalog/barcodes/:id`.
- `GET /catalog/barcodes/lookup?code=` — `catalog.view`. `{code, ambiguity: none|unit|item, matches[{barcode_id, product_id, product_name_ar, product_name_en, product_status, variant_id, sku, variant_label_ar, variant_status, unit_id, unit_name_ar, factor, thumbnail}]}`. `unit` = متغيّر واحد بعدة وحدات (اعرض الوحدات) · `item` = عدة متغيّرات (اعرض الصور/الألوان). المؤرشف مستبعد.
- `GET /catalog/barcodes/shared` — الأكواد المشتركة، الأسوأ أولاً: `[{code, matches_count, ambiguity, scope, products}]` — إشارة اللوحة («٧ باركودات مشتركة»). **`scope` يتصدّر الترتيب**: `cross_product` (كود على منتجين — لا يحلّه مسح، ويحتاج ملصقاً داخلياً بيد شخص) قبل `in_product` (حالة المصنع التي يحلّها الكاشير بضغطة). صفوف `cross_product` **سابقة لقاعدة `barcode_on_other_product`** — لا يُنشأ منها جديد، و`products` يسمّي المنتجين لفتحهما.
- `GET|POST /catalog/collections` · `GET|PATCH|DELETE /catalog/collections/:id` · `PUT /catalog/collections/:id/products` `{product_ids}` (بالترتيب المعروض؛ المؤرشف مرفوض). `{id, name_ar, name_en, image, starts_at, ends_at, is_active, sort_order, products_count}` + `products` بالتفاصيل. الحذف فعلي — المجموعة لافتة رفّ بلا تاريخ.

**قواعد صارت تعدّ المنتجات** (تكمّل §19): حذف تصنيف له منتجات قطّ `409 category_has_products` · أرشفته وبه منتجات حيّة `409 category_has_active_products` · تصنيف فرعي تحت تصنيف فيه منتجات `409 category_parent_has_products` · إزالة خاصية تستخدمها متغيّرات تحته `409 category_attribute_in_use` · حذف قيمة يستخدمها متغيّر `409 attribute_value_in_use` · حذف ماركة عليها منتجات `409 brand_in_use` (والبديل `POST /catalog/brands/:id/archive`). تفاصيل التصنيف تحمل `products_count` و`active_products_count`.

**مؤجَّل**: مسودات الفروع (`catalog.drafts.*`) مع المرحلة 3 — المسودة لا معنى لها قبل أن يستلم الفرع بضاعة.

## 21. الطرح والتسعير (2026-09-22) · المرجع: `docs/reference/store_system.md` §١١

**المبدأ**: الخادم يحسب السعر النهائي ويُرجعه **مع مصدره**، والعميل يعرض ولا يحسب. الحلّ بدالة صافية `services/price-resolution.ts` (مُختبَرة بـ`__tests__/price-resolution.test.ts`، كل قاعدة مع نقيضها).

**كائن `resolved`** (يتكرّر بكل رد):
- `{status: "not_listed"}` — مسحوب من هذا الفرع.
- `{status: "unpriced", reason: "no_price" | "no_exchange_rate"}` — لا يُباع، ولا يراه الزبون بهذا الاسم؛ يظهر بـ`/pricing/worklist`.
- `{status: "priced", amount_syp, source: "central" | "branch" | "branch_exception" | "suggested", out_of_band, band: {min, max} | null, wholesale: {amount_syp, min_qty} | null}`. `suggested` = `branch_free` بلا سعر فرع (يُباع بالمركزي). `out_of_band: true` = للفرع سعر خرج عن النطاق بعد تحرّك المركزي، **فيُطبَّق المركزي** ويُكشف.

**العملة**: كل سعر مخزَّن بعملته (`SYP`/`USD`). الليرة المكتوبة تبقى كما كُتبت؛ **المحسوب فقط يُقرَّب لأعلى** بالشرائح (المحوَّل من الدولار، والجملة المشتقّة بنسبة، ونتيجة التحديث الجماعي بالليرة).

**النطاق والصلاحية**: الكتابة تتطلّب `pricing.edit` على المسار، ثم يفحص الخادم النطاق حسب سياسة المنتج: السعر المركزي واستثناءات `central_locked` تحتاجه **بلا تقييد فرع** (`403 price_central_only`)؛ سعر فرع لـ`branch_free`/`branch_banded` يحتاجه **بذلك الفرع** (`403 pricing_scope_denied`). الفحص يمرّ بنفس `resolvePermissions` (المظلّة + المنح/الحجب الفردي). و`can_edit_central`/`can_edit_branch` بالرد هما جواب الخادم — الشاشة تعرض الأدوات منهما.

- `GET /catalog/pricing/settings` — `catalog.view`. `{exchange_rate: {usd_to_syp, effective_at} | null, rounding_bands: [{below, step}], branches: [{id, name}]}`. الفروع **هنا** لأن كتالوج الفرونت لا يقرأ وحدة الفروع (`Features → Features ❌`) وكل شاشة تسعير تحتاج منتقي فرع..
- `POST /catalog/pricing/exchange-rate` `{usd_to_syp}` — `pricing.policy`. **يُضاف ولا يُعدَّل**؛ الساري = الأحدث. يردّ الإعدادات.
- `PUT /catalog/pricing/rounding` `{bands}` — `pricing.policy`. تتصاعد، آخرها `below: null`، خطوات موجبة (`422 rounding_bands_invalid`).
- `GET /catalog/products/:id/pricing?branch_id=` — `catalog.view`. `{product_id, branch_id, price_policy, pricing_currency, band_percent, own_band_percent, wholesale_discount_percent, wholesale_min_qty, tax_rate_percent, exchange_rate, can_edit_central, can_edit_branch, variants: [{variant_id, sku, label_ar, central: {amount, currency, wholesale_amount, wholesale_min_qty} | null, branch_price: {amount, currency} | null, is_listed, resolved, branch_prices: [{branch_id, branch_name, amount, currency}], unlisted_branch_ids}]}`. بلا `branch_id` = العرض المركزي (`branch_prices`/`unlisted_branch_ids` معبّأة، `branch_price` فارغ)؛ معه = عرض الفرع (العكس).
- `PUT /catalog/variants/:id/price` `{amount, currency?, wholesale_amount?, wholesale_min_qty?}` — السعر المركزي. العملة الغائبة = عملة المنتج الفعّالة. `422 wholesale_not_below_retail`. يردّ العرض المركزي.
- `PUT /catalog/branches/:branchId/variants/:variantId/price` `{amount, currency?}` — لـ`branch_banded`: `409 price_band_missing` (لا نطاق) · `409 price_no_central` · `422 price_outside_band` + `data: {min, max}`. يردّ عرض الفرع.
- `DELETE /catalog/branches/:branchId/variants/:variantId/price` — يعود للمركزي.
- `PUT /catalog/branches/:branchId/variants/:variantId/listing` `{is_listed}` — `pricing.edit` بذلك الفرع (السحب قرار الفرع مهما كانت السياسة). **الغياب = مطروح**.
- `GET /catalog/variants/:id/price-history` — `catalog.view`. آخر ١٠٠: `[{id, branch_id, branch_name, field: retail|wholesale|wholesale_min_qty, old_amount, old_currency, new_amount, new_currency, source: manual|bulk, changed_at, changed_by}]`. `branch_id: null` = مركزي.
- `GET /catalog/pricing/worklist?branch_id=` — `catalog.view`. المتغيّرات القابلة للبيع (منتج منشور + متغيّر نشط) بلا سعر أو خارج النطاق: `{total, items: [{variant_id, product_id, product_name_ar, product_name_en, sku, label_ar, problem: no_price|no_exchange_rate|out_of_band}]}` (أول ٢٠٠).
- `POST /catalog/pricing/bulk/preview` · `POST /catalog/pricing/bulk/apply` `{category_id | brand_id, percent}` — `pricing.policy`. مركزي فقط، التصنيف **بأبنائه**، −٩٠…+٥٠٠ ولا صفر. `{count, skipped, largest_change_syp, smallest_change_syp, samples[≤10]}`. `apply` **يعيد التخطيط** ولا يثق بالمعاينة (قد تتحرّك الأسعار بين الضغطتين)، ويكتب التاريخ `source: bulk` وسطر تدقيق واحد.
- `PUT /catalog/categories/:id/pricing-rules` `{price_band_percent?, wholesale_discount_percent?, wholesale_min_qty?, tax_rate_percent?}` — `pricing.policy`. `null` = يرث، الغياب = بلا تغيير. يردّ تفاصيل التصنيف، وفيها `pricing_rules: {own, effective}`.
- `PUT /catalog/products/:id/pricing-rules` `{price_band_percent}` — `pricing.policy`. تجاوز النطاق لمنتج واحد (`null` = نطاق التصنيف). يردّ العرض المركزي.

**التدقيق**: `catalog.price.central.set` · `catalog.price.branch.set|clear` · `catalog.listing.set` (على `catalog_variant:<id>`) · `catalog.pricing.exchange_rate.set|rounding.set|bulk_update` (على `catalog_pricing:settings`) · `catalog.category.pricing_rules` · `catalog.product.pricing_rules`.

**مؤجَّل**: سعر خاص للعلبة/الطرد · الأسعار المجدولة (مع العروض) · الجملة بشرائح · التحديث الجماعي لأسعار الفروع · نطاق المورد بالتحديث الجماعي (مع وحدة الموردين).

## 22. المخزون والموردون (2026-09-23) · المرجع: `docs/reference/inventory_suppliers.md` §٢–§٨

**المبدأ**: **دفتر الحركات هو السجل** (`stock_movements`) — يُضاف ولا يُعدَّل ولا يُحذف، والتصحيح حركة عكسية. و`stock_balances` **كاش** يُكتب بنفس المعاملة وقابل لإعادة البناء من الدفتر. كل كمية بوحدة الأساس دائماً `numeric(14,3)` (الكسور مدعومة)، والصفّ يُقفَل (`FOR UPDATE`) أثناء أي كتابة — وإلا قرأ كاتبان نفس الرصيد وكتب كلٌّ منهما عالماً لم يعد قائماً.

**التكلفة** (§٣، ومُثبَّتة بـ`__tests__/stock-rules.test.ts`): متوسط مرجّح متحرك لكل (متغيّر × فرع)، **بالليرة وبالدولار معاً**. الاستلام وحده يحرّك المتوسط؛ الصرف يُنقص الكمية ولا يمسّه. رصيد ≤ صفر عند الاستلام ← التكلفة الجديدة تصير المتوسط (المتوسط مع كمية سالبة رقم بلا معنى). وكل حركة صرف **تحمل المتوسط الذي غادرت عليه**، فتقييمها بعد سنوات لا يحتاج إعادة تشغيل كل استلام سبقها.

**الترقيم**: تسلسل لكل (فرع × نوع) بلا فجوات — `GRN-<فرع>-000012` · `DMG-…`. الزيادة والقراءة **جملة واحدة** (`ON CONFLICT … +1 RETURNING`) فلا يقرأ مستندان الرقم نفسه.

**الصلاحيات**: `inventory.view` · `inventory.receive` · `inventory.adjust` · `inventory.approve` · `suppliers.view` · `suppliers.manage`. الحارس يسأل «هل يملكه بأي مكان؟»، و**الاعتماد يُفحص بنطاق الفرع** بالخدمة (`holdsPermissionAt`) لأن النطاق يعتمد على فرع المستند (`403 inventory_scope_denied`).

### الموردون
- `GET /suppliers?page&limit&search&archived` — `suppliers.view`. الصف: `{id, name, phone, email, address, notes, is_active, archived_at, invoices_count, is_deletable, is_archivable}`.
- `GET /suppliers/:id` · `POST /suppliers` · `PATCH /suppliers/:id` — `suppliers.manage`. اسم مكرَّر بعد طيّ العربية `409 supplier_name_taken` (مورد باسمين يشطر تاريخه). الكتابة على مؤرشف `409 supplier_archived`.
- `POST /suppliers/:id/archive` · `/unarchive` — الأرشفة تُطفئ `is_active` معها.
- `DELETE /suppliers/:id` — لمن لم تُسجَّل له فاتورة قط؛ غير ذلك `409 supplier_has_invoices` + `data.invoices_count`.

### الاستلام (فاتورة شراء)
- `POST /inventory/receipts` — `inventory.receive`. `{branch_id, supplier_id, supplier_invoice_no?, invoice_date, currency, exchange_rate?, note?, lines:[{variant_id, unit_id, qty, unit_cost, expires_at?}]}`. **يُرحَّل فوراً**: حركات `receipt` + طبقات استلام + أرصدة، بمعاملة واحدة. السطر يُحفظ **كما كُتب** (كرتونة ×١٢ بـ٦٠٬٠٠٠) **وبوحدة الأساس** (١٢٠ قطعة بـ٥٬٠٠٠) — الأول يُطابَق بالورقة والثاني تجمعه التقارير. `422 receipt_rate_required` (فاتورة بالدولار بلا سعر صرف — تكلفة دولارية مخمَّنة تلاحق البضاعة طوال عمرها) · `422 receipt_unit_mismatch` · `422 receipt_variant_unknown` · `409 receipt_product_archived`.
- `GET /inventory/receipts?page&limit&branch_id&supplier_id` · `GET /inventory/receipts/:id` (بالسطور) — `inventory.view`.

### المخزون
- `GET /inventory/stock?branch_id&page&limit&search&flag` — `inventory.view`. الصف: `{variant_id, product_id, product_name_ar/_en, sku, on_hand, reserved, available, avg_cost_syp, avg_cost_usd, reorder_threshold, flag}`. و**`flag` يحسبه الخادم**: `negative` (تناقض يستدعي جرداً، لا «قليل جداً») · `out_of_stock` · `low` (تحت حدّ الفرع) · `ok`. الفلتر `flag=low` يشمل الثلاثة غير `ok`.
- `GET /inventory/movements?branch_id&variant_id&page&limit` — الدفتر، الأحدث أولاً، مع من سجّله والمستند المصدر.
- `PUT /inventory/variants/:id/threshold` `{branch_id, threshold|null}` — `inventory.receive`. **الفرع يحدده** (§٨)؛ `null` = بلا حدّ، وهو غير الصفر.
- `GET /inventory/variants/:id/threshold-suggestion?branch_id` — `{suggestion, days, sold_base}`؛ `suggestion: null` حتى يتراكم تاريخ كافٍ (٣٠ يوماً)، لأن رقماً من ثلاثة أيام يُوثَق به كما يُوثَق برقم سنة.
- `GET /inventory/signals?branch_id` — `{low_count, out_of_stock_count, negative_count, pending_adjustments, expiring[]}`؛ `expiring` من طبقات الاستلام التي لها تاريخ صلاحية وما زال فيها كمية.
- `GET|PUT /inventory/settings` — `{approval_threshold_syp, expiry_alert_days, branches[]}`؛ التعديل بـ`inventory.approve`. **و`branches` تسافر مع الإعدادات** (كما تفعل إعدادات التسعير §21): كل شاشة مخزون تسأل «أي فرع؟» قبل أن تعرض رقماً، وقاعدة الفرونت `Features → Features ❌` تمنع موديول المخزون من قراءة موديول الفروع.
- `GET /inventory/document-items?branch_id&search` — `inventory.view`. ما يصلح لسطر استلام أو تلف: `{variant_id, sku, product_name_ar, base_unit_id, on_hand, units[]}`، بحث بالعربية المطوية والـSKU **وبالباركود تماماً** (المسح يجد الصنف)، بسقف ٢٥ صفاً. **و`on_hand` جزء من الصف** لأن سطر التلف يُكتب بمواجهة ما على الرف لا بمعزل عنه.

### التلف والفقد
- `POST /inventory/adjustments` — `inventory.adjust`. `{branch_id, reason: damage|loss|expiry|sample|internal_use|other, note, lines:[{variant_id, qty_base}]}`. **السبب إلزامي**. يُقيَّم بمتوسط اللحظة: تحت الحدّ ← `posted` فوراً بحركاته، فوقه ← `pending_approval` **بلا أي حركة** (بضاعة «قيد الانتظار» كانت ستُعدّ مرتين).
- `GET /inventory/adjustments?page&limit&branch_id&status` · `GET /inventory/adjustments/:id`.
- `POST /inventory/adjustments/:id/approve` · `/reject` — `inventory.approve` **بفرع المستند**. قرار ثانٍ `409 adjustment_not_pending`.

**مؤجَّل للشريحة 3-ب**: النقل بين الفروع · الجرد · مسودات الفروع · المرتجع للمورد.

## 23. النقل بين الفروع والجرد (2026-09-23) · المرجع: `docs/reference/inventory_suppliers.md` §٤–§٥

**النقل** — `inventory.transfer`، والنطاق يُفحص **بكل خطوة** بالخدمة: المرسِل يوافق ويشحن، والمستلم يستلم؛ حارس المسار لا يعرف أيّهما المتصل (`403 transfer_scope_denied`).

```
requested → approved → in_transit → received                   → closed
          ↘ rejected            ↘ received_with_discrepancy → closed
```

**و`in_transit` حالة قائمة بذاتها**: البضاعة **لا تخصّ أي فرع** وهي بالطريق — لو حُسبت للمرسِل لبيعت مرتين، ولو حُسبت للمستلم لبيعت قبل وصولها. آلة الحالات دالة صافية (`services/transfer-rules.ts`, ١٣ اختباراً) والردّ يحمل `next_states` فتُبنى أزرار الشاشة منه لا من نسخة ثانية تنحرف.

- `POST /inventory/transfers` `{from_branch_id, to_branch_id, note?, lines:[{variant_id, qty_requested}]}` — من يملك الصلاحية **بلا تقييد فرع** يُنشئ أمراً يبدأ `approved` مباشرة (أمر الإدارة، §٤)؛ غيره يطلب من فرعه فيبدأ `requested`. `422 transfer_same_branch`.
- `POST /:id/approve` · `/reject` — **بيد الفرع المرسِل**: بضاعته.
- `POST /:id/ship` `{lines:[{variant_id, qty}]}` (السطر الغائب = كما طُلب) — يُخرج الكمية من المرسِل **بتكلفته هو** (§٣: النقل ليس بيعاً، ولا ربح بين الفروع).
- `POST /:id/receive` `{lines:[{variant_id, qty}]}` (الغائب = كما شُحن) — يُدخل **ما وصل فعلاً**. أي فرق ← `received_with_discrepancy`، **ولا يُبتلع**.
- `POST /:id/resolve` `{resolution: loss|returned, note?}` — `loss` لا يُرحّل شيئاً (البضاعة غادرت المرسِل عند الشحن ولم تصل؛ حركة ثانية كانت ستخصم الكمية مرتين) · `returned` يعيدها لرفّ المرسِل. ثم `closed`. `409 transfer_no_discrepancy`.
- `POST /:id/close` · `GET /inventory/transfers?branch_id&status` (الفرع يرى ما يرسله **وما ينتظره**) · `GET /inventory/transfers/:id`.

**الجرد** — `inventory.count` (والاعتماد `inventory.approve`)، بلا إغلاق الفرع.

- `POST /inventory/counts` `{branch_id, scope: full|category|list, category_id?, note?}` → `CNT-<فرع>-000001` بحالة `open`.
- `POST /inventory/counts/:id/lines` `{variant_id, counted_qty}` — **جرد أعمى**: الرد `{recorded, counted_lines}` ولا يحمل رصيد النظام ولا الفرق. كل سطر يخزّن رصيد النظام **لحظة مسحه** (الحركة مستمرة أثناء الجرد)، ومسح الصنف ثانيةً **يستبدل** سطره لا يضيف إليه.
- `POST /:id/close` — يقارن ويحسب قيمة الفروق **بالقيمة المطلقة** (نقص ١٠ وزيادة ١٠ مشكلتان لا صفر؛ الجمع الجبري كان يُمرّر جرداً كبيراً تحت حدّ الاعتماد). تحت الحدّ ← `closed` وتُرحَّل حركات `count_adjustment`؛ فوقه ← `pending_approval` **بلا أي حركة**.
- `POST /:id/approve` · `/reject` — `inventory.approve` بفرع المحضر. `409 count_not_pending`.
- `GET /inventory/counts?branch_id&status` · `GET /inventory/counts/:id` — `system_qty`/`diff` **`null` ما دام مفتوحاً** (إرسالهما «للواجهة فقط» يُنهي الجرد الأعمى).

**حذف منتج له حركات** — `409 product_has_movements` + `data.movements_count`، و`is_deletable` بتفاصيل المنتج يعكسها. القيد يصل عبر منفذ `core/records/deletion-guards.ts` (الكتالوج لا يستورد المخزون): قبله كان الحذف يصطدم بمفتاح `RESTRICT` فيعود **500** — رفضٌ حقيقي بصياغة عُطل.


## 24. مسودات الفروع والمرتجع للمورد (2026-09-23) · المرجع: `docs/reference/inventory_suppliers.md` §٢ و§٧

**المسودة هي جواب «باركود لا يعرفه النظام والبضاعة على الرصيف»**: الفرع ينشئ صفاً ويستلم عليه فوراً ولا ينتظر أحداً. وهو **منتج عادي بجدول المنتجات** (`is_branch_draft` + `draft_branch_id`) لا جدولاً ثانياً — وإلا لزم نقل المخزون بين جدولين يوم يُعتمد. ولا يُباع: `status: draft`، لأن اسمه وتصنيفه لم يقرّرهما أحد بعد، وفاتورة تطبع اسماً قد يتغير الأسبوع القادم.

- `POST /catalog/drafts` `{branch_id, name_ar, name_en?, category_id, base_unit_id, barcode?, image_id?, note?}` — `catalog.drafts.create` (بيد الفرع). يُنشئ منتجاً بمتغيّر واحد بلا خصائص ووحدة أساسية واحدة. التصنيف **نهائي إلزاماً** (`422 category_not_leaf`)، والباركود يُرفض لشكله فقط (`422 barcode_format_invalid`) — رقم التحقق لا يُفرض هنا (كودُ مصنعٍ لا يُقرأ نظيفاً هو بالضبط ما وُجدت له المسودة). **لكن كوداً يحمله منتج قائم يُرفض** `409 barcode_on_other_product`: مسحه كان سيجد ذلك المنتج، فالمسودة عليه تجعل المسح نفسه يعرض صنفين من بعدها — والرسالة تسمّي المنتج الذي كان الفرع يبحث عنه.
- `GET /catalog/drafts?branch_id&include_decided` · `GET /catalog/drafts/:id` — الأقدم أولاً (من انتظر أطول هو من لا يزال عاجزاً عن البيع)، وكل صف يحمل `age_days` و`barcodes` و`on_hand` — ما يحتاجه المراجِع بلا فتح تفاصيل.
- `POST /catalog/drafts/:id/approve` `{name_ar?, name_en?, category_id?, brand_id?}` — `catalog.drafts.review`. كل حقل اختياري: الغائب يعني «الفرع أصاب». يصير `status: active` و`is_branch_draft: false`.
- `POST /catalog/drafts/:id/merge` `{variant_id}` — كان صنفاً نبيعه أصلاً. **المخزون ينتقل معه** (الأرصدة تُدمج كما تُدمج دفعة واردة، والحركات والطبقات وسطور الفواتير تُوجّه للمتغيّر الحقيقي) **وباركوداته تتبعه** — وإلا عاد المسح التالي إلى «باركود مجهول». `422 draft_merge_self` · `422 draft_merge_into_draft`.
- `DELETE /catalog/drafts/:id` — لمسودة **لم تستلم شيئاً**. مع مخزون ← `409 draft_has_stock` (الجواب دمج أو اعتماد، لا محو بضاعة على رفّ). وقرار ثانٍ على مسودة مُبتّ بها ← `409 draft_already_decided`.

**المرتجع للمورد** — `inventory.receive` (نفس اليد التي تستلم)، وهو **ليس تسوية**: التسوية تقول إن البضاعة ضاعت عندنا، والمرتجع يقول إن المورد استعادها — والثاني وحده يدخل بما ندين له.

- `GET /inventory/receipts/:id/returnable` — ما يزال قابلاً للإرجاع بكل سطر: `received_base` − `returned_base` = `returnable_base`، مع تكلفة الوحدة كما دخلت. محسوب بالخادم فلا تعرض الشاشة كمية سيرفضها.
- `POST /inventory/returns` `{receipt_id, note, lines:[{variant_id, qty_base}]}` → `PRT-<فرع>-000001`. **مقيّم بتكلفة الفاتورة لا بمتوسط الرف** (المورد يُدان بما قبضه)، والملاحظة **إلزامية**. يُرحّل `return_to_supplier` سالباً، ومتوسط التكلفة لا يُمسّ (الإخراج لا يعيد حساب المتوسط).
- `GET /inventory/returns?branch_id&supplier_id&receipt_id` · `GET /inventory/returns/:id`.

رفضان، والترتيب مقصود: `422 return_exceeds_receipt` (+`data.returnable_base`) يُفحص **قبل** `409 return_exceeds_stock` (+`data.available`) — «لم نشتر منك هذا القدر» حقيقة ثابتة، أما «ليس على الرفّ» فقد يعني أنه بيع، وهذا حديث آخر. و`422 return_not_on_receipt` لصنف ليس على تلك الفاتورة.

## 25. تصفّح الزبون (2026-09-23) · المرجع: `docs/reference/store_system.md` §٨

**كل مسارات `/storefront/*` عامة** — الضيف يرى المتجر كاملاً بأسعاره وحالات توفّره (§٨)، والبوابة حيث يتحرّك المال لا حيث يُقرأ الرف. والتوكن — إن أُرسل — يغيّر شيئاً واحداً: **الزبون المعتمَد جملةً يرى سعر جملته أيضاً**، ويُقرأ اعتماده من صفّه لا من الطلب (علمٌ يرسله العميل خصمٌ يطلبه أي أحد).

**الفرع إلزامي بكل قراءة عن منتج**: التوفّر حقيقة عن مكان، والسعر يختلف بالفرع. وفرعٌ مغلق أو مؤرشف ← `404 branch_not_shoppable` («اختر فرعاً آخر») لا كتالوج لا يستطيع أحد تسليمه.

**السعر لا يُحسب هنا**: موديول المتجر يسأل منفذ `core/pricing/price-port.ts`، والكتالوج يسجّل المُجيب (`installCatalogPriceResolver`). نسخة ثانية من «أي سعر يسود» كانت ستختلف أول تعديل، والاختلاف رقمٌ معقول على الرف بلا أي فشل.

**حالات التوفّر السبع** (`services/availability-rules.ts`، ٩ اختبارات، كل حالة مع نقيضها):

| الحالة | متى | ما يحمله الصف |
|---|---|---|
| `available` | مطروح ومسعَّر و`on_hand − reserved` > ٥ | السعر |
| `low_stock` | ≤ ٥ (وأكثر من صفر) | `remaining` — الرقم يُقال بصوت عالٍ |
| `out_here_available_elsewhere` | نفد هنا وموجود بفرع حيّ آخر | `other_branch{id,name,distance_km}` |
| `out_everywhere` | نفد بكل مكان | — |
| `not_listed_here` | مسحوب من هذا الفرع | فرعٌ يبيعه، **وإلا يُخفى الصف كلّه** |
| `unpriced` | بلا سعر (أو سعر دولار بلا سعر صرف) | **لا يصل الزبون أبداً** — الصف يُخفى، والإشارة للإدارة |
| `discontinued` | منتج متقاعد | يُخفى من التصفّح ويبقى قابلاً للفتح من طلب قديم |

**والرصيد المحجوز يُخصم**: المعروض `on_hand − reserved`، فبضاعةٌ وعدنا بها طلباً مؤكَّداً ليست على الرف للزبون التالي. **والسالب صفر** بحسبة العرض — تناقضٌ جوابه جرد، لا كمية تُباع.

**حالة المنتج أفضلُ حالات متغيّراته**: لونٌ نفد من خمسة ليس «نفد»، وقوله يُخفي أربعة على الرف.

- `GET /storefront/categories` — الشجرة بأعداد المنتجات الحيّة، **والأب يحمل مجموع أبنائه** (تصنيفٌ لا منتج تحته مباشرةً ليس ممراً مسدوداً).
- `GET /storefront/collections` — الرفوف الظاهرة **الآن** (مفعَّلة وداخل نافذتها) بأعدادها.
- `GET /storefront/products?branch_id&category_id&collection_id&search&page&limit&lat&lng` — الصف: `{id, name_ar, name_en, brand_name, category_id, thumbnail, availability, price{amount_syp, wholesale?}, remaining, other_branch, variant_count}`. التصنيف يشمل **أبناءه**، والبحث بالعربية المطوية والمرادفات. **والصفّ غير القابل للبيع هنا يُستبعد بالاستعلام نفسه** لا بعد التصفيح: إسقاطه بعد الترقيم يُنتج صفحةً فارغة تحت `total: 9` — وصفحةٌ فارغة تُقرأ عطلاً لا «لم يُسعَّر شيء بعد».
- `GET /storefront/products/:id?branch_id&lat&lng` — المنتج متغيّراً متغيّراً: صوره (والمتغيّر بلا صورة يأخذ صور منتجه)، وحالته وسعره ووحداته المتاحة أونلاين بسعر كلٍّ منها.

`lat`/`lng` اختياريان **ونصفهما مرفوض** (`422`): إحداثية بلا أختها تضع الزبون على خط الاستواء فتسمّي أبعد فرع «الأقرب». وبلا إحداثيات يُسمّى الفرع بلا مسافة — الاسم وحده يستحق القول.

**الاقتراحات** (§٨): `GET /storefront/products/:id` يحمل `alternatives` — **ولا يحملها إلا حين لا يستطيع الزبون الشراء هنا**. اقتراحٌ بجانب بضاعة متوفّرة يزاحم ما جاء الزبون لأجله، وبجانب «نفد» هو الفرق بين طريق مسدود وبيعٍ آخر. المرشّحون: **من نفس التصنيف، وعلى رفّ هذا الفرع فعلاً** (اقتراحٌ نافد هو الطريق المسدود نفسه)، وأقربهم سعراً لما كان ينظر إليه — «بديل» بضعف الثمن ليس بديلاً — وأرخص متغيّر يمثّل منتجه، بسقف خمسة.

**«أعلمني عند التوفّر» و«اطلب توفيره بفرعي»** — جدول `storefront_demand` (`0028`). الغاية واحدة: **النقص يصير معلومة يتصرّف بها أحد**؛ بلا هذا تبقى «نفد حالياً» نهايةَ الحديث — يغادر الزبون ولا يعرف أحد أنه جاء.

- `POST /storefront/interest` `{variant_id, branch_id, kind: notify|request_here}` — **للمسجَّل وحده** (`requireCustomer`، قرار 2026-09-23: الإشعار يصل بقناة الحساب القائمة، ورقمٌ يكتبه ضيف يفتح قناة ثانية غير مبنيّة). وليست `requireVerifiedCustomer`: طلبُ خبرٍ ليس شراءً. **والطلب مرّة واحدة** لكل (زبون × صنف × فرع × نوع) — الضغط مرتين يُعيد الصف نفسه، وإلا صار «١٢ زبوناً» رقماً يصنعه واحد بأصابعه. وصنفٌ لا يُباع ← `404`.
- `GET /storefront/interest?branch_id` — طلبات هذا الزبون بهذا الفرع؛ بها تعرف الشاشة أن الزرّ صار «أُلغِ الطلب». وتسافر أيضاً مع صفحة المنتج (`my_requests`).
- `DELETE /storefront/interest/:id` — طلبُ غيرك لا يُحذف، وغير الموجود `404`.
- `GET /storefront/demand?branch_id` — **وجه المدير**، بحارس `inventory.view`. مجمَّع لكل صنف: `notify_count` (نفد بكل مكان ← الجواب شراء) · `request_count` (موجود بفرع آخر ← الجواب نقل) · `waiting_days` لأقدم طلب · `on_hand` الآن (طلبٌ لبضاعة وصلت يُغلق بلا أي أمر). **الأقدم أولاً**، والمُعلَم به يخرج — عدّادٌ يشمل ما أُجيب عنه أرشيفٌ لا طابور.

**ولا نقل تلقائياً** (قرار 2026-09-23): أمر نقل لكل طلب زبون يُغرق الفروع بأوامر صغيرة، والقرار يبقى بيد من يرى العدد والعمر والرصيد معاً.

**وحالتان لا تغادران الخادم بهذا الاسم**: `unpriced` و`not_published` تُرسَلان `not_listed_here` (§٨) — «غير مسعَّر» عطلٌ عندنا لا حقيقة عن البضاعة، والترجمة **بالخادم** لأن عميلاً آخر (متجر ويب لاحقاً) كان سيقرأ الاسم الداخلي ويعرضه كما هو.

---

## 26. العروض (2026-09-23) · المرجع: `docs/reference/store_system.md` §٥

**العرض قاعدة مؤقتة تعلو السعر، لا سعرٌ ثانٍ.** كتابته كسعر ينتهي بتاريخ كانت ستجعل انتهاءه يحتاج من يمسحه، والعرض المنسيّ يبقى يبيع بخسارة. هنا الانتهاء **غياب**: نافذةٌ مغلقة ⇒ لا ينطبق، والسعر الأصلي يعود بلا أي كتابة.

**مفتاحان**: `promotions.view` للقراءة (الكاشير يُسأل «لماذا هذا السعر؟» فيحتاج أن يقرأ، لا أن يغيّر) و`promotions.edit` للكتابة. والسقوف تحت `pricing.policy` — من يضع قواعد التسعير يقرّر كم يملك الفرع أن يخصم.

| الحقل | القيم |
|---|---|
| `scope` | `all_branches` · `branches` (+`branch_ids`) — و«فرعٌ واحد» صفٌّ واحد بالقائمة، لا قيمةٌ ثالثة |
| `target_kind` + `target_id` | `variant` · `product` · `category` (**يرث للأبناء**) · `brand` — **هدفٌ واحد بالضبط** يفرضه قيد `promotion_one_target` |
| `kind` | `percent` · `amount` · `qty_tiers` (+`tiers[]`) · `buy_x_get_y` (+`buy_qty`/`get_qty`/`get_percent`) |
| `starts_at` / `ends_at` | `null` = بلا حدّ. و`ends_at` **لحظة التوقّف** لا آخر لحظة سريان (نفس قاعدة `Collection`) |
| `channel` | `online` · `pos` · `both` — عرض الكاشير الذي يظهر بالمتجر يُخسِّر مرتين |
| `segment` | `retail` · `wholesale` · `all` |
| `is_stackable` | `false` افتراضياً |

**والكوبون مؤجَّل** (قرار 2026-09-23): رمزٌ يُدخله الزبون عند الدفع، ولا دفع بعد — عمودٌ بلا مكانٍ يُكتب فيه هو «المبنيّ بلا مستهلك» بعينه.

### ما يقرّره الخادم وحده (`services/promotion-rules.ts` — ١٩ اختباراً، كل حالة مع نقيضها)

- **الأفضل للزبون**: غير المتراكم يُختار منه **واحد** (الأكبر خصماً، ثم الأدقّ هدفاً، ثم الأقدم — فالجواب لا يتغيّر بترتيب الصفوف). جمعُ عرضين لم يُعلَن تراكمهما هو كيف يصير الصنف مجانياً بلا أن يقصد ذلك أحد.
- **المتراكم يُطبَّق على المتبقّي** لا بجمع النسب: خصمان ٥٠٪ يعطيان ٧٥٪ لا ١٠٠٪.
- **المبلغ مسقوف بسعر الوحدة**: حسمٌ أكبر من السعر يعني متجراً يدفع لمن يأخذ بضاعته، ورقمٌ سالب يمرّ بكل جمعٍ بعده بلا اعتراض.
- **شرائح الكمية تأخذ الأعلى انطباقاً** لا مجموعها.
- **`buy_x_get_y` لا يُحسب بسعر البند إطلاقاً**: المجموعة = `buy_qty + get_qty`، والهدية تُقيَّم **بالسعر بعد الخصم** (بالسعر قبله كان مجموع السطر يصير سالباً).

### المسارات

- `GET /promotions?search&branch_id&kind&status&archived&page&limit` — الأحدث أولاً. الصف يحمل `status` (`live`·`scheduled`·`ended`·`inactive`·`archived`) و`target_label` (**اسم** الهدف لا رقمه) و`max_discount_percent` (أقصى ما يصل إليه العرض — به يُقارن عرضان بلا حساب يدوي) و`is_deletable`/`is_archivable` من الخادم.
- `POST /promotions` · `PUT /promotions/:id` — **كل الحقول بكل كتابة** (لا `PATCH` جزئي): العرض مجموعة قواعد تُقرأ معاً، وتعديل نوعه بلا قيمه يترك نسبة عرضٍ قديم على عرض مبلغ. والردّ `{promotion, loss_warnings[]}`.
- `POST /promotions/:id/archive {archived}` — قابل للعكس. والمؤرشف **لا يُعدَّل** (`409 promotion_archived`).
- `DELETE /promotions/:id`
- `GET /promotions/caps` · `PUT /promotions/caps {branch_id, max_discount_percent}` — **نسبة واحدة لكل فرع** (قرار 2026-09-23؛ سقفٌ لكل «فرع × تصنيف» كان أدقّ وجدولاً ثانياً بوراثةٍ وشاشةً لإدارته). الافتراضي ٢٠٪، والصف يقول `is_default` — «١٥٪» المكتوبة تختلف عن الموروثة.
- `GET /promotions/targets?kind&search&limit` — **ما يصلح هدفاً**: متغيّر (باسم منتجه وSKU) · منتج · تصنيف · ماركة، بحثاً بالخادم. يعيش بموديول العروض لا بالكتالوج لأن المنتقي يحتاج صفّاً بعنوانه فقط، **وقراءة جدول موديول آخر مسموحة بينما قراءة خدمته ليست** (نفس حلّ `GET /inventory/document-items`). وبلا هذا المسار كانت شاشة العرض تستورد كتالوجاً كاملاً لتعرض قائمة أسماء.
- `GET /promotions/signals` — `{live, ending_soon, never_ending, scheduled}`. **و«بلا نهاية» إشارةٌ لا خطأ**: العرض المنسيّ هو الذي يبيع بخسارة شهوراً.
- `POST /promotions/preview {branch_id, channel, segment, lines[]}` — **السلّة الافتراضية**: تُسعّر سلّةً مفترضة بكل العروض السارية وتردّ لكل سطر `unit_before_syp`/`unit_after_syp`/`applied[]`/`free`/`line_total_syp`/`avg_cost_syp`/`below_cost`. وهي **المستدعي الحيّ** لمحرّك السلّة — «اشترِ ٣ خذ ١» لا يظهر بسعر بندٍ ولا بصفحة منتج، فبلا هذا المسار كان يُحفظ ولا يراه أحد يعمل حتى تُبنى السلّة. وهي نفسها ما تستدعيه السلّة يوم تُبنى: دالّةٌ واحدة تُسعّر سلّة، لا نسخة للمعاينة وأخرى للبيع.

### الرفض والسقف والخسارة

| الحالة | الردّ |
|---|---|
| عرضٌ فرعي يتجاوز سقف فرعه | `409 promotion_above_branch_cap` + `{branch_id, cap_percent, promotion_percent}` — «مرفوض» بلا رقمٍ يجعل المحاولة التالية تخميناً. **والصفّ يُمحى** فلا يبقى عرضٌ مرفوضٌ ظاهرٌ بالقائمة |
| النوع بلا قيمه | `422 promotion_percent_required` · `promotion_amount_required` · `promotion_tiers_required` · `promotion_bxgy_required` — الرسالة تسمّي الحقل الناقص |
| شريحة بنسبة **ومبلغ** معاً (أو بلا أيٍّ منهما) | `422 promotion_tier_value_invalid` |
| نطاق `branches` بلا فرع | `422 promotion_branches_required` |
| `ends_at` قبل `starts_at` | `422` — وبقيدٍ بالقاعدة أيضاً (`promotion_window_ordered`) |

**والسقف يقيّد الفرعي وحده**: الإدارة التي تحدّده لا تُحَدّ به، وإلا احتاج كل عرض مركزي رفعَ السقف ثم إعادته — وتلك دقيقةٌ يبقى فيها السقف مرفوعاً لكل الفروع.

**وحارس الخسارة يحذّر ولا يمنع** (قرار 2026-09-23): البيع بخسارة قرارٌ تجاري مشروع (تصريف بضاعة راكدة)، والمنعُ يُلتَفّ عليه بتعديل السعر المركزي — وهناك يختفي الأثر تماماً: لا عرض ولا تحذير ولا إشارة، سعرٌ منخفض فحسب. والتكلفة تصل من منفذ `core/costing/cost-port.ts` يسجّله المخزون، و**التكلفة الغائبة `null` لا صفر**: صنفٌ لم يُستلم قط تُصيّره المقارنةُ بصفر خسارةً دائمة، ولوحةٌ تحذّر دائماً لا يقرؤها أحد.

### ما يصل الزبون

`price` بكل ردود `/storefront/*` صار يحمل `was_syp` و`promotion_names[]`. **و`null` لا صفر**: بطاقةٌ تقول «خصم ٠ ل.س» تُقرأ عرضاً وتُرسل من يبحث عنه. والاسم يسافر مع الرقم لأن «٥٬٠٠٠ بدل ٦٬٠٠٠» بلا سبب تُقرأ خطأً بالسعر.

**والعرض يُطبَّق بمنفذ `core/promotions/promotion-port.ts`** داخل حلّ السعر نفسه، لا بموديول المتجر: تطبيقه هناك وحده كان سيترك كل مستهلك آخر للسعر يعرض الرقم قبل العرض — والفرق يظهر رقماً معقولاً بمكان وآخر بمكان، بلا أي فشل. و`PriceContext.promotions` (`apply` | `ignore`) **إلزامي** لأن حارس الخسارة والمعاينة يحتاجان السعر قبل العرض: قيمةٌ افتراضية كانت ستخصم مرتين بأحد الطرفين وتنقص بالآخر، وكلا الرقمين معقول.

---

## 27. نقطة البيع والفاتورة (2026-09-24) · المرجع: `docs/reference/orders_delivery.md` §الفوترة · `store_system.md` §٦

**ثلاثة مفاتيح**: `sales.sell` يفتح سلّة ويسدّدها (الكاشير) · `sales.view` يقرأ الفواتير (المحاسب لا يبيع) · `sales.manage` يضع سقوف الخصم وحدود الآجل (قرار مالي لا يملكه من يقف على الصندوق).

### السلّة

**السلّة صفٌّ بالخادم بحالة `open`، بلا رقم فاتورة وبلا حجز مخزون** (قرار 2026-09-24). صرفُ الرقم عند الفتح يعني رقماً لكل سلّة تُلغى — وتلك هي الفجوة بعينها: مدقّقٌ يرى `000122` ثم `000124` لا يعرف أن الثالثة لم تكن بيعاً. والحجزُ عند الفتح يُخفي بضاعةً عن الرفّ لسلّةٍ نسيها صاحبها.

| الحالة | ماذا تعني |
|---|---|
| `open` | تُبنى الآن على جهاز الكاشير |
| `held` | **مُعلَّقة**: انتقل لزبون آخر وهي تنتظر. زبونٌ نسي محفظته بالسيارة يوقف الطابور كلّه دونها |
| `paid` | سُدِّدت — وهنا وحدها يُصرَف الرقم وتغادر البضاعة |
| `void` | أُلغيت قبل السداد؛ لا رقم صُرف فلا فجوة |

- `POST /sales {branch_id, customer_id?, customer_name?}` — العابر بلا حساب **يُكتب اسمه ولا يُنشأ له زبون**.
- `GET /sales/open?branch_id` — سلّات **هذا الكاشير** وحده: سلّةُ زميلٍ تُقرأ هنا «نسيتُها» فتُلغى، وصاحبها واقفٌ عند الصندوق الآخر.
- `GET /sales/items?branch_id&search` — **ما يصلح لسطر بيع**، بسعره بالفرع ورصيده، بحثاً بالاسم أو الـSKU أو **الباركود تماماً**. يعيش بموديول المبيعات لا بالكتالوج: الصندوق يحتاج صفّاً بسعره، وقراءة **جدول** موديول آخر مسموحة بينما قراءة خدمته ليست (نفس حلّ `document-items` و`promotions/targets`). والصفّ الذي طابق رمزاً تماماً يُعلَّم `exact_barcode` — **مسحةٌ واحدة تُضيف صنفاً واحداً** بدل أن تعرض خمسة أسماء يقرؤها الكاشير. و«غير مسعَّر» يصل `price_syp: null` لا صفراً: صفرٌ يُقرأ مجاناً ويضيفه الكاشير.
- `POST /sales/:id/lines {variant_id, qty, unit_id?}` — **السعر يُقرأ من الخادم لا من الجهاز**: ثمنٌ يرسله العميل خصمٌ يكتبه من يمسك الجهاز، ولا شيء بالفاتورة يقول إنه اختُرع. ومسحُ الصنف مرتين **يزيد الكمية** ولا يضيف سطراً (سطران بخمسة يفوّتان شريحة العشرة، ويقرأ الزبون صنفه مرتين).
- `PATCH /sales/:id/lines/:lineId {qty}` — **صفرٌ يحذف السطر**: سطرٌ بصفر يُطبع بالإيصال ويُربك من يعدّ الأكياس.
- `DELETE /sales/:id/lines/:lineId` · `POST /sales/:id/hold {held}` · `POST /sales/:id/void`

### السطر لقطةٌ كاملة

اسم الصنف وSKU والوحدة ومعاملها والسعر وخصم العرض واسمه ونسبة الضريبة والتكلفة — **كلها منسوخة بالسطر** لا مقروءة بانضمام. منتجٌ يُعاد تسميته أو يُرفع سعره بعد شهر لا يغيّر فاتورةً طُبعت، وفاتورةٌ تُعيد قراءة الكتالوج تروي كل شهر قصةً مختلفة عن اليوم نفسه.

**والمجاميع تُحسب حيّاً ما دامت السلّة مفتوحة، وتُجمَّد عند السداد.** إعادة حساب فاتورةٍ مدفوعة بعد شهر تقرأ عرضاً انتهى وسعراً تغيّر فتقول رقماً آخر؛ وقراءةُ سلّةٍ مفتوحة من عمودٍ محفوظ تعرض مجموعاً لا يتبع السطر الذي أُضيف للتوّ.

### الضريبة (§١١)

**تُستخرَج من داخل السعر لا تُضاف فوقه**: السعر المعروض شاملٌ لها بعرف المستهلك، فـ`total × rate / (100 + rate)` لا `total × rate / 100`. إضافتُها فوقه تجعل الزبون يدفع ضريبة الضريبة، والفرق يمرّ بلا اعتراض لأن كل رقم بالإيصال يبدو معقولاً. **وتُحسب على المدفوع بعد الخصم** لا على المعلن، وإلا ورّد المتجر ضريبة مالٍ لم يقبضه.

### الخصم اليدوي (§٦)

**نسبةٌ على الدور لا مفتاح صلاحية**: RBAC يجيب بنعم/لا، و«كم تستطيع أن تخصم؟» سؤالٌ جوابه نسبة. والدور بلا صفّ = **صفر**، فكاشيرٌ جديد لا يخصم حتى تقرّر الإدارة.

- `GET /sales/discount-check?percent` — **ثلاثة أجوبة لا اثنان**: `within_cap` · `needs_approval` · `refused`. جمعُ الأخيرين يجعل الكاشير يستدعي مديراً لخصمٍ لن يُقبل بأي حال، والزبون ينتظر مقابل لا شيء. يُسأل **قبل** أن يَعِد الكاشير بشيء.
- `POST /sales/:id/discount {percent, reason, approver_user_id?}` — **السبب إلزامي مع أي نسبة فوق صفر** (`422 sale_discount_reason_required`): «خصم ١٥٪» بلا سبب لا يُدقَّق.
- `POST /sales/:id/discount/approve {percent, reason, email, password}` — **موافقة المدير على نفس الجهاز**: يُتحقَّق من بريده وكلمة مروره وأن حسابه **فعّال**، ويُكتب اسمه **بالفاتورة** لا بسجلّ جانبي. **ولا يُصدر جلسة**: توكنٌ ثانٍ على جهاز الكاشير يبقى بعد انصراف المدير، وهو بالضبط ما تتفاداه «الموافقة بنفس الجهاز». والرفض **واحد لكل الأسباب** (`403 sale_approval_refused`) — تمييزها يقول لمن يجرّب أي البريدين موجود.
- **والموافِق يُفحص بسقفه لا بصفته**: مديرٌ سقفه ١٥٪ لا يوافق على ٢٥٪ (`403 sale_approver_cap_too_low`)، وإلا صارت صفة الموافقة مفتاحاً بلا حدّ.

**والخصم يُوزَّع على السطور بنسبة أنصبتها ويُجمَّد بكلٍّ منها.** التوزيع ليس تجميلاً: المرتجع (7-ج) يُرجع **بالسعر المدفوع فعلاً** لا بالمعلن (§٢)، فسطرٌ بلا حصّته يُرجَع بأكثر مما دُفع فيه — والفرق يخرج من الدرج بلا أن يفشل شيء. **وفرق التقريب يُسوَّى على أكبر سطر** فيبقى مجموع السطور مساوياً للمجموع المعروض بالضبط.

### السداد

`POST /sales/:id/pay {payments[]}` — أربع طرق بجدولٍ منفصل: `cash` · `card` · `customer_credit` · `on_account`. **جدولٌ لا عمود**: فاتورةٌ تُسدَّد نصفها نقداً ونصفها بطاقةً حالةٌ عادية بمحل، وعمودٌ واحد كان سيجبر الكاشير على الكذب.

**والباقي من النقد وحده**: بطاقةٌ تُمرَّر بمبلغٍ محدَّد لا تُرجع فكّة، وحسابُه من المجموع يُنقص الدرج كلما دُفع ببطاقة. و`tendered_syp` يُحفظ مع المبلغ فالدرج يُطابَق.

**والسداد يفعل أربعة أشياء بمعاملة واحدة**: يصرف الرقم · يجمّد المجاميع وحصص الخصم · يُخرج البضاعة عبر منفذ `core/stock/stock-port.ts` **بمعاملة الفاتورة نفسها** · يقيّد دفتر الزبون. فصلُ أيٍّ منها يترك فاتورةً لبضاعة ما زالت بالدفتر، أو بضاعةً غادرت بلا ما يقول لمن — والدفتر يكفّ عن كونه قابلاً لإعادة البناء، وهي الخاصّة الوحيدة التي وُجد لأجلها.

**والرقم `MZ-2026-000123`**: بادئة الفرع (حرفان لاتينيان من اسمه، وإلا `BR<id>`) ثم السنة ثم ستّ خانات. التسلسل يبدأ من واحد **بكل سنة**، ويُصرَف من صفٍّ مقفَل بـ`ON CONFLICT … DO UPDATE` داخل معاملة السداد — `max(number)+1` يعطي كاشيرين متزامنين الرقم نفسه فيفشل أحدهما بعد أن سلّم البضاعة.

| الرفض | المعنى |
|---|---|
| `422 sale_underpaid` + `{remaining_syp, total_syp}` | المدفوع لا يغطّي — والرقم يقول كم بقي فلا تكون المحاولة التالية تخميناً |
| `422 sale_empty` | سلّة فارغة لا تُسدَّد |
| `409 sale_already_paid` | الفاتورة المدفوعة **لا تُعدَّل ولا تُحذف** (§١): الإلغاء بمرتجع |
| `409 sale_item_unpriced` | الصنف بلا سعر بهذا الفرع — والجواب تسعيرٌ لا إعادة مسح |

### حساب الزبون

**دفترٌ يُضاف إليه ولا يُعدَّل** (`customer_ledger_entries`)، كدفتر المخزون. الرصيد **مجموع صفوفه** لا عمودٌ يُحدَّث: عمودٌ واحد يفقد «لماذا صار كذا»، وأول خطأ فيه لا يُكتشف لأن لا شيء يُقارَن به.

**والإشارة تحمل المعنى**: موجبٌ = للزبون عندنا رصيد · سالبٌ = علينا نطالبه. دفتران منفصلان كانا سيسمحان بزبونٍ له رصيدٌ ودَينٌ معاً.

- `GET /customers/:id/account` — الرصيد والسقف و`spendable_syp` (الموجب وحده — الدَّين لا يُنفَق) و`available_credit_syp` (`limit + balance`: زبونٌ سقفه ١٠٠٬٠٠٠ وعليه ٣٠٬٠٠٠ يملك ٧٠٬٠٠٠) وآخر ٥٠ قيداً.
- `PUT /customers/:id/account/limit {limit_syp}` — **والزبون بلا صفّ = بلا آجل إطلاقاً**: سقفٌ افتراضي مفتوح يُقرض كل زبون بصمت.
- `POST /customers/:id/account/entries {amount_syp, note}` — تسديد ذمّة أو إيداع رصيد؛ قيدٌ يُضاف بسببه ومن كتبه.

**والآجل والرصيد يحتاجان زبوناً مسمّى** (`422 sale_credit_needs_customer`): آجلٌ على «زبون عابر» دَينٌ على لا أحد.
