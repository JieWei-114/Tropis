import { defineKey } from '../../../common/keyspace';

export const MEMBERSHIP_GRAPH_SUBSCRIPTION = 'membership-graph-sub';

export const USER_LABEL = 'User';
export const TENANT_LABEL = 'Tenant';
export const MEMBER_OF = 'MEMBER_OF';
export const INVITED = 'INVITED';

/** Longest invitation chain a query may walk. */
export const MAX_INVITATION_HOPS = 10;
export const MAX_MEMBERS_PAGE = 500;

/** Consumer dedup per envelope id: global(eventId). */
export const MEMBERSHIP_GRAPH_EVENT_SEEN = defineKey({
  capability: 'dedup',
  module: 'membership-graph',
  name: 'event-seen',
  version: 'v1',
});
