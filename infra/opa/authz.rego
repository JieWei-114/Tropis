package authz

import rego.v1

# ── Role hierarchy ─────────────────────────────────────────────────────────
# admin  → can do everything
# editor → can read and write, cannot delete or manage users
# viewer → can only read

role_permissions := {
  "admin": {
    "user":      {"create", "read", "update", "delete", "manage_roles"},
    "analytics": {"read"},
  },
  "editor": {
    "user":      {"create", "read", "update"},
    "analytics": {"read"},
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

# ── Convenience: which actions can the caller perform? ────────────────────
allowed_actions contains action if {
  some role in input.roles
  some action in role_permissions[role][input.resource]
}
