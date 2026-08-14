# Argo CD — GitOps deployment visualization

Argo CD watches this repo and keeps the cluster in sync with `infra/k8s/`. What
you get on top of plain `kubectl apply -k`:

- **Per-service card** in the UI for backend/frontend: live **health**
  (Progressing / Healthy / Degraded), pod tree, events and logs.
- **Live vs git diff** — see exactly what drifted from the manifests in git.
- **Current image tag** at a glance (the tag CI pins via
  `kustomize edit set image`).
- **One-click rollback** to any of the last 10 synced revisions
  (`revisionHistoryLimit: 10`).
- **Self-heal + prune** — manual cluster edits are reverted; resources removed
  from git are deleted.

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

## Apply these manifests

1. Replace the placeholder repo URL `https://github.com/tropis/tropis.git`
   in `project.yaml`, `app-prod.yaml` (and `app-staging.yaml` / `app-dev.yaml`
   if used) with your actual repo. Private repos also need a repo credential
   (`argocd repo add ...` or a repo Secret).
2. Apply:

```bash
kubectl apply -f infra/argocd/project.yaml
kubectl apply -f infra/argocd/app-prod.yaml
# optional dev cluster app:
# kubectl apply -f infra/argocd/app-dev.yaml
```

Argo then syncs `infra/k8s/overlays/prod` into the `tropis` namespace
automatically. See the "GitOps with Argo CD" section in
[docs/deployment.md](../../docs/deployment.md) for how CI hands off deploys to
Argo by committing image-tag bumps instead of running `kubectl apply`.
