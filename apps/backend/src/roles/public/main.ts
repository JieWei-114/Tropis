import './role';
import '../../env-bootstrap';
import '../../tracing';
import { bootstrapRole } from '../shared/bootstrap';
import { createHttpApp, httpSurface } from '../shared/http.surface';
import { rpcSurface } from '../shared/rpc.surface';
import { PublicModule } from './public.module';

void bootstrapRole(PublicModule, {
  create: createHttpApp,
  surfaces: [httpSurface, rpcSurface({ public: true })],
});
