# دليل التشغيل المحلي — مرجع سريع

> دليل عملي للتشغيل اليومي. للتفاصيل المعمارية الكاملة راجع [CLAUDE.md](CLAUDE.md) و[docs/scripts.md](docs/scripts.md).

---

## الترتيب الكامل من الصفر (أول مرة)

```powershell
cd "d:\awqaf_app\Qirtas\qirtas_backend"

docker compose up -d       # شغّل قاعدة البيانات
docker compose ps          # تأكد إن الحالة "healthy"

npm run db:setup           # الجداول + الأدوار والصلاحيات + حساب Super Admin + بيانات تجريبية

npm run dev                # شغّل السيرفر — سيبها شغّالة في هذي الطرفية
```

`db:setup` أمر واحد بيعمل كل حاجة: `db:migrate` ثم `db:seed -- --admin --demo --reset`. مش محتاج تشغّل السيرفر في النص ولا تنادي `curl` عشان تعمل أول حساب.

**بيانات الدخول الافتراضية** بعد `db:setup`:

| الحقل | القيمة |
| ----- | ------ |
| البريد | `super_admin@admin.com` |
| كلمة المرور | `P@ssw0rd@123` |


> **وضع التطوير المبسّط:** بـ`PASSWORD_POLICY=relaxed` بملف `.env` بيقبل السيرفر **أي كلمة مرور غير فارغة** (مثل `12345678`) بلا شرط حرف/رقم/طول. السيرفر بيرفض الإقلاع بهالقيمة لو `NODE_ENV=production`. والقيم بـ`.env` المحلي: `SEED_ADMIN_PASSWORD=12345678` وكلمة مرور الحسابات التجريبية `12345678`.
> غيّرها بمتغيّرات البيئة `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` (وكمان `SEED_ADMIN_FIRST_NAME` / `SEED_ADMIN_LAST_NAME` / `SEED_ADMIN_PHONE`) قبل تشغيل الأمر لو حبيت. القيم الافتراضية للتطوير المحلي فقط.

بعد كده افتح **طرفية جديدة** لأي أمر تجربة (curl، psql...) — طرفية `npm run dev` لازم تفضل شغّالة لوحدها.

---

## أمر السيد الواحد (`db:seed`)

كل الزرع بيمر من مدخل واحد: `npm run db:seed`. الجزء **الأساسي** (الصلاحيات + الأدوار + أسماء الصلاحيات المعروضة بالعربي/الإنجليزي) بيشتغل دايماً وآمن التكرار، والباقي flags اختيارية:

| الأمر | يعمل إيه |
| ----- | -------- |
| `npm run db:seed` | الأساسي فقط — صلاحيات + أدوار + أسماء الصلاحيات (ar/en) |
| `npm run db:seed -- --admin` | + إنشاء أول Super Admin (بيتخطّى لو في مستخدمين أصلاً) |
| `npm run db:seed -- --demo --reset` | + بيانات عربية تجريبية (15 فرع، 67 مستخدم) بعد مسح التجريبي القديم |
| `npm run db:seed -- --fr` | + اللغة الفرنسية الديناميكية |
| `npm run db:seed -- --ui-overrides-demo` | + demo تغيير نص UI من الخادم (**بيغيّر نص ظاهر عمداً**) |
| `npm run db:seed -- --all` | = `--admin --demo --fr` (بدون `--ui-overrides-demo` وبدون `--reset`) |
| `npm run db:seed -- --help` | يعرض القائمة دي كاملة |

⚠️ `--reset` بيعمل **حذف فعلي** لكل مستخدم بريده منتهي بـ`@qirtas.test` وكل الفروع التجريبية بالاسم — محصور ببيانات السكربت نفسه، مابيلمس بيانات حقيقية. مابيشتغل إلا مع `--demo`.

---

## التشغيل اليومي (بعد أول مرة)

لو القاعدة والجداول جاهزين من قبل، كل اللي محتاجه:

```powershell
docker compose up -d       # لو القاعدة واقفة
npm run dev                # شغّل السيرفر
```

`db:setup` مش لازم يتكرر إلا لو:

- عدّلت شكل جدول (schema) → `npm run db:migrate`
- عايز تتأكد إن الأدوار الأساسية موجودة → `npm run db:seed` (آمن، مش هيكرر البيانات)
- عايز ترجع لبيانات تجربة نظيفة → `npm run db:seed -- --demo --reset`

---

## إيقاف كل حاجة

```powershell
# في طرفية npm run dev: اضغط Ctrl+C

docker compose down        # يوقف القاعدة، البيانات تفضل محفوظة
docker compose down -v     # يوقف القاعدة ويمسح كل البيانات نهائياً (تصفير كامل)
```

---

## توثيق تفاعلي لكل الـ API (Swagger UI)

بدل ما تحفظ الأوامر يدوياً أو تستورد Postman collection، افتح المتصفح على:

```
http://localhost:3000/docs
```

هتلاقي **كل الـ 27 endpoint** مرتبة حسب الموديول (Users, Roles, Permissions, Branches...)، ولكل واحد:

- الـ `request body`/`params`/`query` المطلوبة بالضبط (نوع كل حقل، إجباري ولا لأ)
- شكل الـ `response` المتوقع لكل حالة (200/201/401/404/409/422...)
- زرار **"Try it out"** يخليك تجرّب الرابط مباشرة من المتصفح بدون curl أو Postman

⚠️ **مولّد تلقائياً من نفس أكواد التحقق (zod schemas) المستخدمة فعلياً وقت التشغيل** — مش ملف منفصل بيحتاج تحديث يدوي. أي تعديل على شكل أي endpoint بينعكس تلقائياً هنا بمجرد إعادة تشغيل السيرفر.

الملف الخام (JSON) لو احتجته لأداة تانية (استيراد بـ Postman/Insomnia مثلاً):

```
http://localhost:3000/openapi.json
```

---

## أوامر تجربة الـ API (curl)

⚠️ استخدم `curl.exe` دايماً في PowerShell (مش `curl` العادي) — عشان تتجنب تحذير `Invoke-WebRequest`.

```powershell
# فحص إن السيرفر شغّال
curl.exe http://localhost:3000/health

# إنشاء أول حساب Super Admin عبر HTTP — البديل اليدوي لـ`db:seed -- --admin`
# (مرة واحدة بس، أول ما القاعدة تكون فاضية من اليوزرات — نفس الـ service بالضبط)
curl.exe -X POST http://localhost:3000/api/v1/users/bootstrap-super-admin -H "Content-Type: application/json" -d '{\"first_name\":\"Admin\",\"last_name\":\"Qirtas\",\"email\":\"super_admin@admin.com\",\"phone\":\"0900000000\",\"password\":\"P@ssw0rd@123\"}'

# تسجيل دخول (بيانات db:setup الافتراضية)
curl.exe -X POST http://localhost:3000/api/v1/users/login -H "Content-Type: application/json" -d '{\"email\":\"super_admin@admin.com\",\"password\":\"P@ssw0rd@123\"}'

# تسجيل موظف جديد (تسجيل ذاتي — بيحتاج موافقة أدمن، الحالة تطلع pending_approval)
curl.exe -X POST http://localhost:3000/api/v1/users/register -H "Content-Type: application/json" -d '{\"first_name\":\"Sara\",\"last_name\":\"Emp\",\"email\":\"sara@test.com\",\"phone\":\"0900000002\",\"password\":\"P@ssw0rd@123\",\"requested_role_id\":5}'

# عرض كل اليوزرات
curl.exe http://localhost:3000/api/v1/users

# عرض كل الأدوار
curl.exe http://localhost:3000/api/v1/roles

# عرض كل الفروع
curl.exe http://localhost:3000/api/v1/branches

# عرض كتالوج الصلاحيات
curl.exe http://localhost:3000/api/v1/permissions
```

---

## معاينة قاعدة البيانات (بدون واجهة رسومية — عبر psql)

```powershell
# ادخل لأداة psql جوه حاوية Docker
docker exec -it qirtas_backend-postgres-1 psql -U postgres -d qirtas_dev
```

بعد الدخول (السطر بيبدأ بـ `qirtas_dev=#`):

```sql
\dt                                          -- عرض كل الجداول
SELECT * FROM users;                         -- كل اليوزرات
SELECT id, name, category, level FROM roles; -- كل الأدوار
SELECT * FROM permissions LIMIT 5;           -- أول 5 صلاحيات
\q                                            -- خروج
```

أو استعلام سريع بدون دخول تفاعلي:

```powershell
docker exec qirtas_backend-postgres-1 psql -U postgres -d qirtas_dev -c "SELECT id, email, status FROM users;"
```

---

## معاينة قاعدة البيانات (واجهة رسومية)

### الخيار 1 — Drizzle Studio (الأسهل، بدون تثبيت أي برنامج)

```powershell
npm run db:studio
```

هيفتح رابط (عادة `https://local.drizzle.studio`) في المتصفح — واجهة ويب بتوريك كل الجداول والبيانات، تقدر تتصفح/تعدّل/تفلتر منها مباشرة. مربوطة تلقائياً بنفس `DATABASE_URL` في `.env`.

### الخيار 2 — برنامج مستقل (لو عايز أداة دايمة على جهازك)

نزّل واحد من دول (مجانيين):

- **[TablePlus](https://tableplus.com/)** — خفيف وواجهته بسيطة، الأشهر للمبتدئين.
- **[DBeaver](https://dbeaver.io/)** — مجاني بالكامل، أقوى وأشمل لكن واجهته أعقد شوية.
- **pgAdmin** — الأداة الرسمية لـ PostgreSQL نفسها.

بيانات الاتصال (من `.env`):

| الحقل    | القيمة      |
| -------- | ----------- |
| Host     | `localhost` |
| Port     | `5432`      |
| Database | `qirtas_dev` |
| User     | `postgres`  |
| Password | `postgres`  |

---

## مصطلحات سريعة

| المصطلح       | يعني إيه                                                              |
| ------------- | --------------------------------------------------------------------- |
| **Migration** | أمر بينشئ/يعدّل الجداول جوه القاعدة حسب تعريف الكود                   |
| **Seed**      | أمر بيحط بيانات أساسية جاهزة (الأدوار، الصلاحيات)                     |
| **Endpoint**  | عنوان معيّن على السيرفر بيستقبل طلب معيّن (مثل `/api/v1/users/login`) |
| **psql**      | أداة سطر أوامر رسمية لـ PostgreSQL                                    |
