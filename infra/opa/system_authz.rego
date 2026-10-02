package system.authz

import rego.v1

# Decides every OPA API request under --authorization=basic. The token is
# read from OPA's own OPA_TOKEN environment variable, never from a file.

default allow := false

configured_token := object.get(opa.runtime(), ["env", "OPA_TOKEN"], "")

allow if {
	input.method == "GET"
	input.path == ["health"]
	not input.identity
}

allow if {
	configured_token != ""
	input.identity == configured_token
}
