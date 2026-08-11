import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import cors, { type CorsOptions } from 'cors';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import { env } from './core/config/env.js';
import { pinoHttp } from 'pino-http';
import { logger } from './core/logger/logger.js';
import { requestContext } from './core/middleware/request-context.js';
import { auth } from './core/middleware/auth.js';
import { asyncHandler } from './core/http/async-handler.js';
import { notFound } from './core/middleware/not-found.js';
import { errorHandler } from './core/middleware/error-handler.js';
import { buildOpenApiDocument } from './core/openapi/document.js';
import { configureAuth } from './core/auth/composition.js';
import { qirtasAccountStore } from './features/identity/repositories/account-store.impl.js';
import { auditLogSecurityEventSink } from './features/identity/repositories/security-event-sink.impl.js';
import { authRouter } from './features/auth/routes/auth.routes.js';
import { usersRouter } from './features/identity/routes/users.routes.js';
import { rolesRouter } from './features/identity/routes/roles.routes.js';
import { permissionsRouter } from './features/identity/routes/permissions.routes.js';
import { branchesRouter } from './features/identity/routes/branches.routes.js';
import { dashboardRouter } from './features/dashboard/routes/dashboard.routes.js';
import { ownershipsRouter } from './features/identity/routes/ownerships.routes.js';
import { roleAssignmentsRouter } from './features/identity/routes/user-role-assignments.routes.js';
import { auditLogRouter } from './features/identity/routes/audit-log.routes.js';
import { languagesRouter } from './features/localization/routes/languages.routes.js';

/**
 * Browser origins allowed to call this API, from `ALLOWED_ORIGINS`.
 *
 * An empty list denies every cross-origin browser request rather than allowing
 * all of them — the previous `cors()` with no options sent
 * `Access-Control-Allow-Origin: *` to anyone. The mobile client is unaffected
 * either way: CORS is enforced by browsers, and native HTTP clients ignore it.
 * So the open policy protected nothing while leaving a hole for the first web
 * build (production_readiness.md §A3).
 *
 * Requests with no `Origin` header — the mobile app, curl, server-to-server —
 * are allowed through: they are not cross-origin browser traffic, and rejecting
 * them would break every non-browser caller for no security gain.
 */
function corsOptions(): CorsOptions {
  const allowed = env.ALLOWED_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);

  return {
    origin(origin, callback) {
      if (origin === undefined || allowed.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    credentials: true,
  };
}

export function buildApp(): Express {
  const app = express();

  // Before any middleware, because `core/middleware/auth.ts` resolves every
  // request through the account store — an unconfigured engine would fail on
  // the first request rather than at boot, which is the harder failure to
  // diagnose. This is the ONE place the reusable authentication engine is bound
  // to Qirtas's implementations; the complete list of what an application must
  // supply is these three lines.
  configureAuth({
    accountStore: qirtasAccountStore,
    securityEventSink: auditLogSecurityEventSink,
  });

  app.use(helmet());
  app.use(cors(corsOptions()));
  app.use(express.json());
  app.use(pinoHttp({ logger }));
  app.use(requestContext);
  app.use(asyncHandler(auth));
app.get('/', (_req, res) => {
  res.json({
    message: 'Qirtas API 🚀',
    docs: '/docs',
    health: '/health',
  });
});

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: true, message: 'OK', data: { uptime: process.uptime() } });
  });

  const openApiDocument = buildOpenApiDocument();
  app.get('/openapi.json', (_req, res) => {
    res.status(200).json(openApiDocument);
  });
  // Swagger UI ships inline scripts, which helmet's default
  // Content-Security-Policy (`script-src 'self'`) blocks — the page would load
  // and then render blank.
  //
  // The header must be REMOVED, not re-configured: the global helmet above has
  // already set it on this response, and mounting a second
  // `helmet({contentSecurityPolicy: false})` here only skips setting it again,
  // leaving the original in place (verified — the header survived).
  //
  // Scoped to this route only; the API keeps the full policy.
  app.use(
    '/docs',
    (_req: Request, res: Response, next: NextFunction) => {
      res.removeHeader('Content-Security-Policy');
      next();
    },
    swaggerUi.serve,
    swaggerUi.setup(openApiDocument),
  );

  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/users', usersRouter);
  app.use('/api/v1/roles', rolesRouter);
  app.use('/api/v1/permissions', permissionsRouter);
  app.use('/api/v1/branches', branchesRouter);
  app.use('/api/v1/dashboard', dashboardRouter);
  app.use('/api/v1/ownerships', ownershipsRouter);
  app.use('/api/v1/role-assignments', roleAssignmentsRouter);
  app.use('/api/v1/audit-log', auditLogRouter);
  app.use('/api/v1/languages', languagesRouter);

  // Must be registered last, in this order.
  app.use(notFound);
  app.use(errorHandler);

  return app;
}
