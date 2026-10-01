package authz_test

import rego.v1

import data.authz

test_member_has_no_analytics if {
  not authz.allow with input as {"roles": ["member"], "resource": "analytics", "action": "read"}
  not authz.allow with input as {"roles": ["member"], "resource": "analytics", "action": "write"}
}

test_member_cannot_enumerate_users if {
  not authz.allow with input as {"roles": ["member"], "resource": "user", "action": "list"}
  not authz.allow with input as {"roles": ["member"], "resource": "user", "action": "create"}
}

test_member_manages_own_record if {
  authz.allow with input as {"roles": ["member"], "resource": "user", "action": "read"}
  authz.allow with input as {"roles": ["member"], "resource": "user", "action": "update"}
}

test_editor_keeps_analytics if {
  authz.allow with input as {"roles": ["editor"], "resource": "analytics", "action": "write"}
}

test_only_admin_manages_roles if {
  authz.allow with input as {"roles": ["admin"], "resource": "user", "action": "manage_roles"}
  not authz.allow with input as {"roles": ["editor"], "resource": "user", "action": "manage_roles"}
}

test_only_admin_creates_users if {
  authz.allow with input as {"roles": ["admin"], "resource": "user", "action": "create"}
  not authz.allow with input as {"roles": ["editor"], "resource": "user", "action": "create"}
  not authz.allow with input as {"roles": ["viewer"], "resource": "user", "action": "create"}
}
