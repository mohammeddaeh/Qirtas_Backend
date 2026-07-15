# Scripts

## تشغيل/تطوير

| Script              | ماذا يسوي                                                          |
| ------------------- | ------------------------------------------------------------------ |
| `npm run dev`       | يشغّل السيرفر بـ`tsx watch` (إعادة تشغيل تلقائية عند تعديل أي ملف) |
| `npm run build`     | يحوّل TypeScript إلى `dist/` (`tsc`)                               |
| `npm run start`     | يشغّل `dist/index.js` (بعد `build`) — للإنتاج                      |
| `npm run typecheck` | فحص أنواع بدون إخراج ملفات                                         |
| `npm run lint`      | ESLint على كل `.ts`                                                |
| `npm run format`    | Prettier — يكتب التنسيق مباشرة                                     |

## قاعدة البيانات (Drizzle + PostgreSQL)

| Script                | ماذا يسوي                                                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run db:generate` | يقارن `src/core/db/schema.ts` بآخر migration، يولّد SQL جديد بـ`drizzle/`                                                                                                                  |
| `npm run db:migrate`  | يطبّق كل الـmigrations غير المطبَّقة على `DATABASE_URL`                                                                                                                                    |
| `npm run db:push`     | مزامنة سريعة مباشرة (تطوير محلي فقط — لا تستخدمه كمصدر حقيقة)                                                                                                                              |
| `npm run db:studio`   | يفتح Drizzle Studio (واجهة تصفح البيانات)                                                                                                                                                  |
| `npm run db:seed`     | يشغّل `src/core/db/seed.ts` — يزرع الأدوار الابتدائية (Super Admin, Branch Manager, ...) وأمثلة كتالوج الصلاحيات. آمن لإعادة التشغيل (upsert بالمفتاح الطبيعي: اسم الدور / مفتاح الصلاحية) |

⚠️ **كل أوامر `db:*` تُشغَّل عبر `tsx node_modules/drizzle-kit/bin.cjs ...`** (مو `drizzle-kit` مباشرة) — راجع [../src/core/CLAUDE.md](../src/core/CLAUDE.md) §DB للسبب التقني (تعارض حل الامتدادات `.js` بين drizzle-kit وNode ESM).

## قاعدة البيانات عبر Docker (الطريقة الموصى بها محلياً)

`docker-compose.yml` بالجذر يشغّل PostgreSQL 16 بنفس بيانات `DATABASE_URL` الافتراضية بـ`.env.example` (`postgres`/`postgres`/`qirtas_dev` على `5432`) — بدون أي تعديل إضافي.

| Script/Command           | ماذا يسوي                                                        |
| ------------------------ | ---------------------------------------------------------------- |
| `docker compose up -d`   | يشغّل حاوية PostgreSQL بالخلفية (أول مرة يسحب الـimage تلقائياً) |
| `docker compose ps`      | حالة الحاوية (`healthy` يعني جاهزة لقبول اتصالات)                |
| `docker compose down`    | يوقف الحاوية (البيانات تبقى بـvolume `postgres_data`)            |
| `docker compose down -v` | يوقف الحاوية **ويحذف** البيانات نهائياً (تصفير كامل)             |
| `docker compose logs -f` | متابعة لوج القاعدة مباشرة                                        |

## إعداد أول مرة (Setup) — ✅ مُختبر فعلياً ضد قاعدة حقيقية (2026-07-09)

1. `npm install`
2. `.env` جاهز افتراضياً بنفس قيم `docker-compose.yml` — لا حاجة لتعديل لو مستخدم Docker محلياً.
3. `docker compose up -d` — شغّل القاعدة (تحقق بـ`docker compose ps` أن الحالة `healthy`).
4. `npm run db:migrate` — ينشئ كل جداول الـidentity module (users, roles, permissions, role_permissions, user_role_assignments, branches, ownerships, audit_log_entries, sessions).
5. `npm run db:seed` — يزرع الأدوار الابتدائية العشرة + أمثلة كتالوج الصلاحيات (مطلوب قبل أول استخدام: `bootstrap-super-admin` يعتمد على وجود دور "Super Admin" مزروع مسبقاً).
6. `npm run dev` — يشغّل السيرفر على `http://localhost:3000` (أو `PORT` بالـ`.env`).
7. تحقق: `curl http://localhost:3000/health` يرجع `{"status":true,...}`.
8. أول استخدام فعلي: `POST /api/v1/users/bootstrap-super-admin` (ينجح فقط لو عدد اليوزرز = صفر) لإنشاء أول حساب Super Admin.

> ✅ **تم التحقق الكامل فعلياً (2026-07-09)**: `db:migrate` → `db:seed` (idempotent، جُرِّب مرتين بدون تكرار) → `bootstrap-super-admin` → `login` (نجاح + رفض كلمة مرور خاطئة 401) → `register` (تسجيل ذاتي، `pending_approval`) → محاولة دخول معلّق (403 برسالة واضحة) → `GET /roles`/`/branches`/`/permissions` — كل السيناريوهات اشتغلت كما هو مخطط ضد PostgreSQL حقيقي داخل Docker.
