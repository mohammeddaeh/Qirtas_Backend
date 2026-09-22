import { OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';
import { registry } from './registry.js';

// Side-effect imports — each file calls registry.registerPath(...) on load.
// Add a new line here whenever a new feature's *.openapi.ts file is created.
import '../data-transfer/data-transfer.openapi.js';
import '../../features/auth/auth.openapi.js';
import '../../features/identity/users.openapi.js';
import '../../features/identity/roles.openapi.js';
import '../../features/identity/permissions.openapi.js';
import '../../features/identity/branches.openapi.js';
import '../../features/dashboard/dashboard.openapi.js';
import '../../features/identity/ownerships.openapi.js';
import '../../features/identity/user-role-assignments.openapi.js';
import '../../features/identity/audit-log.openapi.js';
import '../../features/localization/languages.openapi.js';
import '../media/media.openapi.js';
import '../../features/catalog/catalog.openapi.js';

export function buildOpenApiDocument() {
  const generator = new OpenApiGeneratorV3(registry.definitions);
  return generator.generateDocument({
    openapi: '3.0.0',
    info: {
      title: 'Qirtas_App',
      version: '1.0.0',
      description:
        'Auto-generated from the same zod schemas used by the runtime validate() middleware — always in sync with the actual request/response contract. See CLAUDE.md and docs/rest_api.md for the full architectural context.',
    },
    servers: [{ url: '/', description: 'Current server' }],
  });
}
