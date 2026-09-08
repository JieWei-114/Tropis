package authz

import rego.v1

# ── Role hierarchy ─────────────────────────────────────────────────────────
# admin  → can do everything
# editor → can read and write, cannot delete or manage users
# viewer → can only read
#
# `read` and `list` are deliberately distinct on `user`. Registration is public
# and self-registered accounts default to `editor`, so granting enumeration
# under `read` meant one free signup could dump every user's email. `list`
# (FindAll / Search / FindSimilar) is admin-only; `read` is a single record and
# the controller additionally requires owner-or-admin.
role_permissions := {
  "admin": {
    "user":      {"create", "read", "list", "update", "delete", "manage_roles"},
    "analytics": {"read", "write"},
  },
  "editor": {
    "user":      {"create", "read", "update"},
    "analytics": {"read", "write"},
  },
  "viewer": {
    "user":      {"read"},
    "analytics": {"read"},
  },
}

# ── Main allow rule ────────────────────────────────────────────────────────
# input.roles    — array of roles from JWT (e.g. ["editor"])
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
