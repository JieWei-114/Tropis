FROM openpolicyagent/opa:1.21.0
COPY --chown=1000:1000 infra/opa/authz.rego infra/opa/system_authz.rego /policies/
USER 1000:1000
EXPOSE 8181
ENTRYPOINT ["/opa"]
CMD ["run", "--server", "--addr", "0.0.0.0:8181", "--authentication=token", "--authorization=basic", "--log-format=json", "--log-level=info", "/policies"]
