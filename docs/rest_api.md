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
> **⚠️ وحالة التوصيل**: المشروع **بلا مرسل بريد** (لا nodemailer ولا مزوّد). التنفيذ يمرّ بمنفذ `PasswordResetDelivery` (`core/notifications/`) ومحوّله الحالي **يكتب الرمز بالسجل بالتطوير فقط**، ويرفض العمل بـ`production` مع سطر خطأ صريح. الإطلاق يتطلب محوّلاً حقيقياً — ملف واحد وسطر تبديل واحد.

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
