# src/features/CLAUDE.md — Feature Module Pattern

> جزء من [../../CLAUDE.md](../../CLAUDE.md). النمط المعياري لأي feature module جديدة.

---

## تشريح المجلد (6 مجلدات فرعية لكل feature)

```
features/<name>/
├── routes/<name>.routes.ts           ← Express Router، يربط path + middleware + controller
├── controllers/<name>.controller.ts  ← يقرأ req، يستدعي service، يبني response (ok/created)
├── services/<name>.service.ts        ← منطق العمل، يرمي ApiError عند الفشل، يستدعي repository
├── repositories/<name>.repository.ts ← الاستعلامات الفعلية (drizzle) — الوحيد الذي يلمس DB مباشرة
├── schemas/<name>.schema.ts          ← drizzle pgTable + الأنواع المشتقة (UserRow, NewUserRow, ...)
└── dtos/<name>.dto.ts                ← zod schemas للتحقق (params/query/body) + دالة row→wire mapper
```

**مثال حي كامل**: `features/identity/` — موديول كامل بـ9 كيانات مترابطة (users/roles/permissions/role_permissions/user_role_assignments/branches/ownerships/audit_log_entries/sessions)، بمنطق عمل حقيقي (منع تصعيد صلاحيات، حواجز تكامل بيانات، تدفقات موافقة). لملف واحد كبير (زي `users.schema.ts` أو `users.service.ts`)، الأنماط أعلاه لسه سارية — فقط الملف يحوي أكثر من كيان/دالة مرتبطة منطقياً بدل تجزئتها لملفات بايتة. انسخ نفس التشريح (6 مجلدات فرعية) لأي feature جديدة.

---

## قواعد صارمة

- **الطبقات باتجاه واحد فقط**: `routes → controller → service → repository`. الـcontroller **لا يستدعي repository مباشرة**، ولا يبني استعلام DB بنفسه.
- **الـcontrollers رفيعة** — تحويل req→params، استدعاء service، تمرير النتيجة لـ`ok()`/`created()`. لا منطق عمل هنا.
- **حقول الـwire دايماً snake_case** (`first_name`, `is_active`, `created_at`, ...) — يطابق عقد الفرونت الفعلي. التحويل من/إلى shape الداخلي (لو احتجته) يصير بـ`dtos/`.
- **فيتشر لا يستورد repository/service فيتشر ثانية أبداً** (مطابق لقاعدة الفرونت "Features → Features ❌"). لو فيتشرين يحتاجون نفس المنطق، انقله لـ`src/core/` كـshared utility.
- **كل route محمي مستقبلاً يمر عبر `core/middleware/auth.stub.ts` الحالي** (بدون حجب فعلي الآن) — لا تبني آلية auth خاصة بالفيتشر نفسها.
- **التحقق (validation) عبر `core/validation/validate.ts` + zod schema بـ`dtos/`** — لا تحقق يدوي متفرق بالـcontroller.

---

## قواعد CRUD الموحّدة (List / Get / Create / Update / Delete)

> الهدف: كل عملية من النوع ده تتكتب بنفس الشكل في كل موديول، بحيث أي حد يقرأ موديول جديد يتعرف فورًا على النمط من غير ما يقرأ التفاصيل. **التوحيد قواعد + هيلبر صغير لأكتر جزء متكرر حرفيًا (List/GetById) — مش factory عام يفرض بنية على كل الحالات.**

### 1) List (`GET /`)

- الـ**repository**: لازم يستخدم `findManyPaginated(table, params)` من `src/core/db/crud-helpers.ts` — ما تكتبش `Promise.all([select, count])` يدويًا من جديد. مثال (`branches.repository.ts`):
  ```ts
  export function findMany(
    params: PaginationParams,
  ): Promise<{ rows: BranchRow[]; total: number }> {
    return findManyPaginated<BranchRow>(branchesTable, params);
  }
  ```
- الـ**service**: يستدعي الـrepository، يحوّل كل صف لـwire عبر `toWire<X>`، ويرجّع عبر `paginated()` من `core/pagination/pagination.ts`.
- الـ**controller**: `toPaginationParams(req.query)` → `service.list<X>(params)` → `ok(res, result)`.
- الـ**route**: `validate(paginationQuerySchema, 'query')` قبل `asyncHandler`.
- فلترة إضافية (زي `?branch_scope=` بـOwnerships) تُضاف كـquery schema منفصل خاص بالموديول — مش جزء من الهيلبر المشترك.

### 2) Get by ID (`GET /:id`)

- الـ**repository**: لازم يستخدم `findOneById(table, table.id, id)` من نفس الملف. مثال:
  ```ts
  export function findById(id: number): Promise<BranchRow | undefined> {
    return findOneById<BranchRow>(branchesTable, branchesTable.id, id);
  }
  ```
- الـ**service**: لو `undefined` → `throw new NotFoundError('<X> not found')` **فورًا**، وإلا يرجّع `toWire<X>(row)`. صياغة الرسالة دايمًا `"<X> not found"` (نفس الأسلوب بكل موديول، يسهّل التتبع بالـlogs).
- **مفيش استثناء**: كل `get<X>ById` بيرمي `NotFoundError` بنفس الشكل، حتى لو بعدها بيضيف بيانات مرتبطة (زي `roles.service.ts` اللي بيجيب الـpermissions الكاملة بعد التأكد من وجود الدور).

### 3) Create (`POST /`)

- الـ**repository**: `insert(data)` — بيرمي `Error` عادي (مش `ApiError`) لو الـ`.returning()` رجّع مصفوفة فاضية (حالة مستحيلة عمليًا، دي حماية دفاعية بس مش business error). النمط الثابت:
  ```ts
  export async function insert(data: NewXRow): Promise<XRow> {
    const rows = await db.insert(xTable).values(data).returning();
    const row = rows[0];
    if (!row) throw new Error('Insert did not return a row');
    return row;
  }
  ```
- الـ**service**: أي تحقق عمل (uniqueness، حدود، صلاحيات) **قبل** الـinsert، ويرمي `ApiError` subclass مناسب (`BusinessError(409, ...)` للتعارض، `NotFoundError` لو مرجع لكيان مش موجود، إلخ) — **لا تحقق بالـrepository نفسه**، الطبقة دي تنفيذ خام بس.
- الـ**controller**: يستدعي `service.create<X>(body)` ويرجّع عبر `created(res, result)` (كود 201)، مش `ok()`.
- الـ**route**: `validate(create<X>BodySchema, 'body')`.

### 4) Update (`PATCH`/`PUT /:id`)

- الـ**repository**: `update(id, data: Partial<NewXRow>)` — نمط ثابت (`db.update(table).set(data).where(eq(table.id, id)).returning()`, يرجّع `rows[0]` بدون رمي خطأ لو مش موجود — الفحص مسؤولية الـservice).
- الـ**service**: يتأكد إن الكيان موجود الأول (أو يعتمد على `undefined` الراجع من `update` نفسها) ويرمي `NotFoundError` عند الحاجة. أي قاعدة عمل (منع تعديل حقل معيّن، تحقق تكامل) هنا.
- **تعديل جزئي مقابل استبدال كامل**: لو التعديل بسيط (زي `branches.updateBranch`) استخدم `PATCH` بجسم اختياري الحقول. لو التعديل استبدال كامل لعلاقة (زي `roles.updateRolePermissions` اللي بيستبدل كل الصلاحيات دفعة واحدة) استخدم `PUT` على sub-resource مخصص (`/:id/permissions`) بدل تحميل كل شيء على `PATCH /:id` العام.
- الـ**controller/route**: نفس نمط Create، لكن `ok()` (200) مش `created()`.

### 5) Delete — تعطيل هو الافتراضي، حذف فعلي مسار موازٍ موثّق (مش استثناء عشوائي)

**الافتراضي: لا يوجد Hard Delete.**
- القاعدة الحاكمة (راجع `docs/reference/users_roles.md`): أي كيان له نشاط تاريخي أو علاقات (users, roles, branches, ownerships...) **يُعطَّل (`is_active=false` / `status='disabled'`)**، **لا يُحذف فعليًا** من الداتابيز.
- النمط: `deactivate<X>(id)` بالـservice — يتأكد من عدم وجود موانع (تعيينات فعّالة، كيان محمي كـSuper Admin...) **قبل** التعطيل، ويرمي `BusinessError(409, ...)` أو `ForbiddenError` عند الرفض. الـrepository بيعرّض `setActive(id, false)` بسيطة، القرار بالكامل بالـservice.
- الـ**route**: `POST /:id/deactivate` — مش `DELETE` — عشان يوضح إنها عملية حالة مش حذف فعلي.

**متى حذف فعلي بـID (`DELETE /:id`) مقبول** — الثلاثة شروط دول لازم يتحققوا **مع بعض**، مش أي واحد لوحده:

1. **بدون أي قيمة تاريخية/تدقيقية بوجوده** — مفيش حد هيحتاج يرجع لهذا السجل لاحقاً (خلاف الـ"موظف اتسجل غلط ومعملش نشاط" — ده مثال على الشرط ده، مش الشرط الوحيد).
2. **العلاقات (Foreign Keys) اللي بتشاور عليه معروفة ومقصودة** — إما مفيش FK بيشاور عليه أصلاً، أو الموجود منها `ON DELETE CASCADE`/`SET NULL` بقرار واعي (مش افتراضي درزل بدون تفكير).
3. **فيه سبب عملي واضح للحذف الفعلي** — مسودة، بيانات اختبار، أو كيان "قابل للتصرف" بطبيعته (خلاف user/role/order اللي طبيعتها الاحتفاظ بالسجل).

**نمط الكود لو الشروط اتحققت:**
- الـ**repository**: دالة صريحة الاسم `hardDelete(id)` (**مش** `remove`/`delete` غامضة الاسم) — `db.delete(table).where(eq(table.id, id))`.
- الـ**service**: يتأكد من الشروط الثلاثة **فعلياً بالكود** قبل الاستدعاء (مش بس تعليق) — مثلاً يفحص عدم وجود سجلات مرتبطة عبر استعلام صريح، ويرمي `BusinessError(409, ...)` واضح لو فيه اعتماديات. **لازم تعليق بالكود يوثّق ليه الحذف الفعلي مقبول هنا تحديداً** (أي الشروط الثلاثة اتحققت وإزاي).
- الـ**route**: `DELETE /:id` — الفعل HTTP الصريح، بعكس التعطيل (`POST /:id/deactivate`) — الفرق بالفعل نفسه يعكس الفرق بالخطورة والقابلية للرجوع.
- الـ**controller**: يرجّع `noContentOk(res)` (200، `data: null`) مش `ok(res, row)` — مفيش كيان يترجع لأنه اتحذف فعلاً.
- **دايماً وثّق في `<name>.openapi.ts`**: `description` توضح الشروط اللي خلت الحذف الفعلي مقبول لهذا الكيان تحديداً، مش سطر عام.

**الخلاصة العملية**: لو مش متأكد إن الشروط التلاتة متحققة، اختار التعطيل — التعطيل رجعي (ينفع تفكّه)، الحذف الفعلي مش رجعي. القرار ده لكل كيان لوحده وقت بناء الـfeature، مش نمط عام يتكرر تلقائياً زي List/Create.

---

## كيفية إضافة Feature جديدة (checklist)

```
[ ] schemas/<name>.schema.ts — عرّف الجدول (drizzle pgTable)
[ ] صدّره بـ src/core/db/schema.ts (barrel)
[ ] npm run db:generate && npm run db:migrate
[ ] repositories/<name>.repository.ts — findMany/findById عبر crud-helpers (§CRUD أعلاه)، الباقي استعلامات drizzle خام
[ ] dtos/<name>.dto.ts — zod schemas (request) + <x>ResponseSchema (لتوليد OpenAPI) + row→wire mapper
[ ] services/<name>.service.ts — منطق العمل، يرمي ApiError عند الفشل — Delete = تعطيل، لا حذف فعلي (§CRUD)
[ ] controllers/<name>.controller.ts — رفيع، يستدعي service فقط
[ ] routes/<name>.routes.ts — يربط validate() + asyncHandler() + controller
[ ] mount بـ src/app.ts (app.use('/api/v1/<name>', <name>Router))
[ ] <name>.openapi.ts — سجّل كل route بـregistry.registerPath (راجع core/CLAUDE.md §OpenAPI) + استورده بـ core/openapi/document.ts
[ ] حدّث docs/rest_api.md بالـendpoints الجديدة
[ ] حدّث جدول Modules بـ ../../CLAUDE.md
```
