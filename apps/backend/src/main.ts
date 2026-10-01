import './roles/all/role';
import './env-bootstrap';
import './tracing';
import { AppModule } from './app.module';
import { bootstrapRole } from './roles/shared/bootstrap';
import { createHttpApp, httpSurface } from './roles/shared/http.surface';
import { rpcSurface } from './roles/shared/rpc.surface';

void bootstrapRole(AppModule, {
  create: createHttpApp,
  surfaces: [httpSurface, rpcSurface({ public: true, internal: true })],
});
