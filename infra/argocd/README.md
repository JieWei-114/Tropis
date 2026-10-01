# Argo CD

Install and UI access for Argo CD. Applying these manifests, what each
Application tracks, the one-deploy-path rule and rollback under Argo are in
[docs/deployment.md](../../docs/deployment.md#gitops-with-argo-cd).

## Install

Official install manifest into the `argocd` namespace:

```bash
kubectl create namespace argocd
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
```

Or via Helm:

```bash
helm repo add argo https://argoproj.github.io/argo-helm
helm install argocd argo/argo-cd -n argocd --create-namespace
```

## Access the UI

```bash
kubectl port-forward svc/argocd-server -n argocd 8080:443
# → https://localhost:8080  (self-signed cert — accept the warning)

# Initial admin password (username: admin)
kubectl -n argocd get secret argocd-initial-admin-secret \
  -o jsonpath='{.data.password}' | base64 -d; echo
```

Change the password and delete `argocd-initial-admin-secret` afterwards.
