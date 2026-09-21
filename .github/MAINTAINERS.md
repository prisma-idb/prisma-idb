# Maintainer guide

## Releasing `@prisma-idb/*`

Releases use [Changesets](https://github.com/changesets/changesets). The six core ORM packages are versioned in lockstep; the sync packages have independent versions.

1. **Author a changeset** (on any branch, or directly on `main`):

   ```bash
   pnpm changeset
   ```

   The prompt asks which packages changed and the bump level (`patch`/`minor`/`major`). Commit the generated `.changeset/<slug>.md` file.

2. **Merge to `main`.** The `release` workflow opens a **"chore: release packages"** PR that bumps versions, writes `CHANGELOG.md` entries (with PR links and contributor @-mentions), and deletes the changeset file.

3. **Merge the release PR.** The workflow re-runs, finds no pending changesets, and publishes the packages to npm through trusted publishing. npm generates provenance automatically.

### Dry-run

```bash
pnpm build --filter="./packages/prisma-orm/*"
pnpm --filter="./packages/prisma-orm/*" publish --dry-run
```

Verify only `dist/` is listed for each package — not `src/` or `test/`.

### npm trusted publisher setup (one-time, per package)

Publishing uses GitHub Actions OIDC — no stored npm token needed. Configure each package on npmjs.com once, after its first publish:

1. Go to the package page → **Settings** → **Trusted Publisher** → **GitHub Actions**
2. Fill in:
   - **Organization or user**: `prisma-idb`
   - **Repository**: `prisma-idb`
   - **Workflow filename**: `release.yml`
   - **Allowed actions**: allow `npm publish`
3. Save — repeat for every published package.

> **First publish**: trusted publisher config requires the package to already exist. Build the packages, run `npm login` locally, and publish each new package once with `pnpm --filter <package-name> publish --access public`. Then configure its trusted publisher before the next release.

Keep `id-token: write`, do not add `NPM_TOKEN` or `NODE_AUTH_TOKEN`, and keep the public repository URL in every published `package.json` synchronized with the GitHub repository name.

### Changeset PR enforcement

Two things block merging a `packages/prisma-orm/**` PR without a changeset:

- **[changeset-bot](https://github.com/apps/changeset-bot)** — install on the repo once. Posts a comment on every PR with changeset status and a direct link to create one.
- **`changeset-check.yml`** — runs `changeset status --since=origin/main` on PRs. Set **"Changeset required"** as a required status check in **Settings → Branches → main → Require status checks**.

## Releasing `packages/generator`

The generator uses Changesets, the same as the `@prisma-idb/*` packages.

1. **Author a changeset** (bump level reflects the nature of the change):

   ```bash
   pnpm changeset
   ```

2. **Merge to `main`.** The `release` workflow opens a release PR that bumps the version and writes a `CHANGELOG.md` entry.

3. **Merge the release PR.** The workflow re-runs and publishes to npm with provenance attestation.
