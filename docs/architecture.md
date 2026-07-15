# Architecture

> شجرة المجلدات وتسلسل الطلب. راجع [../CLAUDE.md](../CLAUDE.md) للفهرس العام، و[../src/core/CLAUDE.md](../src/core/CLAUDE.md)/[../src/features/CLAUDE.md](../src/features/CLAUDE.md) للقواعد التفصيلية.

## شجرة المجلدات

```
qirtas_backend/
├── CLAUDE.md              ← جذري، جدول قرار
├── docs/                  ← هذا المجلد
│   ├── architecture.md
│   ├── rest_api.md        ← العقد المرجعي (الأهم)
│   └── scripts.md
├── drizzle/                ← SQL migrations مولّدة (Git-tracked)
├── drizzle.config.ts
├── package.json / tsconfig.json / .eslintrc.cjs / .prettierrc
├── .env.example / .env (gitignored)
└── src/
    ├── index.ts             ← entrypoint
    ├── app.ts                ← buildApp()
    ├── core/                 ← بنية تحتية مشتركة (لا تعتمد على أي feature)
    │   ├── config/env.ts
    │   ├── db/{client,schema,seed}.ts
    │   ├── http/{response,api-error,async-handler,require-actor}.ts
    │   ├── middleware/{error-handler,not-found,request-context,auth.stub}.ts
    │   ├── pagination/pagination.ts
    │   ├── security/password.ts   ← scrypt hashing (بدون dependency خارجية)
    │   ├── validation/validate.ts
    │   └── logger/logger.ts
    └── features/
        └── identity/         ← الموديول التأسيسي الكامل: users/roles/permissions/branches/ownerships/audit/sessions
            ├── routes/ controllers/ services/ repositories/ schemas/ dtos/
            └── (9 كيانات، كل واحد بملف schema+dto+repository+service منفصل — الـcontrollers/routes مجمّعة حسب الـresource)
```

## تسلسل الطلب (Request Lifecycle)

```
HTTP Request
  → cors()
  → express.json()
  → pinoHttp (logging)
  → requestContext        (يقرأ Accept-language → req.lang)
  → authStub              (يقرأ Bearer token — placeholder، لا يحجب)
  → [router المطابق للـpath]
      → validate(schema, source)   (zod — يرمي ValidationError عند الفشل)
      → asyncHandler(controller)   (يلف async controller، يمرر الأخطاء لـnext)
        → controller → service → repository → db (drizzle)
        → controller يبني الرد عبر ok()/created()
  → [لو مافيش route مطابق] notFound → 404 envelope
  → [لو صار أي throw بأي مرحلة] errorHandler (آخر middleware) → error envelope
```

## مبدأ الطبقات

- `core/` بنية تحتية عابرة — لا تعرف شيئاً عن أي feature محدد.
- `features/<name>/` معزولة عن بعضها بالكامل (لا استيراد متبادل).
- الاتجاه دائماً: `routes → controllers → services → repositories → db`، بدون قفزات.
