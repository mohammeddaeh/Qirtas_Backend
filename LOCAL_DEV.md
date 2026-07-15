# دليل التشغيل المحلي — مرجع سريع

> دليل عملي للتشغيل اليومي. للتفاصيل المعمارية الكاملة راجع [CLAUDE.md](CLAUDE.md) و[docs/scripts.md](docs/scripts.md).

---

## الترتيب الكامل من الصفر (أول مرة)

```powershell
cd "d:\awqaf_app\test full project with temp and back\qirtas_backend"

docker compose up -d       # شغّل قاعدة البيانات
docker compose ps          # تأكد إن الحالة "healthy"

npm run db:migrate         # أنشئ الجداول (مرة واحدة، أو بعد أي تعديل بالـ schema)
npm run db:seed            # ازرع الأدوار والصلاحيات الأساسية (آمن التكرار)

npm run dev                # شغّل السيرفر — سيبها شغّالة في هذي الطرفية
```

بعد كده افتح **طرفية جديدة** لأي أمر تجربة (curl، psql...) — طرفية `npm run dev` لازم تفضل شغّالة لوحدها.

---

## التشغيل اليومي (بعد أول مرة)

لو القاعدة والجداول جاهزين من قبل، كل اللي محتاجه:

```powershell
docker compose up -d       # لو القاعدة واقفة
npm run dev                # شغّل السيرفر
```

`db:migrate` و`db:seed` مش لازم تتكرر إلا لو:

- عدّلت شكل جدول (schema) → `db:migrate` تاني
- عايز تتأكد إن الأدوار الأساسية موجودة → `db:seed` (آمن، مش هيكرر البيانات)

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

# إنشاء أول حساب Super Admin (مرة واحدة بس، أول ما القاعدة تكون فاضية من اليوزرات)
curl.exe -X POST http://localhost:3000/api/v1/users/bootstrap-super-admin -H "Content-Type: application/json" -d '{\"first_name\":\"Admin\",\"last_name\":\"Test\",\"email\":\"admin@awqaf.test\",\"phone\":\"0500000000\",\"password\":\"testpass123\"}'

# تسجيل دخول
curl.exe -X POST http://localhost:3000/api/v1/users/login -H "Content-Type: application/json" -d '{\"email\":\"admin@awqaf.test\",\"password\":\"testpass123\"}'

# تسجيل موظف جديد (تسجيل ذاتي — بيحتاج موافقة أدمن، الحالة تطلع pending_approval)
curl.exe -X POST http://localhost:3000/api/v1/users/register -H "Content-Type: application/json" -d '{\"first_name\":\"Sara\",\"last_name\":\"Emp\",\"email\":\"sara@awqaf.test\",\"phone\":\"0500000002\",\"password\":\"testpass123\",\"requested_role_id\":5}'

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
