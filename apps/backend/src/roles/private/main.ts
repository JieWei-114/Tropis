import './role';
import '../../env-bootstrap';
import '../../tracing';
import { bootstrapRole } from '../shared/bootstrap';
import { rpcSurface } from '../shared/rpc.surface';
import { PrivateModule } from './private.module';

void bootstrapRole(PrivateModule, {
  surfaces: [rpcSurface({ internal: true })],
});
