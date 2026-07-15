import express, { type Express } from 'express';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import { pinoHttp } from 'pino-http';
import { logger } from './core/logger/logger.js';
import { requestContext } from './core/middleware/request-context.js';
import { authStub } from './core/middleware/auth.stub.js';
import { notFound } from './core/middleware/not-found.js';
import { errorHandler } from './core/middleware/error-handler.js';
import { buildOpenApiDocument } from './core/openapi/document.js';
import { usersRouter } from './features/identity/routes/users.routes.js';
import { rolesRouter } from './features/identity/routes/roles.routes.js';
import { permissionsRouter } from './features/identity/routes/permissions.routes.js';
import { branchesRouter } from './features/identity/routes/branches.routes.js';
import { ownershipsRouter } from './features/identity/routes/ownerships.routes.js';
import { roleAssignmentsRouter } from './features/identity/routes/user-role-assignments.routes.js';
import { auditLogRouter } from './features/identity/routes/audit-log.routes.js';

export function buildApp(): Express {
  const app = express();

  app.use(cors());
  app.use(express.json());
  app.use(pinoHttp({ logger }));
  app.use(requestContext);
  app.use(authStub);

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: true, message: 'OK', data: { uptime: process.uptime() } });
  });

  const openApiDocument = buildOpenApiDocument();
  app.get('/openapi.json', (_req, res) => {
    res.status(200).json(openApiDocument);
  });
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiDocument));

  app.use('/api/v1/users', usersRouter);
  app.use('/api/v1/roles', rolesRouter);
  app.use('/api/v1/permissions', permissionsRouter);
  app.use('/api/v1/branches', branchesRouter);
  app.use('/api/v1/ownerships', ownershipsRouter);
  app.use('/api/v1/role-assignments', roleAssignmentsRouter);
  app.use('/api/v1/audit-log', auditLogRouter);

  // Must be registered last, in this order.
  app.use(notFound);
  app.use(errorHandler);

  return app;
}
