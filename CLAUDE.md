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

---

## Modules موجودة

| المسار                   | ما تفعله                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/features/identity/` | **Users, Roles & Permissions (RBAC) — الموديول التأسيسي الكامل**: users (تسجيل ذاتي + موافقة أدمن + auth)، roles، permissions، user_role_assignments، branches، ownerships، audit_log_entries، sessions. مصدر قواعد العمل الكامل: [docs/reference/users_roles.md](../docs/reference/users_roles.md) و[users_complete_reference.md](../docs/reference/users_complete_reference.md) — **المثال الحي المرجعي** لأي feature جديدة (6 مجلدات فرعية × 9 كيانات) |
| `src/features/localization/` | **Dynamic (Remote) Localization** — `languages` + `translation_entries`: يخدم أي لغة إضافية بعد ar/en بالكامل (لا قيمة أساسية محلية لها)، **و** يخدم أيضاً طبقة "Override" اختيارية فوق ar/en نفسيهما (اللتان تبقيان compile-time بالفرونت كقيمة أساسية مضمونة أوفلاين دائماً — الـoverride طبقة إضافية غير مُلزِمة فوقها، لا بديل عنها) — انظر §13 (أسماء الصلاحيات) و§15 (أي نص واجهة عادي) بالمرجع أدناه. `GET /languages` (غير مُصفّحة، فعّالة فقط) هو استطلاع الإصدار الذي يتحقق منه التطبيق عند الإقلاع؛ `GET /:code/translations` يرجّع خريطة الترجمة الكاملة (whole-file، لا `since`)؛ `PUT /:code/translations` يرفع `version` تلقائياً كإشارة إبطال كاش. صلاحية `localization.manage` للكتابة. مصدر القرار المعماري الكامل: [docs/reference/dynamic_localization.md](../docs/reference/dynamic_localization.md) (Model 2 — نظامان متوازيان لأي لغة إضافية؛ Local-First with Remote Override لكل اللغات بما فيها ar/en) |

> `orders/`, `inventory/`, `printing/`, `customization/` وبقية موديولات المشروع **لم تُبنَ بعد** — انسخ نمط `features/identity/` بنفس التشريح.

---

## ✅ Auth حقيقي + RBAC فعلي + TTL مفعّلون (2026-07-23)

- `src/core/middleware/auth.ts` (حل محل `auth.stub.ts` القديم) يتحقق فعلياً من `Authorization: Bearer <token>` مقابل جدول `sessions.token` (opaque token عشوائي، 256-bit، يُولَّد ويُخزَّن عند `POST /login` — `core/security/token.ts`). `POST /logout` ينهي الجلسة الحالية فقط (بقية الجلسات المتزامنة لنفس اليوزر تبقى فعّالة).
- **TTL/خمول**: جلسة بدون طلب لمدة `SESSION_IDLE_TIMEOUT_MINUTES` (env، افتراضي 7 أيام — placeholder، `users_roles.md` لا يفرض رقماً) تُحذف تلقائياً عند أول طلب تالٍ بتوكنها وتُعامَل كتوكن غير موجود.
- **RBAC فعلي**: `src/core/http/require-permission.ts` (`requirePermission('<key>')`) يتحقق من اتحاد صلاحيات كل تعيينات اليوزر الفعّالة (`findAllEffectivePermissionKeys`، branch-agnostic لعمليات identity نفسها) — مطبَّق على كل route كتابة حساس بالموديول. `requireAuth` (`require-actor.ts`) للعمليات اللي تحتاج فقط "توكن صالح" بدون صلاحية محددة (معظم عمليات القراءة). صلاحيات identity الجديدة بالكتالوج: `users.manage`, `branches.manage`, `ownerships.manage`, `permissions.manage` (+ `roles.view`/`roles.edit`/`audit_log.view` الموجودة أصلاً) — التفاصيل الكاملة والجدول الكامل لكل endpoint بـ[docs/rest_api.md](docs/rest_api.md) §7.2.
- **Rate limiting على `/login`**: `src/core/middleware/login-rate-limit.ts` — 5 محاولات فاشلة/15 دقيقة لكل إيميل **و**لكل IP معاً (كلاهما يجب أن يمر)، نجاح الدخول يصفّر العداد فوراً. تخزين in-memory (`core/security/rate-limiter.ts`) — كافٍ لعملية Node واحدة، **يُعاد ضبطه بالكامل عند إعادة تشغيل السيرفر أو عند تشغيل أكثر من instance بدون shared store** (Redis أو مشابه) — تفصيل يُحسم عند الحاجة الفعلية للـ scale الأفقي، ليس فجوة تصميم بالسياق الحالي (عملية واحدة).

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

---

## قواعد التعديل

- تغيير minimal ومعزول — لا refactors واسعة بدون موافقة صريحة.
- بعد أي تعديل schema: `npm run db:generate` ثم `npm run db:migrate`.
- تحقق دائماً قبل الإغلاق: `npm run typecheck && npm run lint`.
