# Releasing

Every IPC gets the package of a GitHub release, so each installed version can be traced to a tag, a passed CI run and a release page. Never copy a locally built zip (`dist/`, from `pnpm package`) to an IPC: its version carries a commit suffix (`0.1.0+aa29151`, `.dirty` with uncommitted changes) and no CI run vouches for it. The decision is in [ADR 0004](adr/0004-deploy-as-self-contained-windows-service.md).

1. Merge the changes into `main`. With a new `Syn_Visu` version, its `.library` and `.compiled-library` are in `plc/library/` (the package takes the newest compiled one).
2. Set the release version in the root `package.json` (`"version": "X.Y.Z"`) and commit it to `main`.
3. Tag and push:

   ```powershell
   git tag -a vX.Y.Z -m "vX.Y.Z: <what changed>"
   git push origin main vX.Y.Z
   ```

4. Wait for the Release workflow (`gh run watch` or the Actions tab). It typechecks, tests, builds `rpp-visualisation-X.Y.Z-win-x64.zip` and attaches it to the release only when everything passes.
5. Download the zip from `https://github.com/janwillner/RPP_Visualisation/releases/tag/vX.Y.Z` or with `gh release download vX.Y.Z -R janwillner/RPP_Visualisation`, and install it as in [deployment.md](deployment.md).

A new protocol version needs the gateway release and the `Syn_Visu` version in the PLC to change together: download the PLC project first, then install the release.
