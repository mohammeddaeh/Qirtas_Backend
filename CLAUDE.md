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

> `orders/`, `inventory/`, `printing/`, `customization/` وبقية موديولات المشروع **لم تُبنَ بعد** — انسخ نمط `features/identity/` بنفس التشريح.

---

## ⚠️ ما لم يُبنَ بعد (بقصد)

- **Auth حقيقي**: `src/core/middleware/auth.stub.ts` يقرأ الـBearer token لكن **لا يتحقق منه إطلاقاً** — `req.user` دائماً `null`. كل endpoint تتطلب actor (`requireActorId` بـ`src/core/http/require-actor.ts`) ترمي حالياً `401` لأي طلب. لما يُبنى Auth حقيقي: استبدل منطق `auth.stub.ts` الداخلي فقط (يحل `req.user` لهوية حقيقية بعد التحقق من الجلسة/التوكن) — الشكل الخارجي وكل الـfeature layer يبقيان كما هما بدون أي تعديل.
- **كتالوج الصلاحيات الكامل (Permission Catalog)**: `src/core/db/seed.ts` يزرع أمثلة توضيحية لكل موديول فقط (بقصد — انظر users_roles.md "Status"). يكبر تدريجياً مع بناء كل موديول عمل (orders/inventory/...).
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
