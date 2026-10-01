import './role';
import '../../env-bootstrap';
import '../../tracing';
import { bootstrapRole } from '../shared/bootstrap';
import { SchedulerModule } from './scheduler.module';

void bootstrapRole(SchedulerModule);
