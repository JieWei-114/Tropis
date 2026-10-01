import './role';
import '../../env-bootstrap';
import '../../tracing';
import { bootstrapRole } from '../shared/bootstrap';
import { WorkerModule } from './worker.module';

void bootstrapRole(WorkerModule);
