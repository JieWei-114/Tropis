package system.authz_test

import rego.v1

import data.system.authz

runtime := {"env": {"OPA_TOKEN": "s3cret"}}

test_token_admits_any_request if {
	authz.allow with input as {"method": "POST", "path": ["v1", "data", "authz", "allow"], "identity": "s3cret"}
		with opa.runtime as runtime
	authz.allow with input as {"method": "PUT", "path": ["v1", "policies", "authz"], "identity": "s3cret"}
		with opa.runtime as runtime
	authz.allow with input as {"method": "GET", "path": ["health"], "identity": "s3cret"}
		with opa.runtime as runtime
}

test_probe_needs_no_token if {
	authz.allow with input as {"method": "GET", "path": ["health"]}
		with opa.runtime as runtime
}

test_wrong_token_is_denied if {
	not authz.allow with input as {"method": "POST", "path": ["v1", "data", "authz", "allow"], "identity": "guess"}
		with opa.runtime as runtime
	not authz.allow with input as {"method": "GET", "path": ["health"], "identity": "guess"}
		with opa.runtime as runtime
}

test_missing_token_only_reaches_the_probe if {
	not authz.allow with input as {"method": "POST", "path": ["v1", "data", "authz", "allow"]}
		with opa.runtime as runtime
	not authz.allow with input as {"method": "GET", "path": ["v1", "policies"]}
		with opa.runtime as runtime
}

test_unset_server_token_admits_nothing_but_the_probe if {
	not authz.allow with input as {"method": "POST", "path": ["v1", "data", "authz", "allow"], "identity": ""}
		with opa.runtime as {"env": {}}
	authz.allow with input as {"method": "GET", "path": ["health"]}
		with opa.runtime as {"env": {}}
}
