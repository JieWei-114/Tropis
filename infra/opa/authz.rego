package authz

import rego.v1

# ── Role hierarchy ─────────────────────────────────────────────────────────
# admin  → can do everything
# editor → can read and write, cannot create, delete or manage users
# viewer → can only read
# member → its own account only; the role every self-registered user gets
#
# Self sign-up is public (where the tenant allows it), so the role it grants
# holds nothing tenant-wide: no analytics or tracking data, no enumeration.
# An admin grants editor or viewer. `create` is admin-only: anyone else
# creates an account only through self sign-up, under its limits. `read` and `list` are distinct on `user`:
# `list` (FindAll / Search / FindSimilar) is admin-only; `read` and `update`
# are single records and the controller additionally requires owner-or-admin.
role_permissions := {
  "admin": {
    "user":      {"create", "read", "list", "update", "delete", "manage_roles"},
    "analytics": {"read", "write"},
  },
  "editor": {
    "user":      {"read", "update"},
    "analytics": {"read", "write"},
  },
  "viewer": {
    "user":      {"read"},
    "analytics": {"read"},
  },
  "member": {
    "user":      {"read", "update"},
  },
}

# ── Main allow rule ────────────────────────────────────────────────────────
# input.roles    — the caller's current roles (e.g. ["editor"])
# input.resource — the resource being accessed (e.g. "user")
# input.action   — the action being performed (e.g. "delete")

default allow := false

allow if {
  some role in input.roles
  some action in role_permissions[role][input.resource]
  action == input.action
}

# ── Introspection: which actions can these roles perform on a resource? ────
# Not consulted by the application, which always asks the specific question
# via `allow`. This exists for operators reasoning about the policy:
#   curl -s -X POST localhost:8181/v1/data/authz/allowed_actions \
#     -d '{"input":{"roles":["editor"],"resource":"user"}}'
allowed_actions contains action if {
  some role in input.roles
  some action in role_permissions[role][input.resource]
}
