# npm publishing

The public npm package is `deepinfra-fusion-proxy`. In npm package Settings, configure Trusted Publisher: GitHub Actions, owner `citydirector`, repository `deepinfra-fusion-proxy`, workflow `release.yml`, no environment. Allow direct publishing. No NPM_TOKEN secret is needed.

First publication requires the owner's npm CLI web login. After bootstrap, changes to package.json on main (bump version first), a vX.Y.Z tag, or workflow_dispatch run tests and publish using GitHub OIDC with provenance. Existing versions are skipped; registry failures stop the job. Stable versions only; tags must equal package.json. Commit package-lock.json with every dependency change.

Validate with `npm ci --ignore-scripts --legacy-peer-deps`, `npm test` and `npm pack --dry-run`. DSH users install the npm name, so the built-in plugin manager can list and apply compatible updates. Git dependencies must be reinstalled from npm once.
