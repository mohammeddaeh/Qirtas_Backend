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
| 401 / 403 | Unauthorized/Forbidden | 401 على `/login` تحديداً = بيانات دخول خاطئة (لا يوجد `/login` بهذا الـskeleton بعد) |
| 404       | غير موجود              | `NotFoundError`                                                                      |
| 408       | Timeout                | غير مستخدم بأي endpoint حالياً                                                       |
| 409       | Conflict               | **محجوز** لميزة sync مستقبلية — انظر §5                                              |
| 422       | Validation             | `ValidationError`، دائماً مع `errors`                                                |
| 429       | Rate limit             | `RateLimitError`، يضبط header `Retry-After` (ثواني)                                  |
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

## 7. Auth Headers (لأي endpoint محمي مستقبلاً)

```
Authorization: Bearer <token>
Accept-language: ar | en
```

⚠️ لا يوجد Auth حقيقي بهذا الـskeleton — `src/core/middleware/auth.stub.ts` يقرأ الـheader لكن لا يتحقق منه. `Accept-language` يُقرأ فعلياً الآن (`req.lang`، افتراضي `ar`).

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

## 9. شكل `Role`

```json
{
  "id": 1,
  "name": "Branch Manager",
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

## Endpoints الحالية

> المصدر المعماري الكامل لكل قاعدة عمل خلف هذه الـendpoints: [docs/reference/users_roles.md](../../docs/reference/users_roles.md) و[users_complete_reference.md](../../docs/reference/users_complete_reference.md).

### Users & Authentication — `/api/v1/users`

| Method | Path                       | ملاحظة                                                                                                            |
| ------ | -------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| GET    | `/`                        | قائمة مُصفّحة (`Paginated<User>`)                                                                                 |
| GET    | `/:id`                     | يوزر واحد أو 404                                                                                                  |
| POST   | `/register`                | **التسجيل الذاتي** — نقطة الدخول الوحيدة لأي حساب موظف/شريك. ينشئ `status=pending_approval` بدون أي صلاحية فعّالة |
| POST   | `/bootstrap-super-admin`   | Setup Wizard — ينجح **فقط** لو عدد اليوزرز بالنظام = صفر. ينشئ Super Admin + Ownership 100%                       |
| POST   | `/login`                   | إيميل + كلمة مرور → `{user, session_id}`. يرفض `pending_approval`/`rejected`/`suspended`/`disabled` برسالة واضحة لكل حالة |
| POST   | `/:id/decide-registration` | قرار الأدمن على طلب معلّق: `approve` (كما هو أو بتعديل الدور/الفرع/النسبة) أو `reject` (سبب إلزامي)               |
| POST   | `/:id/suspend`             | إيقاف مؤقت وقابل للرجوع (تحقيق/إجازة) — يختلف عن `disable`                                                        |
| POST   | `/:id/disable`             | تعطيل دائم (Offboarding) — لا حذف فعلي أبداً                                                                      |
| POST   | `/:id/reactivate`          | من `suspended` أو `disabled` إلى `active` — بدون إنشاء حساب جديد                                                  |

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

**`POST /:id/decide-registration`** body (discriminated union بـ`decision`):

```json
{ "decision": "approve", "role_id": 5, "branch_id": 1, "ownership_percentage": 10 }
```

```json
{ "decision": "reject", "reason": "..." }
```

عند الموافقة: `role_id`/`branch_id`/`ownership_percentage` اختيارية — تفتراضياً تُستخدم القيم المطلوبة أصلاً وقت التسجيل، والأدمن يقدر يغيّرها بالكامل قبل التفعيل.

### Role Assignments — `/api/v1/users/:userId/role-assignments` و`/api/v1/role-assignments`

| Method | Path                                       | ملاحظة                                                                                                              |
| ------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| GET    | `/users/:userId/role-assignments`          | التعيينات الفعّالة حالياً لهذا اليوزر                                                                               |
| POST   | `/users/:userId/role-assignments`          | تعيين دور جديد (يخضع لفحص منع تصعيد الصلاحيات نسبة لمستوى المنفّذ)                                                  |
| POST   | `/role-assignments/:assignmentId/transfer` | نقل فرع/دور — يقفل التعيين الحالي ويفتح واحد جديد (لا يعدّل `branch_id` مباشرة). محجوب لو "آخر موظف مؤهل" بدون بديل |
| POST   | `/role-assignments/:assignmentId/end`      | إنهاء تعيين (Offboarding). نفس حاجز "آخر موظف مؤهل"                                                                 |

### Roles — `/api/v1/roles`

| Method | Path               | ملاحظة                                                                                                    |
| ------ | ------------------ | --------------------------------------------------------------------------------------------------------- |
| GET    | `/`                | قائمة مُصفّحة (بدون `permissions` بالعنصر)                                                                |
| GET    | `/:id`             | دور واحد مع `permissions` كاملة                                                                           |
| POST   | `/`                | إنشاء دور — اسم فريد إلزامي، تحذير-موقف لو نفس مجموعة الصلاحيات لدور فعّال موجود (تجاوز بـ`force: true`)  |
| PUT    | `/:id/permissions` | استبدال كامل لصلاحيات الدور — رجعي فوري على كل المعيّنين، يُسجَّل بـAudit Log لو لمس صلاحية `isSensitive` |
| PUT    | `/:id/level`       | **Super Admin حصراً** — تعديل `level` خارج فحص المستوى النسبي المعتاد (سد ثغرة تصعيد الصلاحيات)           |
| POST   | `/:id/deactivate`  | تعطيل (لا حذف) — يُرفض لو فيه تعيينات فعّالة، أو لو الدور Super Admin                                     |

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

| Method | Path | ملاحظة                                               |
| ------ | ---- | ---------------------------------------------------- |
| GET    | `/`  | الكتالوج الكامل (متعمّد أن يكبر تدريجياً)            |
| POST   | `/`  | إضافة صلاحية جديدة — المفتاح يلتزم بـ`module.action` |

### Branches — `/api/v1/branches`

| Method | Path   | ملاحظة                  |
| ------ | ------ | ----------------------- |
| GET    | `/`    | قائمة مُصفّحة           |
| GET    | `/:id` | فرع واحد أو 404         |
| POST   | `/`    | إنشاء فرع               |
| PATCH  | `/:id` | تعديل بيانات/حالة الفرع |

### Ownerships — `/api/v1/ownerships`

| Method | Path | ملاحظة                                                                                         |
| ------ | ---- | ---------------------------------------------------------------------------------------------- |
| GET    | `/`  | السجلات الفعّالة، فلترة اختيارية بـ`?branch_scope=`                                            |
| POST   | `/`  | تسجيل نسبة ملكية — **منع صارم**: أي حفظ يجعل مجموع النسب الفعّالة للنطاق يتجاوز 100% يُرفض 422 |

### Audit Log — `/api/v1/audit-log`

| Method | Path | ملاحظة                                                        |
| ------ | ---- | ------------------------------------------------------------- |
| GET    | `/`  | قائمة مُصفّحة، فلترة اختيارية بـ`?user_id=`/`?target_entity=` |

### `GET /health`

فحص حياة بسيط، خارج نطاق `/api/v1` عمداً. رد: `{status:true, message:"OK", data:{uptime}}`.

> ⚠️ لا يوجد Auth حقيقي بعد — كل endpoint تتطلب "actor" (منشئ دور، مقرر تسجيل، ناقل تعيين...) ترمي `401 Unauthorized` حالياً لأن `req.user` دائماً `null` (`auth.stub.ts`). هذا **متعمّد**: الشكل الخارجي جاهز، وسيعمل فوراً بمجرد تفعيل Auth حقيقي بدون أي تعديل بطبقة الـfeature.
