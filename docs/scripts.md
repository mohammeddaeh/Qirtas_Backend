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
| `npm run db:seed`     | المدخل الوحيد لكل الزرع — `src/core/db/seed.ts`. بدون flags يزرع الجزء الأساسي فقط. الباقي flags اختيارية (جدول تحت) |
| `npm run db:setup`    | إعداد أول مرة بأمر واحد: `db:migrate` ثم `db:seed -- --admin --demo --reset`. لا يحتاج تشغيل السيرفر ولا `curl` |

⚠️ **كل أوامر `db:*` تُشغَّل عبر `tsx node_modules/drizzle-kit/bin.cjs ...`** (مو `drizzle-kit` مباشرة) — راجع [../src/core/CLAUDE.md](../src/core/CLAUDE.md) §DB للسبب التقني (تعارض حل الامتدادات `.js` بين drizzle-kit وNode ESM).

### `db:seed` — المدخل الموحّد وخطواته

`seed.ts` **منسّق (orchestrator) فقط**: يقرأ الـflags، يرتّب الخطوات، ويملك وحده فتح/إغلاق الـpool. كل خطوة موديول مستقل يصدّر دالة async عادية ولا يلمس الاتصال.

| Flag | الخطوة | الملف | ملاحظات |
| ---- | ------ | ----- | ------- |
| _(دائماً)_ | كتالوج الصلاحيات + كتالوج الأدوار + أسماء الصلاحيات المعروضة (ar/en) | `seed-core.ts` | آمن لإعادة التشغيل (upsert بالمفتاح الطبيعي: مفتاح الصلاحية / اسم الدور / `(language_code, key)`) |
| `--admin` | إنشاء أول حساب Super Admin | `bootstrap-super-admin.ts` | نفس الـservice ونفس الـzod schema المستخدمَين في `POST /users/bootstrap-super-admin`. يتخطّى بصمت لو جدول `users` غير فارغ. البيانات من `SEED_ADMIN_*` (افتراضي: `super_admin@admin.com` / `P@ssw0rd@123`) |
| `--demo` | بيانات عربية تجريبية (15 فرع، 67 مستخدم على كل الأدوار وكل الحالات) عبر service layer الحقيقي | `seed-demo-arabic-data.ts` | **نقطة البداية الدائمة لأي جولة تجربة/تطوير**. يتطلّب Super Admin موجوداً (استخدم `--admin` معه أو قبله) |
| `--reset` | حذف فعلي لكل صفوف الديمو قبل إعادة الزرع | ↑ نفسه | لا يعمل إلا مع `--demo` (خطأ صريح لو انفرد). hard delete — استثناء موثّق داخل الملف من قاعدة "لا Hard Delete"، محصور بـ`@qirtas.test` والفروع التجريبية بالاسم |
| `--fr` | اللغة الفرنسية الديناميكية | `seed-french-ui-translations.ts` | ملف "عدّل ثم أعد التشغيل" — تُحرَّر النصوص فيه يدوياً |
| `--ui-overrides-demo` | demo آلية override لنص UI من الخادم | `seed-ui-text-overrides-demo.ts` | **يغيّر نصاً ظاهراً عمداً** (`welcomeBack`) — مستثنى من `--all` بقصد |
| `--all` | = `--admin --demo --fr` | — | بدون `--ui-overrides-demo` وبدون `--reset` |
| `--help` | يطبع الاستخدام كاملاً ويخرج | — | أي flag غير معروف → خطأ صريح، لا تجاهل صامت |

> **أسماء الصلاحيات المعروضة داخل `seed-core.ts` لا في ملف منفصل**: كل عنصر في `PERMISSIONS` يحمل `display: { ar, en }` الخاص به. كان لها سابقاً سكربت مستقل (`seed-permission-translations.ts`) بقائمة مفاتيح موازية تُزامَن يدوياً — أُلغي، ومعه خطر إضافة صلاحية بلا ترجمة. راجع [../../docs/reference/dynamic_localization.md](../../docs/reference/dynamic_localization.md) §13.

## قاعدة البيانات عبر Docker (الطريقة الموصى بها محلياً)

`docker-compose.yml` بالجذر يشغّل PostgreSQL 16 بنفس بيانات `DATABASE_URL` الافتراضية بـ`.env.example` (`postgres`/`postgres`/`qirtas_dev` على `5432`) — بدون أي تعديل إضافي.

| Script/Command           | ماذا يسوي                                                        |
| ------------------------ | ---------------------------------------------------------------- |
| `docker compose up -d`   | يشغّل حاوية PostgreSQL بالخلفية (أول مرة يسحب الـimage تلقائياً) |
| `docker compose ps`      | حالة الحاوية (`healthy` يعني جاهزة لقبول اتصالات)                |
| `docker compose down`    | يوقف الحاوية (البيانات تبقى بـvolume `postgres_data`)            |
| `docker compose down -v` | يوقف الحاوية **ويحذف** البيانات نهائياً (تصفير كامل)             |
| `docker compose logs -f` | متابعة لوج القاعدة مباشرة                                        |

## إعداد أول مرة (Setup) — ✅ مُختبر فعلياً ضد قاعدة حقيقية (2026-08-02)

1. `npm install`
2. `.env` جاهز افتراضياً بنفس قيم `docker-compose.yml` — لا حاجة لتعديل لو مستخدم Docker محلياً.
3. `docker compose up -d` — شغّل القاعدة (تحقق بـ`docker compose ps` أن الحالة `healthy`).
4. `npm run db:setup` — أمر واحد: ينشئ كل جداول الـidentity module، يزرع الأدوار والصلاحيات وأسماء الصلاحيات، ينشئ أول Super Admin، ويزرع البيانات التجريبية.
5. `npm run dev` — يشغّل السيرفر على `http://localhost:3000` (أو `PORT` بالـ`.env`).
6. تحقق: `curl http://localhost:3000/health` يرجع `{"status":true,...}`.
7. سجّل دخول بـ`super_admin@admin.com` / `P@ssw0rd@123` (أو قيم `SEED_ADMIN_*` اللي ضبطتها قبل الخطوة 4).

> إنشاء الـSuper Admin عبر HTTP (`POST /api/v1/users/bootstrap-super-admin`) ما زال يعمل كبديل يدوي — نفس الـservice ونفس الـschema بالضبط، وينجح فقط لو عدد اليوزرز = صفر.

> ✅ **تم التحقق الكامل فعلياً (2026-08-02، بعد توحيد السيدات)**: `db:setup` من قاعدة فارغة (migrate → 26 صلاحية + 10 أدوار + 52 صف `permission.*` → Super Admin id 1 → 15 فرع + 67 مستخدم) → `db:seed -- --fr` (55 مفتاح) → إعادة تشغيل `db:seed -- --admin --demo` بدون `--reset` (تخطّى الـadmin وكل الـ67 مستخدم — idempotent) → `--reset` منفرداً و flag غير معروف كلاهما يفشل برسالة استخدام واضحة. كله ضد PostgreSQL حقيقي داخل Docker.
>
> التحقق السابق (2026-07-09، قبل التوحيد): `db:migrate` → `db:seed` → `bootstrap-super-admin` → `login` (نجاح + رفض كلمة مرور خاطئة 401) → `register` (تسجيل ذاتي، `pending_approval`) → محاولة دخول معلّق (403 برسالة واضحة) → `GET /roles`/`/branches`/`/permissions`.
