# CLAUDE.md — Node Backend (Qirtas)

> هذا الملف جذري وسليم — التفاصيل الفعلية بملفات CLAUDE.md الفرعية داخل `src/`.
> Backend TypeScript + Express + PostgreSQL + Drizzle ORM لخدمة تطبيق Flutter بـ`../qirtas_app`.

---

## 🗂️ جدول القرار

| إذا كنت تبني…                                                          | اقرأ                                                                      |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **Feature module** جديد (routes/controller/service/repository)         | `src/features/CLAUDE.md`                                                  |
| **بنية تحتية مشتركة** (envelope/error/db/pagination/config/middleware) | `src/core/CLAUDE.md`                                                      |
| أي شيء يمس **عقد REST** (endpoint/response/error shape)                | `docs/rest_api.md` (مرجعي — الملف الوحيد الذي يُفحص عنده أي تغيير بالعقد) |
| **DB schema / migration** جديدة                                        | `src/core/CLAUDE.md` §DB                                                  |
| **Scripts / tooling** جديدة                                            | `docs/scripts.md`                                                         |
| البنية العامة / شجرة المجلدات                                          | `docs/architecture.md`                                                    |
| **إرسال بريد** (تحقّق/استعادة كلمة مرور · SMTP · تغيير المزوّد · الإنتاج) | `docs/mail.md` — **لا يوجد متغيّر مستقبِل، ولا يجوز إضافة واحد** |

---

## Modules موجودة

| المسار                   | ما تفعله                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/features/identity/` | **Users, Roles & Permissions (RBAC) — الموديول التأسيسي الكامل**: users (تسجيل ذاتي + موافقة أدمن + auth)، roles، permissions، user_role_assignments، branches، ownerships، audit_log_entries، sessions. مصدر قواعد العمل الكامل: [docs/reference/users_roles.md](../docs/reference/users_roles.md) و[users_complete_reference.md](../docs/reference/users_complete_reference.md) — **المثال الحي المرجعي** لأي feature جديدة (6 مجلدات فرعية × 9 كيانات) |
| `src/features/auth/` | **الواجهة HTTP للمصادقة فقط** (routes/controllers/dtos/openapi) — كل المنطق بـ`src/core/auth/`. تخدم: `/auth/refresh` · `/auth/sessions` (عرض/إبطال/خروج من الباقي) · `/auth/verify-email` · `/auth/resend-verification` · `/auth/forgot-password` · `/auth/reset-password` · `/auth/change-password`. **`login`/`logout` ليسا هنا** — بقيا بـ`identity` لأن ردّهما يحمل `permission_keys`/`is_super_admin` (تخويل لا مصادقة)، ويفوّضان المصادقة لنفس خدمة `core/auth` |
| `src/features/localization/` | **Dynamic (Remote) Localization** — `languages` + `translation_entries`: يخدم أي لغة إضافية بعد ar/en بالكامل (لا قيمة أساسية محلية لها)، **و** يخدم أيضاً طبقة "Override" اختيارية فوق ar/en نفسيهما (اللتان تبقيان compile-time بالفرونت كقيمة أساسية مضمونة أوفلاين دائماً — الـoverride طبقة إضافية غير مُلزِمة فوقها، لا بديل عنها) — انظر §13 (أسماء الصلاحيات) و§15 (أي نص واجهة عادي) بالمرجع أدناه. `GET /languages` (غير مُصفّحة، فعّالة فقط) هو استطلاع الإصدار الذي يتحقق منه التطبيق عند الإقلاع؛ `GET /:code/translations` يرجّع خريطة الترجمة الكاملة (whole-file، لا `since`)؛ `PUT /:code/translations` يرفع `version` تلقائياً كإشارة إبطال كاش. صلاحية `localization.manage` للكتابة. مصدر القرار المعماري الكامل: [docs/reference/dynamic_localization.md](../docs/reference/dynamic_localization.md) (Model 2 — نظامان متوازيان لأي لغة إضافية؛ Local-First with Remote Override لكل اللغات بما فيها ar/en) |

| `src/features/dashboard/` | **قراءة مجمَّعة واحدة** (`GET /dashboard`، `dashboard.view`) تُغذّي شاشة اللوحة بالفرونت: العدّادات + توزيع المستخدمين على الأدوار والفروع + الإشارات القابلة للتصرّف (فرع بلا طاقم). **قراءة فقط** — لا كتابة ولا كيان خاص به، يجمع من جداول `identity`. كان غائباً عن هذا الجدول رغم كونه مبنيّاً وموصولاً (أُضيف 2026-08-17) |

| `src/features/catalog/` | **الكتالوج المركزي (2026-09-22)**. مبنيّ: رفع الصور · الوحدات · مكتبة الخصائص · شجرة التصنيفات (٣ مستويات، وراثة السياسة/العملة/النوع، نقل بإعادة حساب المستويات، حذف/أرشفة) · الماركات — كلها مُدقَّقة عبر منفذ `core/audit/`، ومقارنة الأسماء بعد طيّ العربية. بيانات البداية بـ`core/db/seed-catalog.ts`. **و(1-ب)** المنتجات بمتغيّراتها ووحدات بيعها وباركوداتها (قبول الأكواد المشتركة وحلّ التباسها، EAN-13 داخلي ببادئة 20) والمجموعات. **و(2-أ) الطرح والتسعير**: سعر مركزي بعملته + سعر/استثناء فرع + سحب من فرع + سعر صرف مؤرَّخ + تقريب بالشرائح + جملة مشتقّة + تاريخ الأسعار + قائمة «بلا سعر» + تحديث جماعي بمعاينة — الحلّ بدالة صافية `services/price-resolution.ts`، والنطاق بـ`holdsPermissionAt` (core). **لم يُبنَ بعد**: مسودات الفروع (مع المرحلة 3). العقد: [docs/rest_api.md](docs/rest_api.md) §18–21. القرارات: [docs/reference/store_system.md](../docs/reference/store_system.md) §قرارات 2026-09-22 وبيانات البداية [catalog_seed.md](../docs/reference/catalog_seed.md) |

> **وموديولان يعيشان بـ`core/` عمداً لا بـ`features/`** لأنهما لا يملكان مجال عمل: `core/authz/` (كتالوج الصلاحيات + `requirePermission` + تجاوزات المستخدم) و`core/data-transfer/` (استيراد/تصدير عام — المورد يصير قابلاً للنقل بملف `*.transfer.ts` واحد بجانب الـfeature، بلا سطر واحد بالموديول).
>
> **وثالث: `core/media/`** (2026-09-22) — تخزين الملفات وجدول `media_assets`. بـ`core/` لأن الكتالوج والطباعة والتخصيص كلها تشير إليه، والـfeature لا يستورد feature. التفاصيل: [src/core/CLAUDE.md](src/core/CLAUDE.md) §Media.
>
> **ومنفذ رابع صغير: `core/audit/audit-recorder.ts`** (2026-09-22) — سجل التدقيق وكاتبه ملك `identity`، والـfeature لا يستورد feature. فالكتالوج (وكل وحدة قادمة) يكتب عبر `recordAudit()`، و`identity` يوفّر التنفيذ بسطر في `buildApp()`. **سجلّ واحد لا اثنان**: نفس الجدول ونفس `EntityHistorySection` بالفرونت.

> `orders/`, `inventory/`, `printing/`, `customization/` وبقية موديولات المشروع **لم تُبنَ بعد** — انسخ نمط `features/identity/` بنفس التشريح.

---

## 🔐 محرّك المصادقة `core/auth/` — قابل لإعادة الاستخدام (2026-08-11)

المصادقة **طبقتان**، والسبب هو قاعدة `features → features ❌` نفسها: لو كان `features/auth` مستقلاً لما استطاع `features/identity` استدعاءه عند التسجيل.

```
core/auth/          ← المحرّك: منافذ + خدمات + مخططات. صفر منطق عمل.
     ↑                 (identity يستورده بمشروعية — لا كسر للقاعدة)
features/auth/      ← الواجهة فقط: routes + controllers + dtos
features/identity/  ← أدوار/فروع/ملكية/موافقة — ويُنفِّذ منفذ AccountStore
```

**أربعة منافذ، وواحد فقط إلزامي**:

| المنفذ | من يُنفِّذه | لماذا يوجد |
|---|---|---|
| `AccountStore` (**إلزامي**) | `identity/repositories/account-store.impl.ts` | ٧ دوال. **هذا هو الوصل كله**: كل ما يخصّ Qirtas بالحسابات (جدول بعشرين عموداً، قواعد من يدخل، أن التحقق يُقدّم الحساب للطابور) مذكور هناك و`core/auth` يجهله. نقل المحرّك لتطبيق آخر = كتابة هذا الملف وحده |
| `EmailSender` | `core/auth/adapters/smtp-email-sender.ts` | التبديل من بريد الوزارة إلى Gmail = **تغيير `.env` فقط**. الذي يتغيّر بين النشرات هو الناقل لا الرسالة، فالناقل هو المُجرَّد |
| `SecurityEventSink` | `identity/repositories/security-event-sink.impl.ts` | يوصل أحداث المصادقة لسجل التدقيق القائم — لا جدول ثانٍ يعيش فيه الماضي |
| `AuthProvider` | `core/auth/providers/local-auth.provider.ts` | يجيب سؤالاً واحداً: «هل هذا الدليل صحيح؟». إضافة Google/Keycloak = ملف شقيق يرث الجلسات والإبطال والأحداث وقواعد الحالة بلا تعديل سطر فوقه |

الوصل كله بـ`configureAuth({...})` بأول `buildApp()` — ثلاثة أسطر، وهي **القائمة الكاملة** لما يجب أن يوفّره أي تطبيق.

**تُبدَّل بالتهيئة لا بالكود**: `EMAIL_VERIFICATION_MODE` (`off`/`optional`/`required`) · مُهَل ومحاولات الرموز · سياسة كلمة المرور · مُهَل الجلسة والتدوير · SMTP. المعاني المسمّاة بـ`core/auth/config/auth-config.ts`، والقيم بـ`.env` (والأسرار تبقى بـ`env` وحده فلا تتسرّب بسطر سجل يطبع «التهيئة»).

**دورة حياة الحساب صارت**: `pending_verification` → (رمز) → `pending_approval` → (قرار أدمن) → `active`/`rejected`. الترتيب هو الضمانة ضد إغراق طابور المراجعة.

**و`POST /users/register` يُرجع جلسة** (نفس جسم `POST /users/login` بالضبط — تغيّر بالعقد 2026-08-12، `data.user` بدل `data`): الخطوة التي يُسمّيها الرد نفسه (`POST /auth/verify-email`) محمية بـ`requireAuth`، فبلا توكن هنا يطلب الخادم من العميل شيئاً منعه من فعله. **ولا يمنح امتيازاً**: نفس الحساب يستدعي `/login` بعد ثانية فيأخذ التوكن ذاته — حساب بلا تعيين فعّال، `permission_keys` فارغة. وصادرة **عبر `login()` داخلياً** لا بإنشاء جلسة مباشرة، فرفضات `canSignIn` وحدث الأمن وحساب الصلاحيات تبقى بمكان واحد ولا ينحرف هذا المسار عن المسار الحقيقي.

## ✅ Auth حقيقي + RBAC فعلي + TTL مفعّلون (2026-07-23)

- `src/core/middleware/auth.ts` (حل محل `auth.stub.ts` القديم) يتحقق فعلياً من `Authorization: Bearer <token>` مقابل جدول `sessions.token` (opaque token عشوائي، 256-bit، يُولَّد ويُخزَّن عند `POST /login` — `core/security/token.ts`). `POST /logout` ينهي الجلسة الحالية فقط (بقية الجلسات المتزامنة لنفس اليوزر تبقى فعّالة).
- **TTL/خمول**: جلسة بدون طلب لمدة `SESSION_IDLE_TIMEOUT_MINUTES` (env، افتراضي 7 أيام — placeholder، `users_roles.md` لا يفرض رقماً) تُحذف تلقائياً عند أول طلب تالٍ بتوكنها وتُعامَل كتوكن غير موجود.
- **RBAC فعلي**: `src/core/http/require-permission.ts` (`requirePermission('<key>')`) يتحقق من اتحاد صلاحيات كل تعيينات اليوزر الفعّالة (`findAllEffectivePermissionKeys`، branch-agnostic لعمليات identity نفسها) — مطبَّق على كل route كتابة حساس بالموديول. `requireAuth` (`require-actor.ts`) للعمليات اللي تحتاج فقط "توكن صالح" بدون صلاحية محددة (معظم عمليات القراءة). صلاحيات identity الجديدة بالكتالوج: `users.manage`, `branches.manage`, `ownerships.manage`, `permissions.manage`, **`records.archive`** (+ `roles.view`/`roles.edit`/`audit_log.view` الموجودة أصلاً) — التفاصيل الكاملة والجدول الكامل لكل endpoint بـ[docs/rest_api.md](docs/rest_api.md) §7.2.
- **إزالة السجلات — مخرجان لا واحد** (2026-08-13، العقد كاملاً بـ[docs/rest_api.md](docs/rest_api.md) **§16**): ينطبق بالشكل نفسه على الفرع والدور والمستخدم. **حذف** (`DELETE /:id`) لما لم يشر إليه شيء **قط** — صلاحية الموديول وحدها، فلا شيء يُوزَن حين لا شيء يشير للصف. **أرشفة** (`POST /:id/archive`) لما له ماضٍ ولا يشير إليه شيء **الآن** — صلاحية الموديول **+ `records.archive`**، والعمود `archived_at` يُخفي الصفّ من كل قائمة ومنتقٍ بلا إتلاف شيء. القاعدة التي تمنع النموذج من الانهيار: **لا يُفتح تعيين جديد على دور أو فرع مؤرشف** (`assertTargetsAreInService` بـ`user-role-assignments.service.ts`)، وكل كتابة على سجل مؤرشف تُرفض `409 <entity>_archived`. والأرشفة تكتب حالةً متّسقة بنفس العبارة — الفرع `closed` والمستخدم `disabled` — فلا صفّ مخفيّ يدّعي أنه يعمل ولا حساب مخفيّ يفتح جلسة.
- **`GET /roles/self-registerable` — أول endpoint قراءة عام (2026-08-11)**: كل ما سبقه من مسارات بلا مصادقة كان **كتابةً** (دخول/تسجيل/استعادة كلمة مرور/bootstrap). هذا يقرأ كتالوج الأدوار المسموح طلبها عند التسجيل الذاتي — لأن `POST /users/register` يشترط `requested_role_id` ومن يملأ النموذج لا يملك جلسة يقرأ بها `GET /roles` (`roles.view`)، فكان منتقي الدور بالفرونت فارغاً دائماً. مسجَّل **قبل `/:id`** بالراوتر وإلا ابتلعه. **والقراءة العامة تُطابَق بحارس كتابة**: `assertSelfRegisterable` (`users.service.ts`) يفرض نفس الشرط على التسجيل وإعادة الإرسال بـ`422 role_not_self_registerable` — كتالوج لا يفرضه مسار الكتابة يوحي بحدٍّ غير موجود.
- **Rate limiting على `/login`**: `src/core/middleware/login-rate-limit.ts` — 5 محاولات فاشلة/15 دقيقة لكل إيميل **و**لكل IP معاً (كلاهما يجب أن يمر)، نجاح الدخول يصفّر العداد فوراً. تخزين in-memory (`core/security/rate-limiter.ts`) — كافٍ لعملية Node واحدة، **يُعاد ضبطه بالكامل عند إعادة تشغيل السيرفر أو عند تشغيل أكثر من instance بدون shared store** (Redis أو مشابه) — تفصيل يُحسم عند الحاجة الفعلية للـ scale الأفقي، ليس فجوة تصميم بالسياق الحالي (عملية واحدة).

## 🔑 حاجز الصلاحيات — `npm run check:permissions` (2026-08-13)

كان الكتالوج في مكانين لا يقارنهما شيء: قائمة `PERMISSIONS` بـ`core/db/seed-core.ts` (ما يستطيع المسؤول منحه)، ونداءات `requirePermission()` عبر عشرة routers (ما يرفضه الخادم فعلاً). الفحص الجديد يقارنهما في الاتجاهين، ويفرض أن **كل مسار يُصنِّف نفسه** (`requirePermission` / `requireAuth` / `publicRoute`).

**أول تشغيل**: ٧٠ مساراً — ١٠ منها كانت بلا تصنيف (كلها عامة بالتصميم، وُسمت `publicRoute`)، **و١٧ مفتاحاً مبذوراً لا يفرضه أي مسار** (`orders.*` · `printing.*` · `inventory.*` · `reports.*`). ولا بوابة مغلقة للأبد: كل مفتاح مفروض كان مبذوراً.

**والنتيجة على البذرة**: المفتاح صار يُبذَر **يوم يفرضه مسار، لا قبله**. الـ١٧ خرجت من القاعدة ومن شاشة الأدوار، وخطتها بقيت في `PERMISSIONS` و`ROLES` بـ`seed-core.ts` — فيوم تُكتب `requirePermission('orders.create')` على مسارها يُنشئ `npm run db:seed` المفتاح **ويمنحه لكل دور خطّط له** تلقائياً. سبعة أدوار عمل (مدير الفرع، أمين الصندوق، خدمة العملاء…) تنتظر وحداتها بهذه الطريقة بدل أن تحمل صلاحيات لا تحكم شيئاً.

**الاتجاه الخطر الذي يمنعه**: مفتاح يفرضه مسار ولم تبذره البذرة لا يستطيع أحدٌ حمله، فالـendpoint مغلق لكل مستخدم بمن فيهم السوبر أدمن — ولا شيء يبلّغ. بوابةٌ مغلقة دائماً تُقرأ بالكود تماماً كبوابة تعمل.

التفاصيل: [src/core/CLAUDE.md](src/core/CLAUDE.md) §HTTP. الآلية منقولة من `project-template/backend_template/src/core/authz/`، **وأُبقي نموذج قرطاس كما هو دون مساس** — تقييد الصلاحية بفرع (`branch_id`)، وتاريخ الإسناد (`valid_from`/`valid_to`)، ومستوى السلطة (`level`) — فهي أغنى مما يملكه القالب، والقالب هو من سيرث منها لا العكس.

### 🧨 العثرات التي كشفها التطبيق العملي

السبع كاملةً — كلٌّ بعطلها الحقيقي والقاعدة المستخلَصة منها — بـ[`project-template/app_template/readme/permissions.md`](../../project-template/app_template/readme/permissions.md) §عثرات وقعت فعلاً. وثلاثٌ منها تخصّ **هذا المستودع** مباشرةً:

1. **تقسيم مفتاح يترك مواضع تشير للماضي** — تقسيم `users.manage` إلى سبعة ترك ثمانية فحوص تسمّي القديم، أخطرها حارس «آخر مسؤول» الذي توقّف عن رؤية حاملي المفتاح المفصَّل. عند تقسيم أي `<module>.manage`، ابحث عن القديم في **الكود كله** لا بالمسارات وحدها: الفحوص خارج المسارات (لوحة التحكم، حرّاس المنطق) **لا يمسكها `npm run check:permissions`**.
2. **جدولٌ جديد على مسار الصلاحيات يجعل الهجرة شرطاً لعمل كل شيء** لا لميزته وحدها. ربطُ المُحلِّل بجدول التجاوزات أسقط `/users/me` كاملاً قبل تشغيل `db:migrate`.
3. **حراسة الشاشة لا تكفي — كل طلب تُصدره يحتاج مفتاحه.** ولهذا وُجد `GET /roles/assignable` (مسار متساهل يغذّي منتقي الأدوار بدل الكتالوج الكامل) و`GET /users/me/role-assignments` (يقرأ الهوية من **الجلسة لا من العميل**، فلا يُرفَض مستخدمٌ عن رؤية وظيفته هو).

> ⚠️ **أكبر فجوة متبقّية**: `check:permissions` يمسك المسار غير المصنَّف، ولا يمسك **شاشةً تطلب ما لا تملكه** — لا يُكتشف إلا بالتشغيل.

---

## ⚠️ ما لم يُبنَ بعد (بقصد)

- **كتالوج الصلاحيات الكامل (Permission Catalog)**: `src/core/db/seed-core.ts` يزرع أمثلة توضيحية لكل موديول فقط (بقصد — انظر users_roles.md "Status"). يكبر تدريجياً مع بناء كل موديول عمل (orders/inventory/...). كل صلاحية تحمل `display: { ar, en }` الخاص بها في نفس التعريف — لا ملف ترجمة موازٍ يُزامَن يدوياً. المدخل الموحّد لكل السيدات هو `src/core/db/seed.ts` (منسّق flags فقط) — راجع [docs/scripts.md](docs/scripts.md) §`db:seed`.
- **409 Conflict (Sync)**: شكل body (`server_version`/`client_version`/`conflict_fields`) موثّق ومحجوز بـ`ConflictError`، لكن لا يوجد أي endpoint يستخدمه بعد.
- **إرسال إشعارات فعلي**: تعديل صلاحيات دور أو قرار تسجيل يُنشئ نقطة استدعاء (hook) بالـservice، لكن آلية التسليم الفعلية (in-app/email/queue/retry) خارج نطاق هذا الموديول — انظر backlog.md بند 18 بالفرونت.

---

## lib/ Top-Level Structure

```
src/
├── index.ts       ← entrypoint: env → app → listen + graceful shutdown
├── app.ts         ← buildApp(): middleware, routers, error handler آخر شي
├── core/          ← بنية تحتية مشتركة (config/db/http/middleware/pagination/validation/logger)
└── features/      ← feature modules (routes/controllers/services/repositories/schemas/dtos)
```

## Dependency Rules

```
core     → nothing outside itself                     ✅
features → core                                        ✅
features → other features                              ❌ NEVER (مطابق لقاعدة الفرونت "Features → Features ❌")
```

---

## Mandatory Documentation Sync

**لا تُنهِ أي مهمة قبل تحديث الملف المرتبط.**

| التغيير                                          | يُحدَّث                                                                    |
| ------------------------------------------------ | -------------------------------------------------------------------------- |
| endpoint جديد أو تعديل envelope/error/pagination | `docs/rest_api.md`                                                         |
| Feature module جديد                              | جدول Modules أعلاه + `docs/architecture.md`                                |
| جدول DB جديد                                     | `src/core/db/schema.ts` (barrel) + migration جديدة (`npm run db:generate`) |
| Script جديد بـ`package.json`                     | `docs/scripts.md`                                                          |
| **أي تغيير على شكل رد يقرأه الفرونت** | `src/features/**/__tests__/wire-contract.test.ts` **و**`qirtas_app/test/wire_contract_test.dart` — **الاثنان معاً** |
| أي تغيير على `core/auth/ports/email-sender.ts` أو المحوّلَين أو مسار المستقبِل | `docs/mail.md` + `tests/email-recipient.test.ts`                          |
| **حذف منفذ/خدمة/محوِّل** | **ابحث عن اسمه بـ`docs/` قبل الحذف وبعده** — انظر القاعدة تحته |

### 🧟 قاعدة صارمة — لا يُبقى منفذٌ بلا مستدعٍ «للتوافق»

`core/notifications/password-reset-delivery.ts` بقي بعد أن استبدله `EmailSender`،
بحجّة مكتوبة داخله: «بلا مستدعين، ويُبقى فقط ليُصرَّف مشروعٌ بُني على نسخة أقدم من
القالب». والنتيجة أن **`docs/rest_api.md` ظلّ يصف مسار «نسيت كلمة المرور» بأنه
يمرّ به**، ويقول إن «المشروع بلا مرسل بريد — لا nodemailer ولا مزوّد»، بينما
`nodemailer` تبعية معلنة و`requestPasswordReset` يستدعي `emailSender()` منذ توحيد
المنافذ. فكان العقد — **المرجع الوحيد** — يوصي بعملٍ منتهٍ: «الإطلاق يتطلب محوّلاً
حقيقياً، ملف واحد وسطر تبديل».

**السبب**: منفذٌ ثانٍ مُصدَّر وموثَّق بجوار الأول يُقرأ كبديل حيّ، لا كأثر. و«توافق
مشروع أقدم» ليس مبرِّراً يعيش بهذا المستودع — لا يوجد مستهلك خارجي، والقالب يُنسخ
لا يُستورَد. حُذف الملف والمجلد 2026-08-17.

**القاعدة**: يُحذف ما لا مستدعي له بنفس التغيير الذي استبدله، ويُبحَث عن اسمه بـ
`docs/` و`src/` معاً — الوثيقة تعيش أطول من الكود لأن **لا شيء يُفشلها**:
`npm run typecheck` و`check:permissions` و`check:messages` كلها تمرّ على وثيقة تكذب.

---

## ⛓️ عقد الـwire — قاعدة صارمة

**مفاتيح JSON عقدٌ مع `qirtas_app`، ولا شيء يفرضه تلقائياً.** خطؤها لا يراه `tsc`
(الخادم لا يعلم أن عميلاً موجوداً)، ولا `dart analyze` (المفتاح الغائب `null`،
و`null` قيمة `dynamic` سليمة)، ويبتلعه `HandleBodyResponse` فيصل المستخدمَ «حدث
خطأ» بينما السيرفر يسجّل `200 OK`.

**هذا وقع فعلاً بالقالب الذي اشتُقّ منه هذا المشروع** — العميل يقرأ `data.user`
والخادم يرسل `data.account`، فلم يعمل مسار الدخول ولا مرّة، وخطّا CI أخضران.

الحارس: `src/features/**/__tests__/wire-contract.test.ts` هنا،
و`qirtas_app/test/wire_contract_test.dart` هناك — **مكتوبان على الأشكال نفسها**.
أي تغيير بشكل رد يُحدَّث بالملفين معاً بنفس التغيير.

> **وفخّ ثانٍ أهدأ**: schema الـDTO تُغذّي `/openapi.json` **ولا شيء يقارنها بما
> تُرجعه الخدمة فعلاً**. `loginResponseSchema` أغفلت `is_super_admin` بينما
> الخدمة ترسله والعميل يقرأه — فالعقد المنشور ينكر وجود العَلَم الذي يقرّر ظهور
> كل أداة إدارة. صُحِّح 2026-08-17 ويحرسه `wire-contract.test.ts` الآن.

---

## قواعد التعديل

- تغيير minimal ومعزول — لا refactors واسعة بدون موافقة صريحة.
- **`npm test` قبل إغلاق أي مهمة** (vitest، بلا قاعدة بيانات ولا خادم).
- بعد أي تعديل schema: `npm run db:generate` ثم `npm run db:migrate`.
- تحقق دائماً قبل الإغلاق: `npm run typecheck && npm run lint`.
