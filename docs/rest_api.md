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
| 429       | Rate limit             | `RateLimitError`، يضبط header `Retry-After` (ثواني) — **مفعّل حالياً فقط على `POST /login`** (`core/middleware/login-rate-limit.ts`، in-memory، 5 محاولات/15 دقيقة لكل إيميل وIP) |
| ≥500      | خطأ سيرفر              | أي خطأ غير متوقع (يُسجَّل كاملاً باللوجر، الرسالة للعميل عامة)                       |
| 4xx أخرى  | Business error عام     | `BusinessError`                                                                      |

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

✅ **مفعّل** (2026-07-27) — كل طلب مُصادَق يتحقق أيضاً من `users.status` لصاحب الجلسة (`JOIN` مباشر بـ`core/middleware/auth.ts`)، ليس فقط من وجود التوكن. أي حالة غير `active` (`suspended`/`disabled`/`rejected`/`pending_approval`) تُعامَل مطابقة تماماً لتوكن غير موجود (`req.user = null` → `401` عبر `requireAuth`/`requirePermission`)، **مع حذف صفّ الجلسة من `sessions` بنفس اللحظة** (تنظيف استباقي، يمنع إعادة نفس الفحص الفاشل لاحقاً). هذا يسد فجوة كانت موجودة سابقاً: قبل هذا التاريخ، تعطيل مستخدم (`POST /:id/disable`) لم يكن يفعل شيئاً لجلسته النشطة الحالية — كان يبقى قادراً على العمل حتى انتهاء TTL (افتراضياً 7 أيام). الآن: أول طلب تالٍ من المستخدم المُعطَّل (أي endpoint) يُرفض فوراً. مصدر القرار الكامل: [docs/reference/session_permission_integrity.md](../../docs/reference/session_permission_integrity.md) §5/§10.

### 7.2 حماية كل Endpoint — ثلاث مستويات

| المستوى | الدالة | يعني |
|---|---|---|
| **عام (Public)** | لا شيء | لا يتطلب توكن إطلاقاً — فقط `POST /register`, `POST /login`, `POST /bootstrap-super-admin`, `POST /logout` |
| **مسجّل دخول فقط** | `requireAuth` | يتطلب توكن صالح، بدون فحص صلاحية محدّدة — تُستخدم لعمليات القراءة (`GET`) بمعظمها |
| **صلاحية محدّدة (RBAC)** | `requirePermission('<key>')` | يتطلب توكن صالح **و** أن يملك اليوزر المفتاح المطلوب ضمن اتحاد (union) صلاحيات كل تعييناته الفعّالة (`findAllEffectivePermissionKeys`, `user-role-assignments.repository.ts`) — Allow-only، بدون تقييد فرع لعمليات identity نفسها (branch-agnostic) |

**مفاتيح صلاحيات identity الجديدة** (أُضيفت للكتالوج 2026-07-23 — `core/db/seed.ts`، Super Admin يملكها تلقائياً):

| المفتاح | يحمي |
|---|---|
| `users.manage` | `decide-registration`, `suspend`, `disable`, `reactivate`, إنشاء/نقل/إنهاء `UserRoleAssignment` |
| `branches.manage` | إنشاء/تعديل فرع |
| `ownerships.manage` | تسجيل نسبة ملكية |
| `permissions.manage` | إضافة صلاحية جديدة للكتالوج |
| `roles.view` / `roles.edit` (موجودة أصلاً) | قراءة/كتابة الأدوار وصلاحياتها |
| `audit_log.view` (موجود أصلاً) | قراءة سجل التدقيق |
| `localization.manage` (أُضيفت مع موديول Localization) | إضافة/تعديل لغة ديناميكية، تعطيلها، وتحديث (upsert) ترجماتها |
| `dashboard.view` (أُضيفت 2026-07-29) | الوصول لـ `GET /api/v1/dashboard` — كل بلوك داخل الاستجابة مشروط إضافياً بصلاحية الموديول المطابقة (`users.manage`/`branches.manage`/`roles.view`) |

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
  "is_active": true,
  "is_admin": false,
  "is_root_protected": false,
  "mfa_enabled": false,
  "status": "pending_approval",
  "rejection_reason": null,
  "requested_role_id": 5,
  "requested_branch_id": null,
  "requested_ownership_percentage": null,
  "submitted_at": "2026-01-01T00:00:00.000Z",
  "decided_at": null,
  "decided_by_user_id": null,
  "created_at": "2026-01-01T00:00:00.000Z"
}
```

مصدر الالتزام: `AuthUserModel` الفعلي بالفرونت + [docs/reference/users_complete_reference.md](../../docs/reference/users_complete_reference.md) بالفرونت (المخطط الكامل لقواعد اليوزرات). `full_name` **مشتق** (`first_name + ' ' + last_name`)، غير مخزّن كعمود DB. `password_hash`/`password_reset_token` **لا تظهر أبداً** بالـwire — يُستبعدان صراحة بـ`toWireUser`.

`status`: `pending_approval` | `active` | `suspended` | `rejected` | `disabled`.

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
  "created_at": "2026-01-01T00:00:00.000Z",
  "permissions": [
    { "key": "inventory.view", "module": "inventory", "is_sensitive": false, "created_at": "..." }
  ]
}
```

`permissions` موجود فقط بـ`GET /roles/:id` وبعد إنشاء/تعديل دور — غائب بقائمة `GET /roles` (لتفادي N+1 غير ضروري).

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
  "created_at": "..."
}
```

`status`: `active` | `temporarily_closed` | `closed`.

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

## Endpoints الحالية

> المصدر المعماري الكامل لكل قاعدة عمل خلف هذه الـendpoints: [docs/reference/users_roles.md](../../docs/reference/users_roles.md) و[users_complete_reference.md](../../docs/reference/users_complete_reference.md).

### Users & Authentication — `/api/v1/users`

| Method | Path                       | الحماية | ملاحظة                                                                                                            |
| ------ | -------------------------- | --- | ----------------------------------------------------------------------------------------------------------------- |
| GET    | `/`                        | 🔒 مسجّل دخول | قائمة مُصفّحة (`Paginated<User>`)                                                                                 |
| GET    | `/me`                      | 🔒 مسجّل دخول | **بيانات المستخدم الحالي نفسه** — `{user, permission_keys}` (نفس شكل بيانات `login` بدون `token`/`session_id`). يعيد استخدام نفس `findAllEffectivePermissionKeys` المستخدم بـ`login`. مُسجَّل **قبل** `/:id` كي لا يُبتلَع بمسار الـparam. الاستخدام الأساسي: تحقق خلفي صامت بالفرونت بعد استعادة جلسة مخبّأة (**✅ 2026-07-27**، انظر [docs/reference/session_permission_integrity.md](../../docs/reference/session_permission_integrity.md) §6/§10) |
| GET    | `/:id`                     | 🔒 مسجّل دخول | يوزر واحد أو 404                                                                                                  |
| POST   | `/`                        | 🔑 `users.manage` | **إنشاء مباشر من الأدمن** — يختلف عن `/register` (تسجيل ذاتي + مراجعة لاحقة). هنا الأدمن يُنشئ الحساب مباشرة لصالح شخص آخر بخطوة واحدة: `status=active` فوراً مع `role_id` (إلزامي) و`branch_id`/`ownership_percentage` (اختياريان) مُعيَّنة في نفس الطلب — الأدمن نفسه هو الموافقة، لا حاجة لـ`decide-registration` بعدها. تعارض إيميل → `409`، دور غير موجود/غير فعّال → `404`/`422` |
| PATCH  | `/:id`                     | 🔑 `users.manage` | تعديل حقول الهوية/البروفايل فقط (`first_name`/`last_name`/`email`/`phone`) — **لا** `status`/`is_admin`/كلمة المرور (لكل منها endpoint مخصص: suspend/disable/reactivate/decide-registration للحالة، وتدفق منفصل خارج النطاق لكلمة المرور). تعارض إيميل مع يوزر آخر → `409`. الهدف `is_root_protected=true` → `403` دائماً، بلا استثناء لأي منفِّذ (**✅ 2026-07-27**) |
| POST   | `/register`                | 🌐 عام | **التسجيل الذاتي** — نقطة الدخول الوحيدة لأي حساب موظف/شريك (self-service). ينشئ `status=pending_approval` بدون أي صلاحية فعّالة، يحتاج مراجعة أدمن لاحقاً عبر `decide-registration`. **مختلف عن `POST /` أعلاه** (إنشاء مباشر من الأدمن، فعّال فوراً بدون مراجعة) |
| POST   | `/bootstrap-super-admin`   | 🌐 عام | Setup Wizard — ينجح **فقط** لو عدد اليوزرز بالنظام = صفر. ينشئ Super Admin + Ownership 100% + `is_root_protected=true` (المسار الوحيد الذي يضبط هذا الحقل — **✅ 2026-07-27**) |
| POST   | `/login`                   | 🌐 عام + Rate Limit | إيميل + كلمة مرور → `{user, token, session_id, permission_keys}`. `token` يُستخدم كـ`Authorization: Bearer <token>` بأي طلب لاحق. `permission_keys` هو اتحاد صلاحيات كل تعيينات اليوزر الفعّالة (نفس مصدر `findAllEffectivePermissionKeys` المستخدم بـ`requirePermission`، branch-agnostic) — **✅ 2026-07-27**، يُستهلك بالفرونت لتحديد أي UI مُصرَّح بها فوراً بعد الدخول دون طلب إضافي. **✅ محدَّث (2026-07-28)**: `pending_approval`/`rejected` الآن ينجحان (`200`) ويحصلان على جلسة حقيقية بدل `403` — الحساب يبقى قابل للوصول (شاشة "حالة الطلب"، تعديل وإعادة إرسال) حتى بعد حذف/إعادة تثبيت التطبيق؛ الجلسة لا تفتح أي endpoint محمي فعلياً لأن `permission_keys` تبقى `[]` دائماً (صفر `UserRoleAssignment` فعّال لهاتين الحالتين). فقط `suspended`/`disabled` يبقيان يرفضان بـ**403** مع `data.account_status` للتمييز البرمجي (انظر التفصيل تحت الجدول — لا تعتمد على مطابقة نص `message`). **محدود بـ5 محاولات/15 دقيقة لكل إيميل و5/15 دقيقة لكل IP معاً** (`core/middleware/login-rate-limit.ts`) — تجاوز أي منهما → `429` مع `Retry-After` بالثواني. النجاح يصفّر عدّاد ذاك الإيميل/IP فوراً |
| POST   | `/logout`                  | 🌐 عام | ينهي الجلسة الحالية فقط (حسب التوكن بالـheader) — بقية جلسات نفس اليوزر تبقى شغّالة. Idempotent (200 حتى لو التوكن أصلاً غير صالح) |
| POST   | `/me/resubmit-registration` | 🔒 مسجّل دخول | **✅ جديد (2026-07-28)** — إعادة تسجيل حساب `rejected` (نفس اليوزر المسجَّل دخوله فقط، عبر الجلسة لا `:id`). يقبل `requested_role_id` (إلزامي)/`requested_branch_id`/`requested_ownership_percentage` (نفس شكل `/register`، بدون حقول الهوية/كلمة المرور). يرجّع `status: rejected → pending_approval` ويصفّر `rejection_reason`/`decided_at`/`decided_by_user_id`. `409` لو الحساب مو `rejected` حالياً |
| POST   | `/:id/decide-registration` | 🔑 `users.manage` | قرار الأدمن على طلب معلّق: `approve` (كما هو أو بتعديل الدور/الفرع/النسبة) أو `reject` (سبب إلزامي) |
| POST   | `/:id/suspend`             | 🔑 `users.manage` | إيقاف مؤقت وقابل للرجوع (تحقيق/إجازة) — يختلف عن `disable`. الهدف `is_root_protected=true` → `403` دائماً (**✅ 2026-07-27**) |
| POST   | `/:id/disable`             | 🔑 `users.manage` | تعطيل دائم (Offboarding) — لا حذف فعلي أبداً. الهدف `is_root_protected=true` → `403` دائماً (**✅ 2026-07-27**)   |
| POST   | `/:id/reactivate`          | 🔑 `users.manage` | من `suspended` أو `disabled` إلى `active` — بدون إنشاء حساب جديد. نفس فحص `is_root_protected` مضاف للاتساق مع باقي عمليات الحالة (نظرياً غير قابل للحدوث لحساب جذري بما إنه لا يصل أصلاً لـ`suspended`/`disabled`) |

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

### Role Assignments — `/api/v1/users/:userId/role-assignments` و`/api/v1/role-assignments`

| Method | Path                                       | الحماية | ملاحظة                                                                                                              |
| ------ | ------------------------------------------ | --- | ------------------------------------------------------------------------------------------------------------------- |
| GET    | `/users/:userId/role-assignments`          | 🔒 مسجّل دخول | التعيينات الفعّالة حالياً لهذا اليوزر                                                                               |
| POST   | `/users/:userId/role-assignments`          | 🔑 `users.manage` | تعيين دور جديد (يخضع لفحص منع تصعيد الصلاحيات نسبة لمستوى المنفّذ)                                                  |
| POST   | `/role-assignments/:assignmentId/transfer` | 🔑 `users.manage` | نقل فرع/دور — يقفل التعيين الحالي ويفتح واحد جديد (لا يعدّل `branch_id` مباشرة). محجوب لو "آخر موظف مؤهل" بدون بديل |
| POST   | `/role-assignments/:assignmentId/end`      | 🔑 `users.manage` | إنهاء تعيين (Offboarding). نفس حاجز "آخر موظف مؤهل"                                                                 |

> **حاجز «آخر موظف مؤهل» (409 `last_qualified_staff`) يسري على الأدوار البنيوية بالفروع العاملة فقط** (محسوم 2026-08-04):
>
> | فئة الدور | محكوم؟ | لماذا |
> |---|---|---|
> | `management` (مدير الفرع) | ✅ | المسؤول عن الفرع — فرع بلا مدير لا أحد يقرر فيه |
> | `system` (المدير العام/مدقق) | ✅ | سلطة على مستوى المنظمة — إطلاق آخر حامل يقفل النظام على كل الإداريين |
> | `operational` · `financial` · `external` | ❌ **حرّة** | تُغيَّر وتُنقَل وتُنهى بلا بديل — لا شيء يُفقد، التعيين يُغلق (`valid_to`) ولا يُحذف |
>
> **لماذا لم تعد موحَّدة**: قرار 2026-07-09 رفض تقسيماً **وظيفياً** («إنتاجي» مقابل «بيعي») وكلاهما `operational`. هذا تقسيم **بنيوي** (مسؤول مقابل طاقم) — محور مختلف. تطبيق الحاجز على كل الأدوار كان يجعل أي دور يُدخَل إلى فرع التزاماً دائماً: تُضيف «خدمة العملاء» لفرع فلا تستطيع إزالتها أبداً. يُرفض `transfer`/`end` إذا لم يوجد حامل آخر (`users.status = active`، تعيين فعّال) لنفس `(role_id, branch_id)` — وهذا مقصود: منع ترك طابور الفرع بلا أحد مؤهل لإكماله (`users_roles.md` §Scenarios). لكنه **يُتخطّى إذا كانت حالة الفرع ليست `active`** (`temporarily_closed` أو `closed`)، لأن الفرع المتوقف لا طابور له، ولأن تطبيقه هناك يقفل مسار الإغلاق الموثّق (§Flow.2): الإغلاق النهائي يشترط تصفية كل التعيينات، وآخر حامل لأي دور ما كان ليُصفّى أبداً. التعيينات غير المقيّدة (`branch_id IS NULL`) تبقى محكومة بالحاجز دائماً — لا فرع لها لتُعفى بحالته.
>
> **مسار إفراغ فرع:** حوِّل حالته إلى `temporarily_closed` أولاً → انقل/أنهِ تعييناته → ثم `closed`.

> **`POST /users/:userId/role-assignments` يفتح تعييناً إضافياً، ولا يمسّ القائم.** الشخص قد يحمل أكثر من دور، أو نفس الدور بأكثر من فرع — وهذا المسار الوحيد لإضافة موقع بلا التخلّي عن الآخر (النقل يُغلق الحالي). يُرفض بـ`409 assignment_duplicate` لو كان يحمل نفس `(role_id, branch_id)` فعلاً؛ الفحص بالـservice ليقرأ الرفض كقاعدة لا كانهيار، والضمان الحقيقي هو الفهرس الفريد الجزئي بالقاعدة (يغطي التسابق).
>
> **هذا أيضاً مخرج الرفض بـ`last_qualified_staff`**: الحارس يُرفَع بمجرد وجود حامل ثانٍ لنفس `(role_id, branch_id)`، وهذا الـendpoint هو ما يُنشئه.

> **`POST /users/:userId/role-assignments` هو أداة تشغيل الفرع الفارغ.** الفرع بلا طاقم مشكلة **تنسيب** لا **توظيف** — والمنظمة غالباً تملك أشخاصاً بلا انتماء (`?unassigned=true`). لذلك تعرض لوحة معالجة الفرع بالفرونت «إسناد موظف موجود» **قبل** «إنشاء موظف جديد»: إنشاء حساب يخترع شخصاً غير موجود. الجسم `{ role_id, branch_id }` و`branch_id: null` تعني وصولاً غير مقيّد لكل الفروع.

### Roles — `/api/v1/roles`

| Method | Path               | الحماية | ملاحظة                                                                                                    |
| ------ | ------------------ | --- | --------------------------------------------------------------------------------------------------------- |
| GET    | `/`                | 🔑 `roles.view` | قائمة مُصفّحة (بدون `permissions` بالعنصر)                                                                |
| GET    | `/:id`             | 🔑 `roles.view` | دور واحد مع `permissions` كاملة                                                                           |
| POST   | `/`                | 🔑 `roles.edit` | إنشاء دور — اسم فريد إلزامي، تحذير-موقف لو نفس مجموعة الصلاحيات لدور فعّال موجود (تجاوز بـ`force: true`)  |
| PUT    | `/:id/permissions` | 🔑 `roles.edit` | استبدال كامل لصلاحيات الدور — رجعي فوري على كل المعيّنين، يُسجَّل بـAudit Log لو لمس صلاحية `isSensitive` |
| PUT    | `/:id/level`       | 🔑 `roles.edit` + Super Admin | **Super Admin حصراً** (فحص إضافي بالـservice نفسه فوق `requirePermission`) — تعديل `level` خارج فحص المستوى النسبي المعتاد (سد ثغرة تصعيد الصلاحيات) |
| POST   | `/:id/deactivate`  | 🔑 `roles.edit` | تعطيل (لا حذف) — يُرفض لو فيه تعيينات فعّالة، أو لو الدور Super Admin                                     |

**`POST /`** body:

```json
{
  "name": "Custom Role",
  "category": "operational",
  "permission_keys": ["inventory.view"],
  "clone_from_role_id": 5,
  "force": false
}
```

### Permissions — `/api/v1/permissions`

| Method | Path | الحماية | ملاحظة                                               |
| ------ | ---- | --- | ---------------------------------------------------- |
| GET    | `/`  | 🔒 مسجّل دخول | الكتالوج الكامل (متعمّد أن يكبر تدريجياً)            |
| POST   | `/`  | 🔑 `permissions.manage` | إضافة صلاحية جديدة — المفتاح يلتزم بـ`module.action` |

### Branches — `/api/v1/branches`

| Method | Path   | الحماية | ملاحظة                  |
| ------ | ------ | --- | ----------------------- |
| GET    | `/`    | 🔒 مسجّل دخول | قائمة مُصفّحة           |
| GET    | `/:id` | 🔒 مسجّل دخول | فرع واحد أو 404         |
| GET    | `/:id/staff` | 🔑 `users.manage` | طاقم الفرع مُصفّحاً — صف لكل تعيين فعّال (أدناه) |

> **⚠️ تغيير كاسر (2026-08-04)** — `GET /users` و`GET /users/:id` و`GET /users/:userId/role-assignments` انتقلت من 🔒 `requireAuth` إلى 🔑 `users.manage`. كانت الحمولة دليل المنظمة كاملاً متاحاً لأي حامل توكن صالح (`production_readiness.md` §A1). `GET /users/me` **لم يتغيّر** — بيانات المستخدم عن نفسه تبقى مفتوحة.
>
> **سجل التدقيق**: كل طفرة بموديول `identity` تُسجَّل الآن بـ`audit_log_entries` (١٥ إجراءً، الكتالوج بـ`services/audit-actions.ts`). أي endpoint جديد يُحدِث تغييراً يجب أن يستدعي `auditService.record` — الفاعل يصل عبر `buildActorContext(req, requireActorId(req))` من الـcontroller.
| POST   | `/`    | 🔑 `branches.manage` | إنشاء فرع               |
| PATCH  | `/:id` | 🔑 `branches.manage` | تعديل بيانات/حالة الفرع — الانتقال إلى `closed` مشروط (أدناه) |

> **`GET /:id/staff` — محمي بـ`users.manage` لا `branches.manage`.** الحمولة قائمة أشخاص (اسم، إيميل، حالة حساب)، وقراءة سجل الفرع غير قراءة طاقمه — الصلاحية تتبع البيانات المكشوفة، نفس الحدّ الذي ترسمه كتلة `structure` باللوحة.
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
| GET    | `/`  | 🔑 `dashboard.view` | إحصائيات مجمّعة لواجهة لوحة التحكم — كل بلوك أعلى-مستوى (`users`/`branches`/`roles`/`charts`/`structure`/`signals`) يظهر فقط لو المستخدم يملك أيضاً صلاحية الموديول المطابقة (`users.manage`/`branches.manage`/`roles.view`) — نفس رؤية شاشة القائمة التي تفتحها كل بطاقة، وليس فحصاً منفصلاً. البلوك الغائب لا يظهر بالـJSON إطلاقاً (وليس صفراً) |

**بوابة الصلاحيات لكل بلوك:**

| البلوك | يتطلب |
| --- | --- |
| `users` | `users.manage` |
| `branches` | `branches.manage` |
| `roles` | `roles.view` |
| `charts.users_per_branch` | `users.manage` + `branches.manage` |
| `charts.users_per_role` | `users.manage` + `roles.view` |
| `structure` | `users.manage` **و** `branches.manage` معاً — يغطي محورَي علاقة (فرع × دور) فلا يكفيه أحدهما |
| `signals` | `users.manage` **أو** `branches.manage` — كل إشارة تُدرَج فقط إن توفّرت صلاحية مصدرها |

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

**مثال ثانٍ** — مستخدم يملك `users.manage` + `roles.view` فقط (بلا `branches.manage`): تختفي `branches` و`structure` و`charts.users_per_branch` بالكامل، وتبقى إشارات `users` فقط:

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
| GET    | `/`                         | 🔒 مسجّل دخول | اللغات **الفعّالة فقط** — `code`/`name`/`is_rtl`/`version`. غير مُصفّحة عمداً (قائمة مرجعية صغيرة، نفس منطق `GET /permissions`). هذا ما يستطلعه التطبيق عند الإقلاع لمقارنة الإصدارات |
| GET    | `/:code`                    | 🔒 مسجّل دخول | لغة واحدة (شاشة إدارة فقط — يشمل اللغات المُعطَّلة أيضاً)، أو 404                                          |
| GET    | `/:code/translations`       | 🔒 مسجّل دخول | خريطة الترجمة الكاملة الحالية للغة: `{code, version, translations: {key: value}}` — **whole-file، بدون `since`/delta بهذا الإصدار الأول**. 404 لو الكود غير موجود **أو** اللغة معطّلة (نفس المعاملة، لا فرق للعميل) |
| POST   | `/`                         | 🔑 `localization.manage` | إضافة لغة ديناميكية جديدة — `code` فريد، يُرفض 409 لو مكرر                                                |
| PATCH  | `/:code`                    | 🔑 `localization.manage` | تعديل `name`/`is_rtl` فقط (لا يمس `version`/`is_active`)                                                  |
| PUT    | `/:code/translations`       | 🔑 `localization.manage` | **Upsert جزئي**: يضيف/يحدّث فقط المفاتيح المُرسَلة، لا يمس مفاتيح أخرى موجودة. أي استدعاء ناجح يرفع `version` رقماً واحداً دائماً — هذا هو إشارة إبطال الكاش التي يستطلعها `GET /` |
| POST   | `/:code/deactivate`         | 🔑 `localization.manage` | تعطيل (`is_active=false`) — لا حذف فعلي. اللغة تختفي فوراً من `GET /` وتُعامَل كـ404 بـ`GET /:code/translations` |

**`POST /`** body:

```json
{ "code": "fr", "name": "Français", "is_rtl": false }
```

**`PUT /:code/translations`** body:

```json
{ "translations": { "welcomeBack": "Bon retour", "login": "Connexion" } }
```

**`GET /:code/translations`** response (`data`):

```json
{ "code": "fr", "version": 2, "translations": { "welcomeBack": "Bon retour", "login": "Connexion" } }
```

> 🌐 عام = بدون توكن. 🔒 مسجّل دخول = `Authorization: Bearer <token>` صالح فقط، أي يوزر. 🔑 `<key>` = توكن صالح **و** المفتاح ضمن صلاحيات اليوزر الفعّالة (`requirePermission`, راجع §7.2).

### `GET /health`

فحص حياة بسيط، خارج نطاق `/api/v1` عمداً. رد: `{status:true, message:"OK", data:{uptime}}`.

> ✅ **Auth حقيقي مفعّل** (2026-07-23) — كل endpoint تتطلب "actor" (منشئ دور، مقرر تسجيل، ناقل تعيين...) تعمل الآن فعلياً: مرّر `Authorization: Bearer <token>` (من `POST /login`) وإلا `401 Unauthorized`. راجع §7 أعلاه لتفاصيل آلية التحقق (`core/middleware/auth.ts`).
